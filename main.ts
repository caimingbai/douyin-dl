// 抖音无水印视频下载服务（部署到 Deno Deploy）
// 作用：输入抖音分享链接 -> 解析出无水印直链 -> 服务端代理下载 -> 把 mp4 二进制回传给调用方
// 为什么需要代理下载：调用方（WorkBuddy 沙箱）直连抖音 CDN 被 403，但 Deno 服务端（国际网络）能正常下载，故由服务端中转
//
// 部署（Deno Deploy）：
//   1. 打开 https://deno.com/deploy ，用 GitHub 登录（你的 GitHub 浏览器可访问）
//   2. New Project -> 选 "Playground" 或空项目
//   3. 把本文件内容粘贴进 main.ts（覆盖默认内容）
//   4. Deploy，拿到形如 https://xxxx.deno.dev 的地址
//
// 调用方式：
//   视频二进制(直接下载) : https://xxxx.deno.dev/?url=<抖音分享链接>
//   JSON 信息          : https://xxxx.deno.dev/?data&url=<抖音分享链接>

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const REF = "https://www.douyin.com/";

function extractAwemeId(text: string): string | null {
  const m =
    text.match(/[?&]aweme_id=(\d+)/) ||
    text.match(/\/video\/(\d+)/) ||
    text.match(/item_id=(\d+)/) ||
    text.match(/"awemeId"?\s*[:=]\s*"?(\d+)/) ||
    text.match(/\\"awemeId\\":\s*(\d+)/);
  return m ? m[1] : null;
}

// 策略1：分享短链跟随重定向，从最终 URL / HTML 提取 aweme_id
async function resolveShare(shareUrl: string): Promise<string> {
  const res = await fetch(shareUrl, {
    headers: { "User-Agent": UA, "Referer": REF },
    redirect: "follow",
  });
  const finalUrl = res.url;
  let id = extractAwemeId(finalUrl);
  if (!id) {
    const html = await res.text();
    id = extractAwemeId(html) || extractAwemeId(finalUrl + html);
  }
  if (!id) throw new Error("无法从分享链接提取 aweme_id");
  return id;
}

// 策略2：调公开详情接口拿视频直链
async function fetchDetail(awemeId: string): Promise<any> {
  const endpoints = [
    `https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=${awemeId}`,
    `https://www.iesdouyin.com/aweme/v1/web/aweme/detail/?aweme_id=${awemeId}&device_id=1&channel=channel_pc_web&pc_client_type=1&version_code=190500&version_name=19.5.0&cookie_enabled=true`,
  ];
  let lastErr = "";
  for (const api of endpoints) {
    try {
      const res = await fetch(api, {
        headers: { "User-Agent": UA, "Referer": REF, "Accept": "application/json" },
      });
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
        continue;
      }
      const json = await res.json();
      const item = json.item_list?.[0] || json.aweme_detail;
      if (item) return item;
      lastErr = "接口返回但未包含 item";
    } catch (e: any) {
      lastErr = e.message;
    }
  }
  throw new Error("详情接口失败: " + lastErr);
}

function pickVideoUrl(item: any): string | null {
  let vurl: string | null = null;
  const vl = item?.video?.play_addr?.url_list;
  if (vl && vl.length) vurl = vl[0].replace("playwm", "play");
  if (!vurl && item?.video?.bit_rate?.length) {
    vurl = item.video.bit_rate[0]?.play_addr?.url_list?.[0]?.replace("playwm", "play");
  }
  return vurl;
}

async function resolve(target: string): Promise<{
  aweme_id: string;
  video_url: string | null;
  desc: string | null;
  nickname: string | null;
  digg_count: any;
}> {
  let id = extractAwemeId(target);
  if (!id) id = await resolveShare(target);
  const item = await fetchDetail(id);
  return {
    aweme_id: id,
    video_url: pickVideoUrl(item),
    desc: item?.desc ?? null,
    nickname: item?.author?.nickname ?? null,
    digg_count: item?.statistics?.digg_count ?? null,
  };
}

Deno.serve(async (req: Request) => {
  const u = new URL(req.url);
  const target = u.searchParams.get("url");
  const wantData = u.searchParams.has("data");

  if (!target) {
    return new Response(
      "用法: ?url=<抖音分享链接>  或  ?data&url=<抖音分享链接>",
      { status: 400 },
    );
  }

  try {
    const info = await resolve(target);
    if (wantData) return Response.json(info);
    if (!info.video_url) {
      return new Response("解析成功但未拿到视频直链", { status: 502 });
    }
    // 服务端代理下载，绕开调用方对抖音 CDN 的访问限制
    const vr = await fetch(info.video_url, {
      headers: { "User-Agent": UA, "Referer": REF },
    });
    if (!vr.ok) {
      return new Response("下载直链失败 HTTP " + vr.status, { status: 502 });
    }
    const buf = await vr.arrayBuffer();
    return new Response(buf, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(buf.byteLength),
        "Content-Disposition": `attachment; filename="${info.aweme_id}.mp4"`,
      },
    });
  } catch (e: any) {
    return new Response("ERROR: " + (e?.message || e), { status: 500 });
  }
});
