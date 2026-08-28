import assert from "node:assert/strict";
import test from "node:test";
import { loadTs, memoryStorage } from "./load-ts.mjs";

const origin = "https://localsmile.github.io";
const upstreamUrl = "https://integrate.api.nvidia.com/v1/chat/completions";
const { DEFAULT_SETTINGS, DEFAULT_PROVIDER_PRESET } = loadTs("app/types.ts");
const { NVIDIA_PROXY_URL, resolveCompletionUrl, supportsNvidiaProxy } = loadTs("app/lib/connection.ts");
const provider = { ...DEFAULT_PROVIDER_PRESET, baseUrl: upstreamUrl, connectionMode: "nvidia-proxy", apiKey: "test-key" };

function request({ method = "POST", path = "/v1/chat/completions", headers = {}, ...options } = {}) {
  return new Request(`https://proxy.test${path}`, {
    method,
    headers: { Origin: origin, Authorization: "Bearer test-key", "Content-Type": "application/json", ...headers },
    ...(!["GET", "OPTIONS", "HEAD"].includes(method) ? { body: '{"messages":[]}' } : {}),
    ...options,
  });
}

function setup(fetch = async () => { throw new Error("Unexpected upstream call"); }, success = true) {
  const rateKeys = [];
  const env = {
    ALLOWED_ORIGINS: origin, ALLOW_LOCALHOST: "true",
    REQUEST_LIMITER: { limit: async ({ key }) => { rateKeys.push(key); return { success }; } },
  };
  const worker = loadTs("workers/nvidia-proxy/src/index.ts", { fetch }).default;
  return { call: (req) => worker.fetch(req, env), rateKeys };
}

test("proxy route requires explicit selection and the exact NVIDIA endpoint", () => {
  for (const baseUrl of [upstreamUrl, `${upstreamUrl}/`, " https://integrate.api.nvidia.com/v1/ "]) {
    assert.equal(supportsNvidiaProxy(baseUrl), true);
    assert.equal(resolveCompletionUrl({ ...provider, baseUrl }), NVIDIA_PROXY_URL);
  }
  for (const baseUrl of ["https://other.test/v1", "http://integrate.api.nvidia.com/v1",
    "https://integrate.api.nvidia.com.evil.test/v1", "https://integrate.api.nvidia.com:444/v1",
    "https://user:pass@integrate.api.nvidia.com/v1", `${upstreamUrl}?url=x`, `${upstreamUrl}#fragment`, "invalid"]) {
    assert.equal(supportsNvidiaProxy(baseUrl), false);
    assert.throws(() => resolveCompletionUrl({ ...provider, baseUrl }), /NVIDIA/);
  }
  assert.equal(resolveCompletionUrl({ baseUrl: "https://custom.test/v1" }), "https://custom.test/v1/chat/completions");
});

test("connection mode persists per preset; existing presets remain direct", () => {
  const localStorage = memoryStorage(), sessionStorage = memoryStorage();
  const { loadSettings, saveSettings } = loadTs("app/lib/storage.ts", { window: {}, localStorage, sessionStorage });
  saveSettings({ ...DEFAULT_SETTINGS, providerPresets: [provider, { ...DEFAULT_PROVIDER_PRESET, id: "other" }] });
  assert.deepEqual(loadSettings().providerPresets.map((p) => p.connectionMode), ["nvidia-proxy", "direct"]);
  assert.equal(localStorage.getItem("simple-ai:settings").includes("test-key"), false);
  localStorage.setItem("simple-ai:settings", JSON.stringify({ providerPresets: [{ id: "legacy", baseUrl: upstreamUrl }] }));
  assert.equal(loadSettings().providerPresets[0].connectionMode, "direct");
});

test("preflight permits Pages and loopback, rejects untrusted and opaque origins", async () => {
  const { call } = setup();
  for (const value of [origin, "http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173"]) {
    const response = await call(request({ method: "OPTIONS", headers: { Origin: value,
      "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization, Content-Type" } }));
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), value);
    assert.match(response.headers.get("Access-Control-Allow-Headers"), /Authorization/);
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

test("unsupported paths, methods, headers and missing credentials never call upstream", async () => {
  const { call, rateKeys } = setup();
  for (const [options, status] of [
    [{ path: "/other" }, 404], [{ path: "/v1/chat/completions?url=https://other.test" }, 404],
    [{ method: "GET" }, 405], [{ headers: { Authorization: "" } }, 401],
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
  for (const name of ["Cookie", "Origin", "X-Target-Url"]) assert.equal(captured.init.headers[name], undefined);
  assert.deepEqual(rateKeys, ["simple-ai-nvidia:192.0.2.1"]);
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
    }, messages: [{ role: "user", content: "hello" }], signal: abort.signal });
    assert.equal(result.content, "NIM_OK");
    assert.equal(captured.url, NVIDIA_PROXY_URL);
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
    provider: { ...provider, baseUrl: "https://custom.test/v1" }, messages: [] }), /NVIDIA/);
});
