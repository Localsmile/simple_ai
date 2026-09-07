import assert from "node:assert/strict";
import test from "node:test";
import { loadTs, memoryStorage } from "./load-ts.mjs";

const origin = "https://localsmile.github.io";
const upstreamUrl = "https://integrate.api.nvidia.com/v1/chat/completions";
const { DEFAULT_SETTINGS, DEFAULT_PROVIDER_PRESET, resolveProviderModel } = loadTs("app/types.ts");
const {
  CORS_PROXY_URL, OPENCODE_CLIENT_HEADER, OPENCODE_SESSION_HEADER, UPSTREAM_HEADER,
  resolveCompletionTargets, resolveCompletionUrl, supportsCorsProxy, resolveChatUrl,
} = loadTs("app/lib/connection.ts");
const provider = { ...DEFAULT_PROVIDER_PRESET, ...resolveProviderModel(DEFAULT_PROVIDER_PRESET), baseUrl: upstreamUrl, connectionMode: "cors-proxy", apiKey: "test-key" };

function request({ method = "POST", path = "/proxy/openai", headers = {}, ...options } = {}) {
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
  assert.equal(resolveChatUrl("https://api.example.com/v1/responses"), "https://api.example.com/v1/responses");
  assert.equal(supportsCorsProxy("https://api.example.com/v1/responses"), true);
  assert.equal(resolveChatUrl("https://api.example.com/v1/messages"), "https://api.example.com/v1/messages");
  assert.equal(supportsCorsProxy("https://api.example.com/v1/messages"), true);
  assert.deepEqual(resolveCompletionTargets("https://api.example.com/v1/responses").map((item) => item.url), [
    "https://api.example.com/v1/responses",
    "https://api.example.com/v1/chat/completions",
    "https://api.example.com/v1/messages",
  ]);
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
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization, Content-Type, x-upstream-url, x-opencode-session, x-opencode-client" } }));
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), value);
    assert.match(response.headers.get("Access-Control-Allow-Headers"), /Authorization/);
    assert.match(response.headers.get("Access-Control-Allow-Headers"), /X-Upstream-Url/);
    assert.match(response.headers.get("Access-Control-Allow-Headers"), /X-OpenCode-Session/);
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
    [{ path: "/other" }, 404], [{ path: "/proxy/openai?url=https://other.test" }, 404],
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

test("proxy forwards validated OpenCode session metadata only to OpenCode", async () => {
  const captured = [];
  const { call } = setup(async (url, init) => {
    captured.push({ url, headers: init.headers });
    return Response.json({ ok: true });
  });
  const metadata = { [OPENCODE_SESSION_HEADER]: "conversation_123", [OPENCODE_CLIENT_HEADER]: "simple-ai" };
  assert.equal((await call(request({ headers: { ...metadata,
    [UPSTREAM_HEADER]: "https://opencode.ai/zen/go/v1/messages" } }))).status, 200);
  assert.equal(captured[0].headers[OPENCODE_SESSION_HEADER], "conversation_123");
  assert.equal(captured[0].headers[OPENCODE_CLIENT_HEADER], "simple-ai");

  assert.equal((await call(request({ headers: { ...metadata,
    [UPSTREAM_HEADER]: "https://api.example.com/v1/messages" } }))).status, 200);
  assert.equal(captured[1].headers[OPENCODE_SESSION_HEADER], undefined);
  assert.equal(captured[1].headers[OPENCODE_CLIENT_HEADER], undefined);
  assert.equal((await call(request({ headers: { ...metadata,
    [OPENCODE_SESSION_HEADER]: "contains space" } }))).status, 400);
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

test("OpenCode sessions survive the proxy while unrelated providers receive no provider-specific headers", async () => {
  const sessionId = "conversation_stable_123";
  const openCodeTarget = "https://opencode.ai/zen/go/v1/responses";
  const seen = [];
  const { requestCompletion } = loadTs("app/lib/api.ts", { fetch: async (url, init) => {
    seen.push({ url, headers: init.headers });
    return Response.json({ id: "resp_session", status: "completed", output: [
      { type: "message", content: [{ type: "output_text", text: "ok" }] },
    ] });
  } });
  await requestCompletion({ settings: { ...DEFAULT_SETTINGS, stream: false }, sessionId,
    provider: { ...provider, baseUrl: openCodeTarget }, messages: [{ role: "user", content: "hello" }] });
  assert.equal(seen[0].headers.get(OPENCODE_SESSION_HEADER), sessionId);
  assert.equal(seen[0].headers.get(OPENCODE_CLIENT_HEADER), "simple-ai");

  await requestCompletion({ settings: { ...DEFAULT_SETTINGS, stream: false }, sessionId,
    provider: { ...provider, model: "generic-session-test", baseUrl: "https://api.example.com/v1/responses" },
    messages: [{ role: "user", content: "hello" }] });
  assert.equal(seen[1].headers.has(OPENCODE_SESSION_HEADER), false);
  assert.equal(seen[1].headers.has(OPENCODE_CLIENT_HEADER), false);
});

test("base endpoints negotiate standard API shapes without model-name rules and remember the result", async () => {
  const calls = [];
  const autoProvider = { ...provider, baseUrl: "https://opencode.ai/zen/go/v1", model: "future/model-2040" };
  const { requestCompletion } = loadTs("app/lib/api.ts", { fetch: async (url, init) => {
    const target = init.headers.get(UPSTREAM_HEADER);
    calls.push({ target, body: JSON.parse(init.body), headers: init.headers });
    if (!target.endsWith("/messages")) {
      return Response.json({ error: { message: "unsupported request shape" } }, { status: 400 });
    }
    return Response.json({ id: "msg_auto", model: autoProvider.model, stop_reason: "end_turn",
      content: [{ type: "text", text: "AUTO_OK" }], usage: { input_tokens: 3, output_tokens: 2 } });
  } });
  const options = { settings: { ...DEFAULT_SETTINGS, stream: false }, provider: autoProvider,
    sessionId: "conversation_auto", messages: [{ role: "system", content: "system" },
      { role: "user", content: "hello" }] };
  const first = await requestCompletion(options);
  assert.equal(first.content, "AUTO_OK");
  assert.deepEqual(calls.map((call) => new URL(call.target).pathname), [
    "/zen/go/v1/chat/completions", "/zen/go/v1/responses", "/zen/go/v1/messages",
  ]);
  assert.equal(calls.every((call) => call.headers.get(OPENCODE_SESSION_HEADER) === "conversation_auto"), true);
  assert.equal(calls[2].body.system, "system");
  assert.equal(calls[2].body.messages[0].role, "user");

  await requestCompletion(options);
  assert.equal(new URL(calls[3].target).pathname, "/zen/go/v1/messages");
  assert.equal(calls.length, 4);
});

test("Messages endpoints preserve streaming thinking, tools, images and usage", async () => {
  const endpoint = "https://api.example.com/v1/messages";
  let sent;
  const events = [
    { type: "message_start", message: { id: "msg_1", model: "messages-model", usage: { input_tokens: 5 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "think" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signed" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "tool_1", name: "lookup", input: {} } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"q":"x"}' } },
    { type: "content_block_stop", index: 2 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } },
    { type: "message_stop" },
  ];
  const { requestCompletion, serializeCompletionRequest } = loadTs("app/lib/api.ts", {
    fetch: async (url, init) => {
      sent = JSON.parse(init.body);
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  const responseProvider = { ...provider, baseUrl: endpoint, model: "messages-model" };
  const deltas = [], thinking = [];
  const result = await requestCompletion({ settings: { ...DEFAULT_SETTINGS, stream: true }, provider: responseProvider,
    messages: [{ role: "system", content: "system" }, { role: "user", content: [
      { type: "text", text: "hello" }, { type: "image_url", image_url: { url: "data:image/webp;base64,AA==" } },
    ] }], tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
    onDelta: (value) => deltas.push(value), onReasoningDelta: (value) => thinking.push(value) });
  assert.equal(sent.system, "system");
  assert.equal(sent.messages[0].content[1].source.media_type, "image/webp");
  assert.equal(sent.tools[0].input_schema.type, "object");
  assert.deepEqual(sent.tool_choice, { type: "auto" });
  assert.equal(result.content, "answer");
  assert.equal(result.reasoning, "think");
  assert.deepEqual(deltas, ["answer"]);
  assert.deepEqual(thinking, ["think"]);
  assert.deepEqual(result.toolCalls[0], { id: "tool_1", type: "function",
    function: { name: "lookup", arguments: '{"q":"x"}' } });
  assert.equal(result.usage.input, 5);
  assert.equal(result.usage.output, 4);
  const next = JSON.parse(serializeCompletionRequest(DEFAULT_SETTINGS, responseProvider,
    [result.rawAssistantMessage, { role: "tool", tool_call_id: "tool_1", content: "result" }]));
  assert.equal(next.messages[0].content[2].type, "tool_use");
  assert.equal(next.messages[1].content[0].type, "tool_result");
});

test("Responses endpoints use the standard request, stream, usage and tool formats", async () => {
  const endpoint = "https://api.example.com/v1/responses";
  const responseProvider = { ...provider, baseUrl: endpoint, model: "response-model" };
  const calls = [];
  const { requestCompletion, serializeCompletionRequest } = loadTs("app/lib/api.ts", {
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
      return new Response([
        `data: ${JSON.stringify({ type: "response.reasoning_summary_text.delta", delta: "think" })}\n\n`,
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "answer" })}\n\n`,
        `data: ${JSON.stringify({ type: "response.completed", response: {
          id: "resp_1", model: "response-model", status: "completed",
          output: [
            { id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: "think" }] },
            { id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
            { id: "fc_1", type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
          ],
          usage: { input_tokens: 7, output_tokens: 5, output_tokens_details: { reasoning_tokens: 2 } },
        } })}\n\n`,
      ].join(""), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  const deltas = [], reasoning = [];
  const result = await requestCompletion({
    settings: { ...DEFAULT_SETTINGS, stream: true, maxTokens: 1234 }, provider: responseProvider,
    messages: [{ role: "user", content: [{ type: "text", text: "hello" },
      { type: "image_url", image_url: { url: "data:image/webp;base64,AA==", detail: "auto" } }] }],
    tools: [{ type: "function", function: { name: "lookup", description: "Lookup", parameters: { type: "object" } } }],
    onDelta: (delta) => deltas.push(delta), onReasoningDelta: (delta) => reasoning.push(delta),
  });
  assert.equal(calls[0].url, CORS_PROXY_URL);
  assert.equal(calls[0].headers.get(UPSTREAM_HEADER), endpoint);
  assert.equal(calls[0].body.max_output_tokens, 1234);
  assert.equal(calls[0].body.max_tokens, undefined);
  assert.equal(calls[0].body.messages, undefined);
  assert.equal(calls[0].body.stream_options, undefined);
  assert.deepEqual(calls[0].body.input[0].content, [
    { type: "input_text", text: "hello" },
    { type: "input_image", image_url: "data:image/webp;base64,AA==", detail: "auto" },
  ]);
  assert.deepEqual(calls[0].body.tools[0], { type: "function", name: "lookup",
    description: "Lookup", parameters: { type: "object" } });
  assert.equal(result.content, "answer");
  assert.equal(result.reasoning, "think");
  assert.deepEqual(deltas, ["answer"]);
  assert.deepEqual(reasoning, ["think"]);
  assert.equal(result.toolCalls[0].id, "call_1");
  assert.equal(result.usage.reasoning, 2);
  assert.equal(result.rawAssistantMessages.length, 3);
  const next = JSON.parse(serializeCompletionRequest(DEFAULT_SETTINGS, responseProvider,
    [...result.rawAssistantMessages, { role: "tool", tool_call_id: "call_1", content: "result" }]));
  assert.equal(next.input.at(-2).type, "function_call");
  assert.deepEqual(next.input.at(-1), { type: "function_call_output", call_id: "call_1", output: "result" });
});

test("Responses JSON errors and incomplete output remain concise and actionable", async () => {
  const responseProvider = { ...provider, baseUrl: "https://api.example.com/v1/responses" };
  const { requestCompletion } = loadTs("app/lib/api.ts", {
    fetch: async () => Response.json({ id: "resp_2", status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" }, output: [
        { type: "message", content: [{ type: "output_text", text: "partial" }] },
      ], usage: { input_tokens: 3, output_tokens: 9 } }),
  });
  const result = await requestCompletion({ settings: { ...DEFAULT_SETTINGS, stream: false },
    provider: responseProvider, messages: [] });
  assert.equal(result.content, "partial");
  assert.equal(result.finishReason, "length");

  const html = loadTs("app/lib/api.ts", {
    fetch: async () => new Response("<!DOCTYPE html><html>large injected page</html>", { status: 404 }),
  });
  await assert.rejects(html.requestCompletion({ settings: DEFAULT_SETTINGS,
    provider: responseProvider, messages: [] }), /^ApiRequestError: API 404: HTML 응답 · 엔드포인트 확인$/);
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
    captured = { url, init };
    return Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
  } });
  await requestCompletion({ settings: DEFAULT_SETTINGS, provider: { ...provider, connectionMode: "direct" }, messages: [] });
  assert.equal(captured.url, upstreamUrl);
  assert.equal(captured.init.headers.has(UPSTREAM_HEADER), false);
});
