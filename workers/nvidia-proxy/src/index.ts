const UPSTREAM = "https://integrate.api.nvidia.com/v1/chat/completions";
const CHAT_PATH = "/v1/chat/completions";

function allowedOrigin(origin: string | null, env: Env): string | undefined {
  if (!origin || origin === "null") return undefined;
  if (env.ALLOWED_ORIGINS.split(",").map((value) => value.trim()).includes(origin)) return origin;
  if (env.ALLOW_LOCALHOST === "true"
    && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return origin;
  return undefined;
}

function responseHeaders(origin?: string): Headers {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Vary": "Origin",
  });
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Expose-Headers", "Retry-After, X-Request-Id");
  }
  return headers;
}

function errorResponse(status: number, message: string, origin?: string): Response {
  return Response.json({ error: { message, type: "proxy_error" } }, {
    status, headers: responseHeaders(origin),
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = allowedOrigin(request.headers.get("Origin"), env);

    if (url.pathname === "/health" && request.method === "GET" && !url.search) {
      return Response.json({ status: "ok", service: "simple-ai-nvidia-proxy" }, {
        headers: responseHeaders(origin),
      });
    }
    // A fixed destination prevents arbitrary forwarding and credential-bearing redirects.
    if (url.pathname !== CHAT_PATH || url.search) return errorResponse(404, "Not found", origin);
    if (!origin) return errorResponse(403, "Origin not allowed");

    if (request.method === "OPTIONS") {
      const method = request.headers.get("Access-Control-Request-Method");
      const requestedHeaders = (request.headers.get("Access-Control-Request-Headers") || "")
        .toLowerCase().split(",").map((value) => value.trim()).filter(Boolean);
      if (method !== "POST" || requestedHeaders.some((name) => !["authorization", "content-type"].includes(name))) {
        return errorResponse(403, "Preflight not allowed", origin);
      }
      const headers = responseHeaders(origin);
      headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
      headers.set("Access-Control-Max-Age", "86400");
      headers.set("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== "POST") {
      const response = errorResponse(405, "Method not allowed", origin);
      response.headers.set("Allow", "POST, OPTIONS");
      return response;
    }
    if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
      return errorResponse(415, "Content-Type must be application/json", origin);
    }
    if (request.headers.has("Content-Encoding")) return errorResponse(415, "Content-Encoding not supported", origin);
    const authorization = request.headers.get("Authorization") || "";
    if (!/^Bearer [^\s]+$/i.test(authorization) || authorization.length > 4096) {
      return errorResponse(401, "API key required", origin);
    }
    if (!request.body) return errorResponse(400, "Request body required", origin);

    try {
      // CF-Connecting-IP is supplied by Cloudflare, not X-Forwarded-For from the caller.
      // This is a per-location abuse guard, not authentication or a billing cap.
      const { success } = await env.REQUEST_LIMITER.limit({
        key: `simple-ai-nvidia:${request.headers.get("CF-Connecting-IP") || "local"}`,
      });
      if (!success) {
        const response = errorResponse(429, "중계 요청 한도 초과 · 잠시 후 재시도", origin);
        response.headers.set("Retry-After", "60");
        return response;
      }
      const upstream = await fetch(UPSTREAM, {
        method: "POST",
        headers: {
          "Authorization": authorization,
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
          "Accept-Encoding": "identity",
        },
        body: request.body,
        signal: request.signal,
        redirect: "manual",
      });
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel();
        return errorResponse(502, "Upstream redirect blocked", origin);
      }
      const headers = responseHeaders(origin);
      for (const name of ["Content-Type", "Retry-After", "X-Request-Id"]) {
        const value = upstream.headers.get(name);
        if (value) headers.set(name, value);
      }
      // Pass both bodies through without JSON parsing, buffering, storage, or automatic retries.
      return new Response(upstream.body, { status: upstream.status, headers });
    } catch {
      return errorResponse(request.signal.aborted ? 499 : 502,
        request.signal.aborted ? "Request cancelled" : "NVIDIA 중계 연결 실패", origin);
    }
  },
} satisfies ExportedHandler<Env>;
