export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const response = await env.ASSETS.fetch(request);

    return applyCacheHeaders(url.pathname, response);
  }
};

function applyCacheHeaders(pathname, response) {
  if (!response || !response.ok) {
    return response;
  }

  const headers = new Headers(response.headers);
  const cacheControl = selectCacheControl(pathname);

  if (cacheControl) {
    headers.set("Cache-Control", cacheControl);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function selectCacheControl(pathname) {
  if (pathname === "/" || pathname === "/index.html" || pathname === "/embed.html") {
    return "public, max-age=300, s-maxage=300";
  }

  if (pathname === "/feed.json" || pathname === "/board.data.json") {
    return "public, max-age=900, s-maxage=900, stale-while-revalidate=43200";
  }

  if (pathname.startsWith("/.collector-cache/")) {
    return "public, max-age=3600";
  }

  if (/\/assets\/.+\.[0-9a-f]{10}\.(js|css)$/.test(pathname) || /\.[0-9a-f]{10}\.(js|css)$/.test(pathname)) {
    return "public, max-age=31536000, immutable";
  }

  return "";
}
