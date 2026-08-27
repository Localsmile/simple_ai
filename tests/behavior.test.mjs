import assert from "node:assert/strict";
import test from "node:test";
import { loadTs, memoryStorage } from "./load-ts.mjs";

const { DEFAULT_SETTINGS, DEFAULT_PROVIDER_PRESET, DEFAULT_REASONING } = loadTs("app/types.ts");

test("reasoning adapters emit only the selected wire format and preserve the default request", () => {
  const { serializeCompletionRequest } = loadTs("app/lib/api.ts");
  const request = (reasoning, extraBody = "") => JSON.parse(serializeCompletionRequest(
    DEFAULT_SETTINGS, { ...DEFAULT_PROVIDER_PRESET, extraBody }, [], undefined,
    { ...DEFAULT_REASONING, ...reasoning },
  ));
  assert.equal(request({}).reasoning_effort, undefined);
  assert.equal(request({ level: "high" }).reasoning_effort, "high");
  assert.deepEqual(request({ format: "reasoning", level: "low" }).reasoning, { effort: "low" });
  assert.deepEqual(request({ format: "thinking", level: "none" }).thinking, { type: "disabled" });
  assert.equal(request({ format: "thinking", level: "none" }, '{"reasoning_effort":"high"}').reasoning_effort, undefined);
  const budget = request({ format: "reasoning", level: "budget", budget: 4096 },
    '{"reasoning":{"effort":"high","enabled":false,"exclude":true}}');
  assert.deepEqual(budget.reasoning, { exclude: true, max_tokens: 4096 });
  assert.throws(() => request({ level: "budget" }), /토큰 예산/);
  assert.equal(request({}, '{"max_tokens":null}').max_tokens, undefined);
});

test("custom reasoning mapping handles numeric budgets and blocks protected request fields", () => {
  const { serializeCompletionRequest } = loadTs("app/lib/api.ts");
  const request = (customMapping, level = "budget") => JSON.parse(serializeCompletionRequest(
    DEFAULT_SETTINGS, DEFAULT_PROVIDER_PRESET, [], undefined,
    { ...DEFAULT_REASONING, format: "custom", level, budget: 512, customMapping },
  ));
  assert.deepEqual(request('{"budget":{"custom":{"enabled":true,"tokens":"$budget"}}}').custom,
    { enabled: true, tokens: 512 });
  assert.throws(() => request('{"budget":{"messages":[]}}'), /messages/);
  assert.throws(() => request('{"budget":{"custom":{"__proto__":{"polluted":true}}}}'), /__proto__/);
  assert.throws(() => request('{"low":{}}'), /budget/);
  assert.throws(() => request('oops'), /JSON/);
  assert.equal({}.polluted, undefined);
});

test("per-request reasoning overrides the preset without mutating it", async () => {
  let captured;
  const { requestCompletion } = loadTs("app/lib/api.ts", {
    fetch: async (_url, init) => {
      captured = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
        { headers: { "Content-Type": "application/json" } });
    },
  });
  const provider = { ...DEFAULT_PROVIDER_PRESET, baseUrl: "https://custom.test/v1", reasoning: { ...DEFAULT_REASONING, level: "high" } };
  await requestCompletion({ settings: DEFAULT_SETTINGS, provider, messages: [],
    reasoning: { ...DEFAULT_REASONING, level: "low" } });
  assert.equal(captured.reasoning_effort, "low");
  assert.equal(provider.reasoning.level, "high");
});

test("mobile Enter creates a newline; explicit shortcuts and IME remain safe", () => {
  const { shouldSendMessage, enterSendsMessage } = loadTs("app/lib/input.ts");
  const enter = { key: "Enter", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, isComposing: false };
  assert.equal(shouldSendMessage(enter, "auto", true), false);
  assert.equal(shouldSendMessage(enter, "auto", false), true);
  assert.equal(shouldSendMessage(enter, "ctrl-enter", false), false);
  assert.equal(shouldSendMessage({ ...enter, ctrlKey: true }, "ctrl-enter", true), true);
  assert.equal(shouldSendMessage({ ...enter, metaKey: true }, "auto", true), true);
  for (const patch of [{ isComposing: true }, { keyCode: 229 }, { shiftKey: true }, { altKey: true }]) {
    assert.equal(shouldSendMessage({ ...enter, ...patch }, "enter", false), false);
  }
  assert.equal(enterSendsMessage("enter", true), true);
});

test("reasoning details survive JSON and streaming tool rounds without exposing encrypted data", async () => {
  const details = [
    { type: "reasoning.text", text: "public thought", signature: "signature", index: 0 },
    { type: "reasoning.encrypted", data: "opaque-value", id: "encrypted-id", index: 1 },
  ];
  const calls = [{ id: "tool-id", type: "function", function: { name: "read", arguments: "{}" } }];
  for (const stream of [false, true]) {
    const { requestCompletion } = loadTs("app/lib/api.ts", {
      fetch: async () => stream
        ? new Response([
            ...details.map((detail) => `data: ${JSON.stringify({ choices: [{ delta: { reasoning_details: [detail] } }] })}\n\n`),
            `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: calls }, finish_reason: "tool_calls" }] })}\n\n`,
            "data: [DONE]\n\n",
          ].join(""), { headers: { "Content-Type": "text/event-stream" } })
        : new Response(JSON.stringify({ choices: [{ message: { content: null, reasoning_details: details, tool_calls: calls } }] }),
            { headers: { "Content-Type": "application/json" } }),
    });
    const result = await requestCompletion({ settings: { ...DEFAULT_SETTINGS, stream }, provider: DEFAULT_PROVIDER_PRESET, messages: [] });
    assert.deepEqual(result.rawAssistantMessage.reasoning_details, details);
    assert.deepEqual(result.rawAssistantMessage.tool_calls, calls);
    assert.equal(result.rawAssistantMessage.reasoning, undefined);
    assert.equal(result.reasoning, "public thought");
  }
});

const server = (id, extra = {}) => ({ id, name: id, url: `https://${id}.test/mcp`, authType: "none",
  token: "", enabled: true, selectedTools: ["read"], ...extra });
const tool = (name) => ({ name, description: `${name} description`, inputSchema: { type: "object", properties: {} } });
function mockMcp() {
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers });
    if (url.includes("broken")) return new Response("unavailable", { status: 503 });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    let result;
    if (body.method === "initialize") result = { protocolVersion: "2025-06-18" };
    if (body.method === "tools/list") result = body.params.cursor
      ? { tools: [tool("write")] } : { tools: [tool("read")], nextCursor: "next" };
    if (body.method === "tools/call") result = { content: [{ type: "text", text: `${url}/${body.params.name}` }] };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
      { headers: { "Content-Type": "application/json", "Mcp-Session-Id": "mock-session" } });
  };
  return { fetch, calls };
}

test("multiple MCP servers namespace duplicate names and route only selected tools", async () => {
  const mock = mockMcp();
  const { McpPool } = loadTs("app/lib/mcp.ts", { fetch: mock.fetch });
  const pool = new McpPool();
  const session = await pool.prepare([server("a", { authType: "bearer", token: "test-token" }), server("b")], 24);
  const tools = session.toApiTools();
  assert.equal(tools.length, 2);
  assert.notEqual(tools[0].function.name, tools[1].function.name);
  const call = (name) => ({ id: "call", type: "function", function: { name, arguments: '{"path":"README.md"}' } });
  for (const [index, id] of ["a", "b"].entries()) {
    const result = await session.callTool(call(tools[index].function.name));
    assert.equal(result.text, `https://${id}.test/mcp/read`);
    assert.equal(session.displayName(call(tools[index].function.name)), `${id} / read`);
  }
  const count = mock.calls.length;
  assert.equal((await session.callTool(call("write"))).isError, true);
  assert.equal(mock.calls.length, count);
  assert.equal(mock.calls.find((item) => item.url.includes("a.test")).headers.get("Authorization"), "Bearer test-token");
  assert.equal(mock.calls.find((item) => item.url.includes("b.test")).headers.get("Authorization"), null);
  assert.ok(mock.calls.some((item) => item.body.params?.cursor === "next"));
});

test("MCP connection cache survives tool selection changes, but not endpoint changes", async () => {
  const mock = mockMcp();
  const { McpPool } = loadTs("app/lib/mcp.ts", { fetch: mock.fetch });
  const pool = new McpPool();
  await pool.prepare([server("a")], 24);
  const changed = await pool.prepare([server("a", { selectedTools: ["write"] })], 24);
  assert.equal(mock.calls.filter((item) => item.body.method === "initialize").length, 1);
  assert.match(changed.toApiTools()[0].function.name, /write$/);
  await pool.prepare([server("a", { url: "https://new.test/mcp" })], 24);
  assert.equal(mock.calls.filter((item) => item.body.method === "initialize").length, 2);
});

test("MCP selection and total limit never silently send unselected or partial tool sets", async () => {
  const mock = mockMcp();
  const { McpPool } = loadTs("app/lib/mcp.ts", { fetch: mock.fetch });
  const pool = new McpPool();
  await assert.rejects(pool.prepare([server("a", { selectedTools: [] })], 24), /도구를 선택/);
  assert.equal(mock.calls.length, 0);
  await assert.rejects(pool.prepare([server("a", { selectedTools: null })], 1), /전송 한도/);
  await assert.rejects(pool.prepare([server("a", { selectedTools: ["removed"] })], 24), /사라졌습니다/);
  await assert.rejects(pool.prepare([server("a"), server("broken")], 24), /broken/);
  const valid = await pool.prepare([server("a"), server("broken", { enabled: false })], 24);
  assert.equal(valid.toApiTools().length, 1);
});

test("MCP waiting is cancellable and invalidation aborts the pending connection", async () => {
  let aborted = false;
  const { McpPool } = loadTs("app/lib/mcp.ts", {
    fetch: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => { aborted = true; reject(new DOMException("Aborted", "AbortError")); });
    }),
  });
  const pool = new McpPool();
  const controller = new AbortController();
  const states = [];
  const waiting = pool.prepare([server("slow")], 24, controller.signal, (_id, state) => states.push(state.status));
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  assert.deepEqual(states, ["connecting", "error"]);
  pool.invalidate("slow");
  assert.equal(aborted, true);
});

test("MCP discovery limits concurrent connections and rejects repeated pagination cursors", async () => {
  const mock = mockMcp();
  let active = 0, peak = 0;
  const { McpPool } = loadTs("app/lib/mcp.ts", {
    fetch: async (url, init) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      const response = await mock.fetch(url, init);
      active--;
      return response;
    },
  });
  const session = await new McpPool().prepare(Array.from({ length: 7 }, (_, i) => server(`server${i}`)), 24);
  assert.equal(session.toApiTools().length, 7);
  assert.equal(peak, 3);
  const repeated = loadTs("app/lib/mcp.ts", {
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      return body.method === "tools/list"
        ? new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [tool("read")], nextCursor: "repeat" } }),
            { headers: { "Content-Type": "application/json" } })
        : mock.fetch(url, init);
    },
  });
  await assert.rejects(new repeated.McpPool().prepare([server("pages")], 24), /페이지 한도/);
});

test("legacy MCP settings and credentials migrate without exposing tokens in normal settings", () => {
  const localStorage = memoryStorage(), sessionStorage = memoryStorage();
  localStorage.setItem("simple-ai:settings", JSON.stringify({ mcpEnabled: true, mcpUrl: "https://legacy.test/mcp", mcpAuthType: "bearer" }));
  localStorage.setItem("simple-ai:mcp-token", "test-legacy-token");
  const { loadSettings, saveSettings } = loadTs("app/lib/storage.ts", { window: {}, localStorage, sessionStorage });
  const migrated = loadSettings();
  assert.equal(migrated.mcpServers.length, 1);
  assert.equal(migrated.mcpServers[0].token, "test-legacy-token");
  assert.equal(migrated.mcpServers[0].selectedTools, null);
  saveSettings(migrated);
  assert.doesNotMatch(localStorage.getItem("simple-ai:settings"), /test-legacy-token|mcpUrl|mcpToken/);
  assert.equal(localStorage.getItem("simple-ai:mcp-token"), null);
  saveSettings({ ...migrated, rememberCredentials: false });
  assert.equal(localStorage.getItem("simple-ai:mcp-tokens"), null);
  assert.match(sessionStorage.getItem("simple-ai:mcp-tokens"), /test-legacy-token/);
  assert.equal(loadSettings().mcpServers[0].token, "test-legacy-token");
  saveSettings({ ...migrated, mcpServers: [] });
  assert.equal(loadSettings().mcpServers.length, 0);
  assert.equal(localStorage.getItem("simple-ai:mcp-tokens"), "{}");
});
