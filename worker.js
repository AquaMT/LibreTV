const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/120.0.0.0 Safari/537.36";

const MEDIA_FILE_EXTENSIONS = [
  ".mp4", ".webm", ".mkv", ".avi", ".mov", ".wmv", ".flv",
  ".f4v", ".m4v", ".3gp", ".3g2", ".ts", ".mts", ".m2ts",
  ".mp3", ".wav", ".ogg", ".aac", ".m4a", ".flac", ".wma",
  ".alac", ".aiff", ".opus",
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff",
  ".svg", ".avif", ".heic"
];

const MEDIA_CONTENT_TYPES = ["video/", "audio/", "image/"];

/**
 * Cloudflare Worker
 *
 * LibreTV:
 *   /proxy/*      -> 视频/API代理
 *   其它请求      -> Static Assets
 *
 * 同时替代原来的：
 *   functions/_middleware.js
 *   functions/proxy/[[path]].js
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    /*
     * /proxy/*
     */
    if (url.pathname.startsWith("/proxy/")) {
      return handleProxy(request, env, ctx);
    }

    /*
     * OPTIONS
     */
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    /*
     * Static Assets
     *
     * 原 Pages middleware 会给 HTML 注入 PASSWORD hash。
     */
    return handleStaticAsset(request, env);
  }
};


/* =========================================================
 * Static Assets / Pages Middleware replacement
 * ======================================================= */

async function handleStaticAsset(request, env) {
    let response = await env.ASSETS.fetch(request);

    // /player 需要明确映射到 player.html
    const url = new URL(request.url);

    if (url.pathname === "/player") {
        const playerUrl = new URL("/player.html", request.url);
        response = await env.ASSETS.fetch(
            new Request(playerUrl.toString(), request)
        );
    }

    const contentType = response.headers.get("content-type") || "";

    if (!contentType.toLowerCase().includes("text/html")) {
        return response;
    }

    const password = env.PASSWORD || "";

    let passwordHash = "";

    if (password) {
        passwordHash = await sha256(password);
    }

    let html = await response.text();

    html = html.replace(
        'window.__ENV__.PASSWORD = "{{PASSWORD}}";',
        `window.__ENV__.PASSWORD = "${passwordHash}";`
    );

    const headers = new Headers(response.headers);
    headers.delete("Content-Length");

    return new Response(html, {
        status: response.status,
        statusText: response.statusText,
        headers
    });
}

/* =========================================================
 * Proxy
 * ======================================================= */

async function handleProxy(request, env, ctx) {
  const url = new URL(request.url);

  const config = getConfig(env);

  /*
   * CORS preflight
   */
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders()
    });
  }

  /*
   * LibreTV 原来的鉴权方式：
   *
   * auth = SHA256(PASSWORD)
   * t    = 时间戳
   */
  const validAuth = await validateAuth(request, env);

  if (!validAuth) {
    return jsonResponse(
      {
        success: false,
        error: "代理访问未授权：请检查密码配置或鉴权参数"
      },
      401
    );
  }

  const targetUrl = getTargetUrlFromPath(url.pathname);

  if (!targetUrl) {
    return textResponse(
      "无效的代理请求。路径应为 /proxy/<经过编码的URL>",
      400
    );
  }

  debug(config, `收到代理请求: ${targetUrl}`);

  /*
   * 请求 HEAD / GET / POST 等。
   */
  try {
    return await proxyTarget(
      request,
      targetUrl,
      env,
      ctx,
      config,
      0
    );
  } catch (error) {
    console.error("[LibreTV Worker]", error);

    return textResponse(
      `代理处理错误: ${error?.message || error}`,
      500
    );
  }
}


/* =========================================================
 * Proxy main logic
 * ======================================================= */

async function proxyTarget(
  request,
  targetUrl,
  env,
  ctx,
  config,
  recursionDepth
) {
  /*
   * 防止无限递归。
   */
  if (recursionDepth > config.MAX_RECURSION) {
    throw new Error(
      `处理 M3U8 时递归层数过多 (${config.MAX_RECURSION})`
    );
  }

  /*
   * KV
   */
  const kv = env.LIBRETV_PROXY_KV || null;

  /*
   * 原始内容缓存。
   *
   * 注意：
   * 新版本只缓存文本内容，
   * 不把 .ts / .mp4 / 图片等二进制媒体塞进 KV。
   */
  const cacheKey = `proxy_raw:${targetUrl}`;

  if (kv) {
    try {
      const cached = await kv.get(cacheKey);

      if (cached) {
        const parsed = JSON.parse(cached);

        const content = parsed.body || "";
        const headers = parsed.headers || {};
        const contentType =
          headers["content-type"] ||
          headers["Content-Type"] ||
          "";

        debug(config, `[KV命中] ${targetUrl}`);

        /*
         * M3U8 每次重新处理，
         * 确保里面的 URL 都被代理。
         */
        if (isM3u8Content(content, contentType)) {
          const processed = await processM3u8Content(
            targetUrl,
            content,
            env,
            ctx,
            config,
            recursionDepth
          );

          return createM3u8Response(
            processed,
            config.CACHE_TTL
          );
        }

        return createResponse(
          content,
          200,
          new Headers(headers)
        );
      }
    } catch (error) {
      debug(
        config,
        `[KV读取失败] ${cacheKey}: ${error.message}`
      );
    }
  }

  /*
   * 请求上游。
   */
  const upstream = await fetchUpstream(
    request,
    targetUrl,
    config
  );

  const contentType =
    upstream.headers.get("content-type") || "";

  /*
   * M3U8：
   *
   * 必须读取文本并重写 URL。
   */
  if (isM3u8Response(upstream)) {
    const content = await upstream.text();

    /*
     * M3U8 原始内容可以缓存。
     */
    if (kv) {
      await cacheText(
        kv,
        cacheKey,
        content,
        upstream.headers,
        config.CACHE_TTL,
        ctx,
        config
      );
    }

    const processed = await processM3u8Content(
      targetUrl,
      content,
      env,
      ctx,
      config,
      recursionDepth
    );

    return createM3u8Response(
      processed,
      config.CACHE_TTL
    );
  }

  /*
   * 判断是否是媒体文件。
   *
   * 这部分非常重要。
   *
   * 原 Pages Function 会 response.text()，
   * 对 .ts / .mp4 等二进制内容并不理想。
   *
   * Workers 版本直接流式返回 response.body。
   */
  if (isMediaFile(targetUrl, contentType)) {
    debug(config, `[流式媒体] ${targetUrl}`);

    return createStreamingResponse(
      upstream,
      config.CACHE_TTL
    );
  }

  /*
   * 非 M3U8 的文本内容：
   *
   * 例如 CMS API JSON、HTML 等。
   */
  const content = await upstream.text();

  if (kv && isCacheableText(contentType)) {
    await cacheText(
      kv,
      cacheKey,
      content,
      upstream.headers,
      config.CACHE_TTL,
      ctx,
      config
    );
  }

  return createResponse(
    content,
    200,
    upstream.headers
  );
}


/* =========================================================
 * Upstream fetch
 * ======================================================= */

async function fetchUpstream(
  request,
  targetUrl,
  config
) {
  const headers = new Headers();

  headers.set(
    "User-Agent",
    getRandomUserAgent(config.USER_AGENTS)
  );

  headers.set("Accept", "*/*");

  headers.set(
    "Accept-Language",
    request.headers.get("Accept-Language") ||
      "zh-CN,zh;q=0.9,en;q=0.8"
  );

  /*
   * 原 LibreTV 逻辑：
   *
   * 优先使用客户端 Referer，
   * 没有的话使用目标网站 origin。
   */
  try {
    headers.set(
      "Referer",
      request.headers.get("Referer") ||
        new URL(targetUrl).origin + "/"
    );
  } catch {
    // ignore
  }

  /*
   * Range 对视频播放非常重要。
   */
  const range = request.headers.get("Range");

  if (range) {
    headers.set("Range", range);
  }


  const response = await fetch(targetUrl, {
    method: request.method,
    headers,
    redirect: "follow"
  });

  if (!response.ok) {
    let body = "";

    try {
      body = await response.text();
    } catch {
      // ignore
    }

    throw new Error(
      `HTTP ${response.status} ${response.statusText}` +
      ` - ${targetUrl}` +
      (body ? ` - ${body.substring(0, 150)}` : "")
    );
  }

  return response;
}


/* =========================================================
 * M3U8
 * ======================================================= */

async function processM3u8Content(
  targetUrl,
  content,
  env,
  ctx,
  config,
  recursionDepth
) {
  /*
   * Master playlist
   */
  if (
    content.includes("#EXT-X-STREAM-INF") ||
    content.includes("#EXT-X-MEDIA:")
  ) {
    return processMasterPlaylist(
      targetUrl,
      content,
      env,
      ctx,
      config,
      recursionDepth
    );
  }

  /*
   * Media playlist
   */
  return processMediaPlaylist(
    targetUrl,
    content,
    config
  );
}


/*
 * Master playlist
 *
 * 保留原 LibreTV 的行为：
 * 自动选择最高 BANDWIDTH 的子 M3U8。
 */
async function processMasterPlaylist(
  url,
  content,
  env,
  ctx,
  config,
  recursionDepth
) {
  if (recursionDepth > config.MAX_RECURSION) {
    throw new Error(
      `处理主列表时递归层数过多 (${config.MAX_RECURSION}): ${url}`
    );
  }

  const baseUrl = getBaseUrl(url);
  const lines = content.split(/\r?\n/);

  let highestBandwidth = -1;
  let bestVariantUrl = "";

  for (let i = 0; i < lines.length; i++) {
    const currentLine = lines[i].trim();

    if (!currentLine.startsWith("#EXT-X-STREAM-INF")) {
      continue;
    }

    const bandwidthMatch =
      currentLine.match(/BANDWIDTH=(\d+)/);

    const bandwidth = bandwidthMatch
      ? parseInt(bandwidthMatch[1], 10)
      : 0;

    let variantUri = "";

    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j].trim();

      if (!line || line.startsWith("#")) {
        continue;
      }

      variantUri = line;
      i = j;
      break;
    }

    if (
      variantUri &&
      bandwidth >= highestBandwidth
    ) {
      highestBandwidth = bandwidth;

      bestVariantUrl = resolveUrl(
        baseUrl,
        variantUri
      );
    }
  }

  /*
   * 兼容没有 BANDWIDTH 的 M3U8。
   */
  if (!bestVariantUrl) {
    for (const lineRaw of lines) {
      const line = lineRaw.trim();

      if (
        line &&
        !line.startsWith("#") &&
        (
          line.endsWith(".m3u8") ||
          line.includes(".m3u8?")
        )
      ) {
        bestVariantUrl = resolveUrl(
          baseUrl,
          line
        );

        break;
      }
    }
  }

  /*
   * 没有子列表。
   */
  if (!bestVariantUrl) {
    return processMediaPlaylist(
      url,
      content,
      config
    );
  }

  debug(
    config,
    `选择最高码率 M3U8 (${highestBandwidth}): ${bestVariantUrl}`
  );

  /*
   * KV 缓存子 M3U8。
   */
  const kv = env.LIBRETV_PROXY_KV || null;

  const cacheKey =
    `m3u8_processed:${bestVariantUrl}`;

  if (kv) {
    try {
      const cached = await kv.get(cacheKey);

      if (cached) {
        debug(
          config,
          `[KV命中] 子M3U8: ${bestVariantUrl}`
        );

        return cached;
      }
    } catch (error) {
      debug(
        config,
        `[KV读取失败] ${error.message}`
      );
    }
  }

  /*
   * 获取子 M3U8。
   */
  const response = await fetchUpstream(
    new Request(url),
    bestVariantUrl,
    config
  );

  const variantContentType =
    response.headers.get("content-type") || "";

  const variantContent =
    await response.text();

  /*
   * 如果子 URL 并不是 M3U8，
   * 按媒体 playlist 尝试处理。
   */
  if (
    !isM3u8Content(
      variantContent,
      variantContentType
    )
  ) {
    return processMediaPlaylist(
      bestVariantUrl,
      variantContent,
      config
    );
  }

  const processed =
    await processM3u8Content(
      bestVariantUrl,
      variantContent,
      env,
      ctx,
      config,
      recursionDepth + 1
    );

  /*
   * 写 KV。
   */
  if (kv) {
    try {
      ctx.waitUntil(
        kv.put(
          cacheKey,
          processed,
          {
            expirationTtl:
              config.CACHE_TTL
          }
        )
      );
    } catch (error) {
      debug(
        config,
        `[KV写入失败] ${error.message}`
      );
    }
  }

  return processed;
}


/*
 * Media playlist
 */
function processMediaPlaylist(
  url,
  content,
  config
) {
  const baseUrl = getBaseUrl(url);

  const lines = content.split(/\r?\n/);
  const output = [];

  for (let i = 0; i < lines.length; i++) {
    const originalLine = lines[i];

    const line = originalLine.trim();

    /*
     * 保留最后一个空行。
     */
    if (!line) {
      if (i === lines.length - 1) {
        output.push("");
      }

      continue;
    }

    /*
     * EXT-X-KEY
     */
    if (line.startsWith("#EXT-X-KEY")) {
      output.push(
        processUriTag(
          line,
          baseUrl
        )
      );

      continue;
    }

    /*
     * EXT-X-MAP
     */
    if (line.startsWith("#EXT-X-MAP")) {
      output.push(
        processUriTag(
          line,
          baseUrl
        )
      );

      continue;
    }

    /*
     * 普通 M3U8 标签。
     */
    if (line.startsWith("#")) {
      output.push(line);
      continue;
    }

    /*
     * 媒体片段。
     */
    const absoluteUrl =
      resolveUrl(baseUrl, line);

    debug(
      config,
      `重写媒体片段: ${line} -> ${absoluteUrl}`
    );

    output.push(
      rewriteUrlToProxy(absoluteUrl)
    );
  }

  return output.join("\n");
}


/*
 * 处理：
 *
 * #EXT-X-KEY:METHOD=AES-128,URI="..."
 *
 * #EXT-X-MAP:URI="..."
 */
function processUriTag(
  line,
  baseUrl
) {
  return line.replace(
    /URI="([^"]+)"/,
    (match, uri) => {
      const absoluteUrl =
        resolveUrl(baseUrl, uri);

      return `URI="${rewriteUrlToProxy(absoluteUrl)}"`;
    }
  );
}


/* =========================================================
 * Authentication
 * ======================================================= */

async function validateAuth(
  request,
  env
) {
  const url = new URL(request.url);

  const authHash =
    url.searchParams.get("auth");

  const timestamp =
    url.searchParams.get("t");

  const password =
    env.PASSWORD;

  /*
   * LibreTV 要求 PASSWORD。
   */
  if (!password) {
    console.error(
      "服务器未设置 PASSWORD 环境变量"
    );

    return false;
  }

  if (!authHash) {
    return false;
  }

  const passwordHash =
    await sha256(password);

  /*
   * SHA256(password)
   */
  if (authHash !== passwordHash) {
    return false;
  }

  /*
   * 保留原项目的 10 分钟时间戳机制。
   *
   * 注意：原项目允许没有 t，
   * 所以这里也保持兼容。
   */
  if (timestamp) {
    const timestampNumber =
      parseInt(timestamp, 10);

    if (
      !Number.isFinite(timestampNumber)
    ) {
      return false;
    }

    const age =
      Date.now() - timestampNumber;

    if (age > 10 * 60 * 1000) {
      return false;
    }

    /*
     * 防止明显来自未来的时间戳。
     */
    if (age < -60 * 1000) {
      return false;
    }
  }

  return true;
}


/* =========================================================
 * URL
 * ======================================================= */

function getTargetUrlFromPath(
  pathname
) {
  const encodedUrl =
    pathname.replace(/^\/proxy\//, "");

  if (!encodedUrl) {
    return null;
  }

  try {
    let decodedUrl =
      decodeURIComponent(encodedUrl);

    /*
     * 正常情况：
     * /proxy/https%3A%2F%2Fexample.com
     */
    if (
      /^https?:\/\//i.test(decodedUrl)
    ) {
      return decodedUrl;
    }

    /*
     * 兼容没有编码的 URL。
     */
    if (
      /^https?:\/\//i.test(encodedUrl)
    ) {
      return encodedUrl;
    }

    return null;
  } catch {
    return null;
  }
}


function rewriteUrlToProxy(
  targetUrl
) {
  return `/proxy/${encodeURIComponent(targetUrl)}`;
}


function getBaseUrl(urlString) {
  try {
    const url =
      new URL(urlString);

    /*
     * 如果 URL 本身就是目录。
     */
    if (
      !url.pathname ||
      url.pathname === "/"
    ) {
      return `${url.origin}/`;
    }

    const parts =
      url.pathname.split("/");

    parts.pop();

    return (
      `${url.origin}` +
      `${parts.join("/")}/`
    );
  } catch {
    const slash =
      urlString.lastIndexOf("/");

    if (slash > 0) {
      return urlString.substring(
        0,
        slash + 1
      );
    }

    return `${urlString}/`;
  }
}


function resolveUrl(
  baseUrl,
  relativeUrl
) {
  /*
   * 已经是绝对 URL。
   */
  if (
    /^https?:\/\//i.test(relativeUrl)
  ) {
    return relativeUrl;
  }

  try {
    return new URL(
      relativeUrl,
      baseUrl
    ).toString();
  } catch {
    return relativeUrl;
  }
}


/* =========================================================
 * Detection
 * ======================================================= */

function isM3u8Response(
  response
) {
  const contentType =
    response.headers.get(
      "content-type"
    ) || "";

  /*
   * 常见 M3U8 MIME。
   */
  if (
    contentType.includes(
      "application/vnd.apple.mpegurl"
    ) ||
    contentType.includes(
      "application/x-mpegurl"
    ) ||
    contentType.includes(
      "audio/mpegurl"
    )
  ) {
    return true;
  }

  /*
   * Content-Type 不可靠时，
   * 读取 body 才能判断。
   *
   * 为了避免 stream 被消费，
   * 这里 clone 后读取。
   */
  return false;
}


function isM3u8Content(
  content,
  contentType
) {
  if (
    contentType &&
    (
      contentType.includes(
        "application/vnd.apple.mpegurl"
      ) ||
      contentType.includes(
        "application/x-mpegurl"
      ) ||
      contentType.includes(
        "audio/mpegurl"
      )
    )
  ) {
    return true;
  }

  return (
    typeof content === "string" &&
    content.trim().startsWith("#EXTM3U")
  );
}


function isMediaFile(
  url,
  contentType
) {
  const type =
    (contentType || "").toLowerCase();

  for (
    const mediaType of MEDIA_CONTENT_TYPES
  ) {
    if (type.startsWith(mediaType)) {
      return true;
    }
  }

  const lower =
    url.toLowerCase();

  return MEDIA_FILE_EXTENSIONS.some(
    ext =>
      lower.endsWith(ext) ||
      lower.includes(`${ext}?`)
  );
}


function isCacheableText(
  contentType
) {
  const type =
    (contentType || "").toLowerCase();

  return (
    type.includes("json") ||
    type.includes("text/") ||
    type.includes("javascript") ||
    type.includes("xml") ||
    type.includes("html") ||
    type.includes("mpegurl")
  );
}


/* =========================================================
 * Response
 * ======================================================= */

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods":
      "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Max-Age": "86400"
  };
}


function createResponse(
  body,
  status = 200,
  sourceHeaders = {}
) {
  const headers =
    new Headers(sourceHeaders);

  headers.set(
    "Access-Control-Allow-Origin",
    "*"
  );

  headers.set(
    "Access-Control-Allow-Methods",
    "GET, HEAD, POST, OPTIONS"
  );

  headers.set(
    "Access-Control-Allow-Headers",
    "*"
  );

  /*
   * 如果 body 被转换过，
   * 原 Content-Length 不可信。
   */
  headers.delete("Content-Length");

  return new Response(
    body,
    {
      status,
      headers
    }
  );
}


function createStreamingResponse(
  upstream,
  cacheTtl
) {
  const headers =
    new Headers(upstream.headers);

  headers.set(
    "Access-Control-Allow-Origin",
    "*"
  );

  headers.set(
    "Access-Control-Allow-Methods",
    "GET, HEAD, POST, OPTIONS"
  );

  headers.set(
    "Access-Control-Allow-Headers",
    "*"
  );

  /*
   * 允许媒体缓存。
   */
  headers.set(
    "Cache-Control",
    `public, max-age=${cacheTtl}`
  );

  return new Response(
    upstream.body,
    {
      status: upstream.status,
      statusText: upstream.statusText,
      headers
    }
  );
}


function createM3u8Response(
  content,
  cacheTtl
) {
  const headers = {
    "Content-Type":
      "application/vnd.apple.mpegurl",

    "Cache-Control":
      `public, max-age=${cacheTtl}`,

    ...corsHeaders()
  };

  return new Response(
    content,
    {
      status: 200,
      headers
    }
  );
}


function textResponse(
  body,
  status = 200
) {
  return new Response(
    body,
    {
      status,
      headers: {
        "Content-Type":
          "text/plain; charset=utf-8",

        ...corsHeaders()
      }
    }
  );
}


function jsonResponse(
  data,
  status = 200
) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=utf-8",

        ...corsHeaders()
      }
    }
  );
}


/* =========================================================
 * KV
 * ======================================================= */

async function cacheText(
  kv,
  key,
  body,
  sourceHeaders,
  ttl,
  ctx,
  config
) {
  try {
    const headers = {};

    sourceHeaders.forEach(
      (value, key) => {
        headers[key.toLowerCase()] =
          value;
      }
    );

    const value =
      JSON.stringify({
        body,
        headers
      });

    /*
     * 不阻塞当前响应。
     */
    ctx.waitUntil(
      kv.put(
        key,
        value,
        {
          expirationTtl: ttl
        }
      )
    );
  } catch (error) {
    debug(
      config,
      `[KV写入失败] ${key}: ${error.message}`
    );
  }
}


/* =========================================================
 * Config
 * ======================================================= */

function getConfig(env) {
  let userAgents = [
    DEFAULT_USER_AGENT
  ];

  if (env.USER_AGENTS_JSON) {
    try {
      const parsed =
        JSON.parse(
          env.USER_AGENTS_JSON
        );

      if (
        Array.isArray(parsed) &&
        parsed.length > 0
      ) {
        userAgents = parsed.filter(
          item =>
            typeof item === "string" &&
            item.trim()
        );
      }
    } catch (error) {
      console.warn(
        "USER_AGENTS_JSON 解析失败:",
        error
      );
    }
  }

  return {
    DEBUG_ENABLED:
      String(env.DEBUG).toLowerCase() ===
      "true",

    CACHE_TTL:
      parsePositiveInt(
        env.CACHE_TTL,
        86400
      ),

    MAX_RECURSION:
      parsePositiveInt(
        env.MAX_RECURSION,
        5
      ),

    USER_AGENTS:
      userAgents
  };
}


function parsePositiveInt(
  value,
  fallback
) {
  const number =
    parseInt(value, 10);

  if (
    !Number.isFinite(number) ||
    number <= 0
  ) {
    return fallback;
  }

  return number;
}


function getRandomUserAgent(
  userAgents
) {
  return userAgents[
    Math.floor(
      Math.random() *
      userAgents.length
    )
  ];
}


function debug(
  config,
  message
) {
  if (config.DEBUG_ENABLED) {
    console.log(
      `[LibreTV Proxy] ${message}`
    );
  }
}


/* =========================================================
 * SHA-256
 * ======================================================= */

async function sha256(
  message
) {
  const data =
    new TextEncoder().encode(
      message
    );

  const hashBuffer =
    await crypto.subtle.digest(
      "SHA-256",
      data
    );

  const hashArray =
    Array.from(
      new Uint8Array(
        hashBuffer
      )
    );

  return hashArray
    .map(
      b =>
        b.toString(16)
          .padStart(2, "0")
    )
    .join("");
}
