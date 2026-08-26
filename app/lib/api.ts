import type {
  AppSettings,
  ChatMessage,
  OpenAIToolCall,
  ProviderPreset,
  TokenUsage,
} from "../types";

export type ApiMessage = Record<string, unknown>;

export interface ApiTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface CompletionResult {
  content: string;
  reasoning?: string;
  usage?: TokenUsage;
  toolCalls: OpenAIToolCall[];
  rawAssistantMessage: Record<string, unknown>;
}

export interface CompletionOptions {
  settings: AppSettings;
  provider: ProviderPreset;
  messages: ApiMessage[];
  tools?: ApiTool[];
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
}

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  prompt_cache_hit_tokens?: number;
  cache_read_input_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  input_tokens_details?: { cached_tokens?: number };
}

interface RawContentPart {
  text?: string;
  content?: string;
}

interface RawMessage {
  content?: string | RawContentPart[];
  reasoning?: string;
  reasoning_content?: string;
  tool_calls?: OpenAIToolCall[];
}

interface ToolCallDelta {
  index?: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

interface RawCompletionPayload {
  choices?: Array<{
    message?: RawMessage;
    delta?: {
      content?: string;
      reasoning?: string;
      reasoning_content?: string;
      tool_calls?: ToolCallDelta[];
    };
  }>;
  usage?: RawUsage;
  error?: { message?: string } | string;
}

type ReasoningField = "reasoning" | "reasoning_content";

function readReasoning(
  value: Pick<RawMessage, ReasoningField>,
): { content: string; field?: ReasoningField } {
  if (typeof value.reasoning === "string" && value.reasoning) {
    return { content: value.reasoning, field: "reasoning" };
  }
  if (typeof value.reasoning_content === "string" && value.reasoning_content) {
    return { content: value.reasoning_content, field: "reasoning_content" };
  }
  return { content: "" };
}

export class ApiRequestError extends Error {
  readonly status: number;
  readonly requestBytes: number;

  constructor(status: number, message: string, requestBytes: number) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.requestBytes = requestBytes;
  }
}

export function isPayloadTooLargeError(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError && error.status === 413;
}

function normalizeUsage(usage?: RawUsage): TokenUsage | undefined {
  if (!usage) return undefined;
  const input = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const output = usage.completion_tokens ?? usage.output_tokens ?? 0;
  const cached =
    usage.prompt_tokens_details?.cached_tokens ??
    usage.input_tokens_details?.cached_tokens ??
    usage.prompt_cache_hit_tokens ??
    usage.cache_read_input_tokens ??
    0;
  return {
    input,
    output,
    total: usage.total_tokens ?? input + output,
    cached,
  };
}

export function resolveChatUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(normalized)) return normalized;
  return `${normalized}/chat/completions`;
}

function fileContext(message: ChatMessage): string {
  return (message.attachments || [])
    .filter((attachment) => attachment.kind === "text" && attachment.text)
    .map(
      (attachment) =>
        `<file name="${attachment.name}">\n${attachment.text}\n</file>`,
    )
    .join("\n\n");
}

export function buildApiMessages(
  messages: ChatMessage[],
  systemPrompt: string,
  visionEnabled: boolean,
  openingMessage = "",
): ApiMessage[] {
  const apiMessages: ApiMessage[] = [];
  if (systemPrompt.trim()) {
    apiMessages.push({ role: "system", content: systemPrompt.trim() });
  }
  if (openingMessage.trim()) {
    apiMessages.push({ role: "assistant", content: openingMessage.trim() });
  }

  for (const message of messages) {
    if (message.error) continue;

    if (message.role === "assistant") {
      apiMessages.push({ role: "assistant", content: message.content });
      continue;
    }

    const context = fileContext(message);
    const text = [message.content, context].filter(Boolean).join("\n\n");
    const images = (message.attachments || []).filter(
      (attachment) =>
        attachment.kind === "image" && attachment.dataUrl && visionEnabled,
    );

    if (!images.length) {
      apiMessages.push({ role: "user", content: text });
      continue;
    }

    apiMessages.push({
      role: "user",
      content: [
        { type: "text", text: text || "이미지 분석" },
        ...images.map((attachment) => ({
          type: "image_url",
          image_url: { url: attachment.dataUrl, detail: "auto" },
        })),
      ],
    });
  }

  return apiMessages;
}

function mergeToolCalls(
  target: OpenAIToolCall[],
  deltas: ToolCallDelta[],
): void {
  for (const delta of deltas) {
    const index = delta.index ?? 0;
    if (!target[index]) {
      target[index] = {
        id: delta.id || `tool_${index}`,
        type: "function",
        function: { name: "", arguments: "" },
      };
    }
    if (delta.id) target[index].id = delta.id;
    if (delta.function?.name) target[index].function.name += delta.function.name;
    if (delta.function?.arguments) {
      target[index].function.arguments += delta.function.arguments;
    }
  }
}

function apiError(status: number, body: string, requestBytes: number): ApiRequestError {
  let message = body;
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string } | string;
      message?: string;
    };
    message =
      (typeof parsed.error === "string" ? parsed.error : parsed.error?.message) ||
      parsed.message ||
      body;
  } catch {
    // Keep the original response text.
  }
  return new ApiRequestError(
    status,
    `API ${status}: ${message.slice(0, 1200)}`,
    requestBytes,
  );
}

function serializeCompletionRequest(
  settings: AppSettings,
  provider: ProviderPreset,
  messages: ApiMessage[],
  tools?: ApiTool[],
): string {
  const body: Record<string, unknown> = {
    model: provider.model.trim(),
    messages,
    temperature: settings.temperature,
    max_tokens: settings.maxTokens,
    stream: settings.stream,
  };

  if (settings.stream) body.stream_options = { include_usage: true };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  return JSON.stringify(body);
}

function parseJsonCompletion(payload: RawCompletionPayload): CompletionResult {
  const message = payload.choices?.[0]?.message || {};
  const reasoning = readReasoning(message);
  const content =
    typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map((part) => part?.text || part?.content || "").join("")
        : "";
  return {
    content,
    reasoning: reasoning.content || undefined,
    usage: normalizeUsage(payload.usage),
    toolCalls: message.tool_calls || [],
    rawAssistantMessage: {
      role: "assistant",
      content: message.content ?? content,
      ...(reasoning.field ? { [reasoning.field]: reasoning.content } : {}),
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    },
  };
}

export async function requestCompletion({
  settings,
  provider,
  messages,
  tools,
  signal,
  onDelta,
  onReasoningDelta,
}: CompletionOptions): Promise<CompletionResult> {
  const serializedBody = serializeCompletionRequest(settings, provider, messages, tools);

  const headers = new Headers({ "Content-Type": "application/json" });
  if (provider.apiKey.trim()) {
    headers.set("Authorization", `Bearer ${provider.apiKey.trim()}`);
  }

  let response: Response;
  try {
    response = await fetch(resolveChatUrl(provider.baseUrl), {
      method: "POST",
      headers,
      body: serializedBody,
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error(
      "API 연결 실패: 엔드포인트, 네트워크 상태, 브라우저 CORS 정책을 확인하십시오.",
    );
  }

  if (!response.ok) {
    const requestBytes = new TextEncoder().encode(serializedBody).byteLength;
    throw apiError(response.status, await response.text(), requestBytes);
  }

  const contentType = response.headers.get("content-type") || "";
  if (!settings.stream || !contentType.includes("text/event-stream")) {
    return parseJsonCompletion((await response.json()) as RawCompletionPayload);
  }

  if (!response.body) throw new Error("API 응답 스트림이 없습니다.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";
  let reasoningField: ReasoningField | undefined;
  let usage: TokenUsage | undefined;
  const toolCalls: OpenAIToolCall[] = [];

  const processLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") return;

    let payload: RawCompletionPayload;
    try {
      payload = JSON.parse(data) as RawCompletionPayload;
    } catch {
      return;
    }

    if (payload.error) {
      const message =
        typeof payload.error === "string"
          ? payload.error
          : payload.error?.message || JSON.stringify(payload.error);
      throw new Error(`API 스트림 오류: ${message}`);
    }

    const delta = payload.choices?.[0]?.delta || {};
    const reasoningDelta = readReasoning(delta);
    if (reasoningDelta.content) {
      reasoning += reasoningDelta.content;
      reasoningField ||= reasoningDelta.field;
      onReasoningDelta?.(reasoningDelta.content);
    }
    const text = typeof delta.content === "string" ? delta.content : "";
    if (text) {
      content += text;
      onDelta?.(text);
    }
    if (Array.isArray(delta.tool_calls)) mergeToolCalls(toolCalls, delta.tool_calls);
    if (payload.usage) usage = normalizeUsage(payload.usage);
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) processLine(line);
    if (done) break;
  }
  if (buffer) processLine(buffer);

  return {
    content,
    reasoning: reasoning || undefined,
    usage,
    toolCalls,
    rawAssistantMessage: {
      role: "assistant",
      content,
      ...(reasoningField ? { [reasoningField]: reasoning } : {}),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    },
  };
}
