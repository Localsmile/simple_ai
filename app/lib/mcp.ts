import type {
  AppSettings,
  McpToolDefinition,
  OpenAIToolCall,
} from "../types";
import type { ApiTool } from "./api";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string;
  result?: {
    protocolVersion?: unknown;
    tools?: unknown;
    content?: unknown;
    isError?: unknown;
    [key: string]: unknown;
  };
  error?: { code: number; message: string; data?: unknown };
}

export interface McpCallResult {
  text: string;
  isError: boolean;
}

function parseSse(text: string): JsonRpcResponse[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith("data:"))
    .map((line) => line.trim().slice(5).trim())
    .filter((line) => line && line !== "[DONE]")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as JsonRpcResponse];
      } catch {
        return [];
      }
    });
}

function safeToolName(name: string, index: number): string {
  const normalized = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 52);
  return `mcp_${index}_${normalized}`.slice(0, 64);
}

export class McpClient {
  private readonly settings: AppSettings;
  private requestId = 0;
  private sessionId = "";
  private protocolVersion = "2025-06-18";
  private tools: McpToolDefinition[] = [];
  private safeToOriginal = new Map<string, string>();

  constructor(settings: AppSettings) {
    this.settings = settings;
  }

  private buildHeaders(): Headers {
    const headers = new Headers({
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": this.protocolVersion,
    });
    if (this.sessionId) headers.set("Mcp-Session-Id", this.sessionId);

    const token = this.settings.mcpToken.trim();
    if (token && this.settings.mcpAuthType === "bearer") {
      headers.set("Authorization", `Bearer ${token}`);
    } else if (token && this.settings.mcpAuthType === "x-api-key") {
      headers.set("x-api-key", token);
    }
    return headers;
  }

  private async post(
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<JsonRpcResponse | null> {
    let response: Response;
    try {
      response = await fetch(this.settings.mcpUrl.trim(), {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(payload),
        signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new Error(
        "MCP 연결 실패: 원격 HTTP 주소와 브라우저 CORS 허용 여부를 확인하십시오.",
      );
    }

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1000);
      throw new Error(`MCP ${response.status}: ${detail || response.statusText}`);
    }

    this.sessionId = response.headers.get("Mcp-Session-Id") || this.sessionId;
    if (response.status === 202 || response.status === 204) return null;

    const body = await response.text();
    if (!body.trim()) return null;
    const contentType = response.headers.get("content-type") || "";
    const responses = contentType.includes("text/event-stream")
      ? parseSse(body)
      : [JSON.parse(body) as JsonRpcResponse];
    const expectedId = payload.id;
    const result =
      responses.find((item) => item.id === expectedId) || responses.at(-1) || null;
    if (result?.error) throw new Error(`MCP 오류: ${result.error.message}`);
    return result;
  }

  async connect(signal?: AbortSignal): Promise<McpToolDefinition[]> {
    const initializeId = ++this.requestId;
    const initialized = await this.post(
      {
        jsonrpc: "2.0",
        id: initializeId,
        method: "initialize",
        params: {
          protocolVersion: this.protocolVersion,
          capabilities: {},
          clientInfo: { name: "simple-ai", version: "0.1.0" },
        },
      },
      signal,
    );

    const negotiated = initialized?.result?.protocolVersion;
    if (typeof negotiated === "string") this.protocolVersion = negotiated;

    await this.post(
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      signal,
    );

    const listId = ++this.requestId;
    const response = await this.post(
      { jsonrpc: "2.0", id: listId, method: "tools/list", params: {} },
      signal,
    );
    this.tools = Array.isArray(response?.result?.tools)
      ? (response?.result?.tools as McpToolDefinition[])
      : [];

    this.safeToOriginal.clear();
    this.tools.forEach((tool, index) => {
      this.safeToOriginal.set(safeToolName(tool.name, index), tool.name);
    });
    return this.tools;
  }

  toApiTools(): ApiTool[] {
    return this.tools.map((tool, index) => {
      const name = safeToolName(tool.name, index);
      this.safeToOriginal.set(name, tool.name);
      return {
        type: "function",
        function: {
          name,
          description: tool.description,
          parameters: tool.inputSchema || { type: "object", properties: {} },
        },
      };
    });
  }

  displayName(call: OpenAIToolCall): string {
    return this.safeToOriginal.get(call.function.name) || call.function.name;
  }

  async callTool(
    call: OpenAIToolCall,
    signal?: AbortSignal,
  ): Promise<McpCallResult> {
    const originalName = this.displayName(call);
    let args: Record<string, unknown> = {};
    try {
      args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      return { text: "도구 인자 JSON 파싱 실패", isError: true };
    }

    const id = ++this.requestId;
    const response = await this.post(
      {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: originalName, arguments: args },
      },
      signal,
    );

    const result = response?.result || {};
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .map((item: Record<string, unknown>) => {
        if (item.type === "text") return String(item.text || "");
        if (item.type === "resource") return JSON.stringify(item.resource || item);
        return JSON.stringify(item);
      })
      .filter(Boolean)
      .join("\n\n");

    return {
      text: text || JSON.stringify(result),
      isError: Boolean(result.isError),
    };
  }
}
