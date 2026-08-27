import type {
  McpServerConfig, McpToolDefinition, McpConnectionState, OpenAIToolCall,
} from "../types";
import type { ApiTool } from "./api";

interface JsonRpcResponse {
  id?: number | string;
  result?: {
    protocolVersion?: unknown;
    tools?: unknown;
    nextCursor?: unknown;
    content?: unknown;
    isError?: unknown;
    [key: string]: unknown;
  };
  error?: { message: string };
}

export interface McpCallResult { text: string; isError: boolean }

function parseSse(text: string): JsonRpcResponse[] {
  return text.split(/\r?\n/).flatMap((line) => {
    if (!line.trim().startsWith("data:")) return [];
    try { return [JSON.parse(line.trim().slice(5).trim()) as JsonRpcResponse]; }
    catch { return []; }
  });
}

export function mcpConnectionKey(server: McpServerConfig): string {
  return JSON.stringify([server.url.trim(), server.authType, server.token]);
}

function abortError(): DOMException { return new DOMException("요청 중지", "AbortError"); }

function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(abortError()); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

export class McpClient {
  private requestId = 0;
  private sessionId = "";
  private protocolVersion = "2025-06-18";
  private tools: McpToolDefinition[] = [];

  constructor(private readonly server: McpServerConfig) {}

  private buildHeaders(): Headers {
    const headers = new Headers({
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": this.protocolVersion,
    });
    if (this.sessionId) headers.set("Mcp-Session-Id", this.sessionId);
    const token = this.server.token.trim();
    if (token && this.server.authType === "bearer") headers.set("Authorization", `Bearer ${token}`);
    else if (token && this.server.authType === "x-api-key") headers.set("x-api-key", token);
    return headers;
  }

  private async post(payload: Record<string, unknown>, signal?: AbortSignal): Promise<JsonRpcResponse | null> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) throw abortError();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, payload.method === "tools/call" ? 60_000 : 20_000);
    try {
      const response = await fetch(this.server.url.trim(), {
        method: "POST", headers: this.buildHeaders(), body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`MCP ${response.status}: ${(await response.text()).slice(0, 1000) || response.statusText}`);
      }
      this.sessionId = response.headers.get("Mcp-Session-Id") || this.sessionId;
      if (response.status === 202 || response.status === 204) return null;
      const body = await response.text();
      if (!body.trim()) return null;
      const responses = response.headers.get("content-type")?.includes("text/event-stream")
        ? parseSse(body) : [JSON.parse(body) as JsonRpcResponse];
      const result = responses.find((item) => item.id === payload.id);
      if (!result && payload.id !== undefined) throw new Error("MCP 응답 ID 불일치");
      if (result?.error) throw new Error(`MCP 오류: ${result.error.message}`);
      return result || null;
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (controller.signal.aborted) throw new Error("MCP 응답 시간 초과");
      if (error instanceof TypeError) throw new Error("MCP 연결 실패 · 주소 / 네트워크 / CORS 오류");
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  async connect(signal?: AbortSignal): Promise<McpToolDefinition[]> {
    const initialized = await this.post({
      jsonrpc: "2.0", id: ++this.requestId, method: "initialize",
      params: {
        protocolVersion: this.protocolVersion, capabilities: {},
        clientInfo: { name: "simple-ai", version: "0.1.0" },
      },
    }, signal);
    if (!initialized?.result) throw new Error("MCP 초기화 응답 없음");
    const negotiated = initialized.result.protocolVersion;
    if (typeof negotiated === "string") this.protocolVersion = negotiated;
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, signal);
    const tools = new Map<string, McpToolDefinition>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const response = await this.post({
        jsonrpc: "2.0", id: ++this.requestId, method: "tools/list",
        params: cursor ? { cursor } : {},
      }, signal);
      if (!Array.isArray(response?.result?.tools)) throw new Error("MCP 도구 목록 형식 오류");
      for (const tool of response.result.tools as McpToolDefinition[]) {
        if (tool && typeof tool.name === "string" && tool.name) tools.set(tool.name, tool);
      }
      const next = response.result.nextCursor;
      cursor = typeof next === "string" && next ? next : undefined;
      if (cursor && (cursors.has(cursor) || cursors.size >= 100 || tools.size > 10_000)) {
        throw new Error("MCP 도구 목록 페이지 한도 초과");
      }
      if (cursor) cursors.add(cursor);
    } while (cursor);
    this.tools = [...tools.values()];
    return this.tools;
  }

  async callTool(call: OpenAIToolCall, signal?: AbortSignal): Promise<McpCallResult> {
    const name = call.function.name;
    if (!this.tools.some((tool) => tool.name === name)) {
      return { text: "미등록 MCP 도구", isError: true };
    }
    let args: unknown;
    try { args = call.function.arguments ? JSON.parse(call.function.arguments) : {}; }
    catch { return { text: "도구 인자 JSON 파싱 실패", isError: true }; }
    if (!args || Array.isArray(args) || typeof args !== "object") {
      return { text: "도구 인자 형식 오류 · JSON 객체 필요", isError: true };
    }
    const response = await this.post({
      jsonrpc: "2.0", id: ++this.requestId, method: "tools/call",
      params: { name, arguments: args },
    }, signal);
    if (!response?.result) throw new Error("MCP 도구 실행 결과 없음");
    const result = response.result;
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content.map((item: Record<string, unknown>) => {
      if (item.type === "text") return String(item.text || "");
      if (item.type === "resource") return JSON.stringify(item.resource || item);
      return JSON.stringify(item);
    }).filter(Boolean).join("\n\n");
    return { text: text || JSON.stringify(result), isError: Boolean(result.isError) };
  }
}

interface ConnectedServer {
  server: McpServerConfig;
  client: McpClient;
  tools: McpToolDefinition[];
}

export class McpToolSession {
  private readonly routes = new Map<string, { client: McpClient; name: string; label: string }>();
  private readonly apiTools: ApiTool[] = [];

  constructor(servers: ConnectedServer[]) {
    servers.forEach(({ server, client, tools }, serverIndex) => {
      const allowed = server.selectedTools === null ? null : new Set(server.selectedTools);
      if (allowed && [...allowed].some((name) => !tools.some((tool) => tool.name === name))) {
        throw new Error(`${server.name}: 선택 도구가 서버 목록에 없음`);
      }
      tools.filter((tool) => !allowed || allowed.has(tool.name)).forEach((tool, index) => {
        const normalized = tool.name.replace(/[^a-zA-Z0-9_-]/g, "_");
        const alias = `mcp_${serverIndex}_${index}_${normalized}`.slice(0, 64);
        this.routes.set(alias, { client, name: tool.name, label: `${server.name} / ${tool.name}` });
        this.apiTools.push({
          type: "function",
          function: {
            name: alias,
            description: `[${server.name}] ${tool.description || tool.name}`,
            parameters: tool.inputSchema || { type: "object", properties: {} },
          },
        });
      });
    });
  }

  toApiTools(): ApiTool[] { return this.apiTools; }
  displayName(call: OpenAIToolCall): string { return this.routes.get(call.function.name)?.label || call.function.name; }

  async callTool(call: OpenAIToolCall, signal?: AbortSignal): Promise<McpCallResult> {
    const route = this.routes.get(call.function.name);
    if (!route) return { text: "현재 요청의 미선택 MCP 도구", isError: true };
    try {
      return await route.client.callTool({
        ...call, function: { ...call.function, name: route.name },
      }, signal);
    } catch (error) {
      if (signal?.aborted) throw abortError();
      return { text: error instanceof Error ? error.message : "MCP 도구 실행 실패", isError: true };
    }
  }
}

export class McpPool {
  private entries = new Map<string, {
    key: string; client: McpClient; controller: AbortController;
    promise: Promise<McpToolDefinition[]>;
  }>();

  invalidate(id: string): void {
    this.entries.get(id)?.controller.abort();
    this.entries.delete(id);
  }

  async connect(server: McpServerConfig, signal?: AbortSignal): Promise<ConnectedServer> {
    const key = mcpConnectionKey(server);
    let entry = this.entries.get(server.id);
    if (entry && entry.key !== key) { this.invalidate(server.id); entry = undefined; }
    if (!entry) {
      const client = new McpClient({ ...server });
      const controller = new AbortController();
      entry = { key, client, controller, promise: client.connect(controller.signal) };
      this.entries.set(server.id, entry);
      const captured = entry;
      void entry.promise.catch(() => {
        if (this.entries.get(server.id) === captured) this.entries.delete(server.id);
      });
    }
    const tools = await waitWithSignal(entry.promise, signal);
    return { server, client: entry.client, tools };
  }

  async prepare(
    servers: McpServerConfig[], signal?: AbortSignal,
    report?: (id: string, state: McpConnectionState) => void,
  ): Promise<McpToolSession> {
    const active = servers.filter((server) => server.enabled
      && (server.selectedTools === null || server.selectedTools.length > 0));
    if (!active.length) return new McpToolSession([]);
    if (active.some((server) => !server.url.trim())) throw new Error("활성 MCP 서버 URL 미설정");
    const connected: ConnectedServer[] = new Array(active.length);
    const failures: string[] = [];
    let cursor = 0;
    // Bounded parallel connection; tool execution remains in model-specified order.
    await Promise.all(Array.from({ length: Math.min(3, active.length) }, async () => {
      while (cursor < active.length) {
        if (signal?.aborted) throw abortError();
        const index = cursor++;
        const server = active[index];
        report?.(server.id, { status: "connecting", tools: [] });
        try {
          connected[index] = await this.connect(server, signal);
          report?.(server.id, { status: "connected", tools: connected[index].tools });
        } catch (error) {
          if (signal?.aborted) {
            report?.(server.id, { status: "error", tools: [], error: "MCP 연결 대기 중지" });
            throw abortError();
          }
          const detail = error instanceof Error ? error.message : "연결 실패";
          failures.push(`${server.name}: ${detail}`);
          report?.(server.id, { status: "error", tools: [], error: detail });
        }
      }
    }));
    if (failures.length) throw new Error(failures.join("\n"));
    return new McpToolSession(connected);
  }
}
