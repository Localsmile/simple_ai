import assert from "node:assert/strict";
import test from "node:test";
import { loadTs, memoryStorage } from "./load-ts.mjs";

const origin = "https://localsmile.github.io";
const upstreamUrl = "https://integrate.api.nvidia.com/v1/chat/completions";
const { DEFAULT_SETTINGS, DEFAULT_PROVIDER_PRESET } = loadTs("app/types.ts");
const { CORS_PROXY_URL, UPSTREAM_HEADER, resolveCompletionUrl, supportsCorsProxy, resolveChatUrl } = loadTs("app/lib/connection.ts");
const provider = { ...DEFAULT_PROVIDER_PRESET, baseUrl: upstreamUrl, connectionMode: "cors-proxy", apiKey: "test-key" };

function request({ method = "POST", path = "/proxy/chat/completions", headers = {}, ...options } = {}) {
  return new Request(`https://proxy.test${path}`, {
    method,
    headers: { Origin: origin, Authorization: "Bearer test-key", "Content-Type": "application/json", [UPSTREAM_HEADER]: upstreamUrl, ...headers },
    ...(!["GET", "OPTIONS", "HEAD"].includes(method) ? { body: '{"messages":[]}' } : {}),
    ...options,
  });
}

function setup(fetch = async () => { throw new Error("Unexpected upstream call"); }, success = true, dnsResponse) {
  const rateKeys = [];
  const dnsRequests = [];
  const env = {
    ALLOWED_ORIGINS: origin, ALLOW_LOCALHOST: "true",
    REQUEST_LIMITER: { limit: async ({ key }) => { rateKeys.push(key); return { success }; } },
  };
  const worker = loadTs("workers/nvidia-proxy/src/index.ts", { fetch: async (url, init) => {
    if (url.startsWith("https://cloudflare-dns.com/dns-query?")) {
      dnsRequests.push({ url, init });
      if (dnsResponse) return dnsResponse(url, init);
      return Response.json({ Status: 0, Answer: new URL(url).searchParams.get("type") === "A"
        ? [{ type: 1, data: "1.1.1.1" }] : [{ type: 28, data: "2606:4700:4700::1111" }] });
    }
    return fetch(url, init);
  } }).default;
  return { call: (req) => worker.fetch(req, env), rateKeys, dnsRequests };
}

test("proxy route supports custom public HTTPS providers and preserves query parameters", () => {
  for (const baseUrl of [upstreamUrl, `${upstreamUrl}/`, " https://integrate.api.nvidia.com/v1/ ",
    "https://api.example.com/custom/v2", "https://openrouter.ai/api/v1", `${upstreamUrl}?api-version=1`]) {
    assert.equal(supportsCorsProxy(baseUrl), true);
    assert.equal(resolveCompletionUrl({ ...provider, baseUrl }), CORS_PROXY_URL);
  }
  assert.equal(resolveChatUrl("https://api.example.com/v1?api-version=1"), "https://api.example.com/v1/chat/completions?api-version=1");
  assert.equal(resolveChatUrl("https://api.example.com/v1?resource=foo/"), "https://api.example.com/v1/chat/completions?resource=foo/");
  for (const baseUrl of ["https://other.test/v1", "http://api.example.com/v1", "https://api.example.com:444/v1",
    "https://user:pass@api.example.com/v1", `${upstreamUrl}#fragment`, "https://localhost/v1", "https://localhost./v1",
    "https://127.0.0.1/v1", "https://2130706433/v1", "https://0x7f000001/v1", "https://[::1]/v1",
    "https://metadata.google.internal/v1", CORS_PROXY_URL, "invalid"]) {
    assert.equal(supportsCorsProxy(baseUrl), false, baseUrl);
    assert.throws(() => resolveCompletionUrl({ ...provider, baseUrl }), /중계/);
  }
  assert.equal(resolveCompletionUrl({ baseUrl: "https://custom.test/v1" }), "https://custom.test/v1/chat/completions");
  assert.equal(resolveCompletionUrl({ ...provider, connectionMode: "nvidia-proxy" }), CORS_PROXY_URL);
});

test("connection mode persists per preset; existing presets remain direct", () => {
  const localStorage = memoryStorage(), sessionStorage = memoryStorage();
  const { loadSettings, saveSettings } = loadTs("app/lib/storage.ts", { window: {}, localStorage, sessionStorage });
  saveSettings({ ...DEFAULT_SETTINGS, providerPresets: [provider, { ...DEFAULT_PROVIDER_PRESET, id: "other" }] });
  assert.deepEqual(loadSettings().providerPresets.map((p) => p.connectionMode), ["cors-proxy", "direct"]);
  assert.equal(localStorage.getItem("simple-ai:settings").includes("test-key"), false);
  localStorage.setItem("simple-ai:settings", JSON.stringify({ providerPresets: [{ id: "legacy", baseUrl: upstreamUrl }] }));
  assert.equal(loadSettings().providerPresets[0].connectionMode, "direct");
  localStorage.setItem("simple-ai:settings", JSON.stringify({ providerPresets: [{ ...provider, connectionMode: "nvidia-proxy" }] }));
  assert.equal(loadSettings().providerPresets[0].connectionMode, "cors-proxy");
});

test("preflight permits Pages and loopback, rejects untrusted and opaque origins", async () => {
  const { call } = setup();
  for (const value of [origin, "http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173"]) {
    const response = await call(request({ method: "OPTIONS", headers: { Origin: value,
      "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization, Content-Type, x-upstream-url" } }));
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), value);
    assert.match(response.headers.get("Access-Control-Allow-Headers"), /Authorization/);
    assert.match(response.headers.get("Access-Control-Allow-Headers"), /X-Upstream-Url/);
    assert.equal(response.headers.has("Access-Control-Allow-Credentials"), false);
  }
  for (const value of ["https://evil.test", "http://localhost.evil.test:5173", "null", ""]) {
    const response = await call(request({ headers: { Origin: value } }));
    assert.equal(response.status, 403);
    assert.equal(response.headers.has("Access-Control-Allow-Origin"), false);
  }
  assert.equal((await call(request({ method: "OPTIONS", headers: { "Access-Control-Request-Method": "DELETE" } }))).status, 403);
  assert.equal((await call(request({ method: "OPTIONS", headers: {
    "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-target-url" } }))).status, 403);
});

test("unsupported paths, targets, methods and malformed credentials never call upstream", async () => {
  const { call, rateKeys } = setup();
  for (const [options, status] of [
    [{ path: "/other" }, 404], [{ path: "/proxy/chat/completions?url=https://other.test" }, 404],
    [{ method: "GET" }, 405], [{ headers: { Authorization: "Basic test" } }, 401],
    [{ headers: { [UPSTREAM_HEADER]: "" } }, 400], [{ headers: { [UPSTREAM_HEADER]: "https://127.0.0.1/v1/chat/completions" } }, 400],
    [{ headers: { "Content-Type": "text/plain" } }, 415], [{ headers: { "Content-Encoding": "gzip" } }, 415],
  ]) {
    const response = await call(request(options));
    assert.equal(response.status, status);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
  }
  assert.equal(rateKeys.length, 0);
  assert.equal((await call(request({ path: "/health", method: "GET" }))).status, 200);
});

test("request and SSE bodies stream unchanged; cookies and unrelated headers are stripped", async () => {
  let captured;
  const encoder = new TextEncoder();
  let controller;
  const stream = new ReadableStream({ start(value) { controller = value; } });
  const { call, rateKeys } = setup(async (url, init) => {
    captured = { url, init };
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Set-Cookie": "private=value",
      "Access-Control-Allow-Origin": "*", "X-Request-Id": "test-request" } });
  });
  const req = request({ headers: { Cookie: "session=private", "X-Target-Url": "https://other.test", "CF-Connecting-IP": "192.0.2.1" } });
  const response = await call(req);
  assert.equal(captured.url, upstreamUrl);
  assert.equal(captured.init.body, req.body);
  assert.equal(captured.init.signal, req.signal);
  assert.equal(captured.init.redirect, "manual");
  assert.equal(captured.init.headers.Authorization, "Bearer test-key");
  for (const name of ["Cookie", "Origin", "X-Target-Url", UPSTREAM_HEADER]) assert.equal(captured.init.headers[name], undefined);
  assert.deepEqual(rateKeys, ["simple-ai-cors:192.0.2.1"]);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
  assert.equal(response.headers.has("Set-Cookie"), false);
  const reader = response.body.getReader();
  controller.enqueue(encoder.encode("data: first\n\n"));
  assert.equal(new TextDecoder().decode((await reader.read()).value), "data: first\n\n");
  controller.enqueue(encoder.encode("data: second\n\n"));
  controller.close();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "data: second\n\n");
  assert.equal((await reader.read()).done, true);
});

test("upstream errors remain visible with CORS; rate limits and redirects fail safely", async () => {
  const error = await setup(async () => new Response('{"error":{"message":"invalid key"}}', {
    status: 401, headers: { "Content-Type": "application/json", "Retry-After": "3" },
  })).call(request());
  assert.equal(error.status, 401);
  assert.equal(error.headers.get("Retry-After"), "3");
  assert.equal(error.headers.get("Access-Control-Allow-Origin"), origin);
  assert.equal((await error.json()).error.message, "invalid key");
  const redirect = await setup(async () => new Response(null, { status: 307, headers: { Location: "https://evil.test" } })).call(request());
  assert.equal(redirect.status, 502);
  assert.equal(redirect.headers.has("Location"), false);
  const limited = await setup(undefined, false).call(request());
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("Retry-After"), "60");
  const failure = await setup(async () => { throw new Error("private upstream diagnostics"); }).call(request());
  assert.equal(failure.status, 502);
  assert.equal((await failure.text()).includes("private upstream diagnostics"), false);
});

test("app routes JSON and SSE via proxy with unchanged payload and cancellation", async () => {
  for (const stream of [false, true]) {
    let captured;
    const abort = new AbortController();
    const { requestCompletion } = loadTs("app/lib/api.ts", { fetch: async (url, init) => {
      captured = { url, init };
      const payload = { choices: [{ [stream ? "delta" : "message"]: { content: "NIM_OK" }, finish_reason: "stop" }] };
      return new Response(stream ? `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n` : JSON.stringify(payload), {
        headers: { "Content-Type": stream ? "text/event-stream" : "application/json" },
      });
    } });
    const result = await requestCompletion({ settings: { ...DEFAULT_SETTINGS, stream }, provider: {
      ...provider, extraBody: '{"chat_template_kwargs":{"thinking":false}}',
      baseUrl: "https://api.example.com/custom/chat/completions?api-version=1",
    }, messages: [{ role: "user", content: "hello" }], signal: abort.signal });
    assert.equal(result.content, "NIM_OK");
    assert.equal(captured.url, CORS_PROXY_URL);
    assert.equal(captured.init.headers.get(UPSTREAM_HEADER), "https://api.example.com/custom/chat/completions?api-version=1");
    assert.equal(captured.init.signal, abort.signal);
    assert.equal(captured.init.credentials, "omit");
    assert.equal(captured.init.redirect, "error");
    assert.equal(captured.init.headers.get("Authorization"), "Bearer test-key");
    const body = JSON.parse(captured.init.body);
    assert.equal(body.chat_template_kwargs.thinking, false);
    assert.deepEqual(body.messages, [{ role: "user", content: "hello" }]);
  }
});

test("invalid proxy configuration fails before transmitting credentials", async () => {
  const { requestCompletion } = loadTs("app/lib/api.ts", { fetch: () => assert.fail("Must not fetch") });
  await assert.rejects(requestCompletion({ settings: DEFAULT_SETTINGS,
    provider: { ...provider, baseUrl: "https://localhost/v1" }, messages: [] }), /중계/);
});

test("generic targets, query parameters and optional credentials reach only their selected provider", async () => {
  const target = "https://api.example.com/custom/v2/chat/completions?api-version=1&key=query-test";
  let captured;
  const { call, dnsRequests } = setup(async (url, init) => {
    captured = { url, init };
    return Response.json({ choices: [] });
  });
  assert.equal((await call(request({ headers: { [UPSTREAM_HEADER]: target, Authorization: "" } }))).status, 200);
  assert.equal(captured.url, target);
  assert.equal(captured.init.headers.Authorization, undefined);
  assert.equal(dnsRequests.length, 2);
  for (const { url, init } of dnsRequests) {
    assert.equal(new URL(url).searchParams.get("name"), "api.example.com");
    assert.equal(url.includes("query-test"), false);
    assert.deepEqual(init.headers, { Accept: "application/dns-json" });
    assert.equal(init.redirect, "manual");
  }
});

test("legacy clients retain a fixed destination and cannot override it", async () => {
  let captured;
  const { call } = setup(async (url) => { captured = url; return Response.json({ choices: [] }); });
  assert.equal((await call(request({ path: "/v1/chat/completions", headers: { [UPSTREAM_HEADER]: "" } }))).status, 200);
  assert.equal(captured, upstreamUrl);
  assert.equal((await call(request({ path: "/v1/chat/completions" }))).status, 400);
});

test("DNS private, reserved, mapped and mixed addresses are blocked before credential forwarding", async () => {
  for (const data of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1",
    "0.0.0.0", "224.0.0.1", "192.0.2.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "2001:db8::1", "64:ff9b::a00:1"]) {
    const { call } = setup(undefined, true, async () => Response.json({ Status: 0,
      Answer: [{ type: 1, data: "1.1.1.1" }, { type: data.includes(":") ? 28 : 1, data }] }));
    assert.equal((await call(request())).status, 403, data);
  }
});

test("DNS errors and oversized responses fail closed; rate limiting runs before DNS", async () => {
  for (const dnsResponse of [
    async () => Response.json({ Status: 3 }), async () => Response.json({ Status: 0 }),
    async () => Response.json({ Status: 0, TC: true }), async () => new Response("invalid"),
    async () => new Response("x".repeat(131073)), async () => { throw new Error("DNS unavailable"); },
  ]) {
    const { call } = setup(undefined, true, dnsResponse);
    assert.equal((await call(request())).status, 502);
  }
  const { call, dnsRequests } = setup(undefined, false);
  assert.equal((await call(request())).status, 429);
  assert.equal(dnsRequests.length, 0);
});

test("direct connections never send the proxy target header", async () => {
  let captured;
  const { requestCompletion } = loadTs("app/lib/api.ts", { fetch: async (url, init) => {
    captured = { url, init }; return Response.json({ choices: [] });
  } });
  await requestCompletion({ settings: DEFAULT_SETTINGS, provider: { ...provider, connectionMode: "direct" }, messages: [] });
  assert.equal(captured.url, upstreamUrl);
  assert.equal(captured.init.headers.has(UPSTREAM_HEADER), false);
});
