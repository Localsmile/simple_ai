import {
  OPENCODE_CLIENT_HEADER,
  OPENCODE_SESSION_HEADER,
  parsePublicApiTarget,
  UPSTREAM_HEADER,
} from "../../../shared/proxy-target";
import { assertPublicDns, TargetDnsError } from "./target-dns";

const LEGACY_UPSTREAM = "https://integrate.api.nvidia.com/v1/chat/completions";
const OPENAI_PATH = "/proxy/openai";
const CHAT_PATH = "/proxy/chat/completions";
const LEGACY_PATH = "/v1/chat/completions";

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
      return Response.json({ status: "ok", service: "simple-ai-cors-proxy" }, {
        headers: responseHeaders(origin),
      });
    }
    if (![OPENAI_PATH, CHAT_PATH, LEGACY_PATH].includes(url.pathname) || url.search) return errorResponse(404, "Not found", origin);
    if (!origin) return errorResponse(403, "Origin not allowed");

    if (request.method === "OPTIONS") {
      const method = request.headers.get("Access-Control-Request-Method");
      const requestedHeaders = (request.headers.get("Access-Control-Request-Headers") || "")
        .toLowerCase().split(",").map((value) => value.trim()).filter(Boolean);
      const allowedHeaders = ["authorization", "content-type", UPSTREAM_HEADER,
        OPENCODE_SESSION_HEADER, OPENCODE_CLIENT_HEADER].map((name) => name.toLowerCase());
      if (method !== "POST" || requestedHeaders.some((name) => !allowedHeaders.includes(name))) {
        return errorResponse(403, "Preflight not allowed", origin);
      }
      const headers = responseHeaders(origin);
      headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      headers.set("Access-Control-Allow-Headers",
        `Authorization, Content-Type, ${UPSTREAM_HEADER}, ${OPENCODE_SESSION_HEADER}, ${OPENCODE_CLIENT_HEADER}`);
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
    if (authorization && (!/^Bearer [^\s]+$/i.test(authorization) || authorization.length > 4096)) {
      return errorResponse(401, "Invalid Authorization header", origin);
    }
    if (!request.body) return errorResponse(400, "Request body required", origin);
    const openCodeSession = request.headers.get(OPENCODE_SESSION_HEADER) || "";
    const openCodeClient = request.headers.get(OPENCODE_CLIENT_HEADER) || "";
    if ((openCodeSession && (openCodeSession.length > 200 || !/^[\x21-\x7e]+$/.test(openCodeSession)))
      || (openCodeClient && (openCodeClient.length > 100 || !/^[a-z0-9._-]+$/i.test(openCodeClient)))) {
      return errorResponse(400, "Invalid session metadata", origin);
    }

    let target: URL;
    try {
      // Old cached clients keep their fixed destination; generic requests require a target.
      const targetHeader = request.headers.get(UPSTREAM_HEADER);
      if (url.pathname === LEGACY_PATH && targetHeader) throw new Error("기존 중계 경로는 대상 변경 불가");
      target = parsePublicApiTarget(url.pathname === LEGACY_PATH ? LEGACY_UPSTREAM : targetHeader || "");
      if (target.hostname === url.hostname) throw new Error("중계 자기 호출 차단");
    } catch (error) {
      return errorResponse(400, error instanceof Error ? error.message : "중계 대상 URL 형식 오류", origin);
    }

    try {
      // CF-Connecting-IP is supplied by Cloudflare, not X-Forwarded-For from the caller.
      // This is a per-location abuse guard, not authentication or a billing cap.
      const { success } = await env.REQUEST_LIMITER.limit({
        key: `simple-ai-cors:${request.headers.get("CF-Connecting-IP") || "local"}`,
      });
      if (!success) {
        const response = errorResponse(429, "중계 요청 한도 초과 · 잠시 후 재시도", origin);
        response.headers.set("Retry-After", "60");
        return response;
      }
      await assertPublicDns(target.hostname, request.signal);
      const upstream = await fetch(target.href, {
        method: "POST",
        headers: {
          ...(authorization ? { "Authorization": authorization } : {}),
          ...(target.hostname === "opencode.ai" && openCodeSession
            ? { [OPENCODE_SESSION_HEADER]: openCodeSession } : {}),
          ...(target.hostname === "opencode.ai" && openCodeClient
            ? { [OPENCODE_CLIENT_HEADER]: openCodeClient } : {}),
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
    } catch (error) {
      if (error instanceof TargetDnsError && !request.signal.aborted) {
        return errorResponse(error.status, error.message, origin);
      }
      return errorResponse(request.signal.aborted ? 499 : 502,
        request.signal.aborted ? "Request cancelled" : "외부 API 중계 연결 실패", origin);
    }
  },
} satisfies ExportedHandler<Env>;
