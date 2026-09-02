import type {
  AppSettings,
  ChatMessage,
  OpenAIToolCall,
  ProviderPreset,
  ReasoningSettings,
  TokenUsage,
} from "../types";
import { mergeRequestOptions, reasoningOptions } from "./reasoning";
import { normalizeConnectionMode, resolveChatUrl, resolveCompletionUrl, UPSTREAM_HEADER } from "./connection";
export { resolveChatUrl } from "./connection";

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
  finishReason?: string;
  toolCalls: OpenAIToolCall[];
  rawAssistantMessage: Record<string, unknown>;
  diagnostics: CompletionDiagnostics;
}

export interface CompletionDiagnostics {
  id?: string;
  model?: string;
  provider?: string;
  requestBytes?: number;
  receivedEvents?: number;
  malformedEvents?: number;
}

export interface CompletionOptions {
  settings: AppSettings;
  provider: ProviderPreset;
  reasoning?: ReasoningSettings;
  messages: ApiMessage[];
  tools?: ApiTool[];
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
  onRetry?: () => void;
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
  completion_tokens_details?: { reasoning_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

interface RawContentPart {
  text?: string;
  content?: string;
  output_text?: string;
}

interface RawMessage {
  content?: string | RawContentPart[];
  reasoning?: string;
  reasoning_content?: string;
  reasoning_details?: Record<string, unknown>[];
  tool_calls?: OpenAIToolCall[];
}

interface ToolCallDelta {
  index?: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

interface RawCompletionPayload {
  id?: string;
  model?: string;
  provider?: string;
  choices?: Array<{
    message?: RawMessage;
    finish_reason?: string | null;
    text?: string;
    delta?: {
      content?: string | RawContentPart[];
      output_text?: string;
      reasoning?: string;
      reasoning_content?: string;
      reasoning_details?: Record<string, unknown>[];
      tool_calls?: ToolCallDelta[];
      finish_reason?: string | null;
    };
  }>;
  usage?: RawUsage;
  error?: { message?: string } | string;
  openrouter_metadata?: {
    endpoints?: { available?: Array<{ provider?: string; selected?: boolean }> };
    attempts?: Array<{ provider?: string; status?: number }>;
  };
}

type ReasoningField = "reasoning" | "reasoning_content";

function readReasoning(
  value: Pick<RawMessage, ReasoningField | "reasoning_details">,
): { content: string; field?: ReasoningField } {
  if (typeof value.reasoning === "string" && value.reasoning) {
    return { content: value.reasoning, field: "reasoning" };
  }
  if (typeof value.reasoning_content === "string" && value.reasoning_content) {
    return { content: value.reasoning_content, field: "reasoning_content" };
  }
  const details = Array.isArray(value.reasoning_details) ? value.reasoning_details : [];
  return { content: details.map((detail) => {
    if (detail?.type === "reasoning.text" && typeof detail.text === "string") return detail.text;
    if (detail?.type === "reasoning.summary" && typeof detail.summary === "string") return detail.summary;
    return "";
  }).join("") };
}

function readContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    if (!part || typeof part !== "object") return "";
    const item = part as RawContentPart;
    return typeof item.text === "string"
      ? item.text
      : typeof item.content === "string"
        ? item.content
        : typeof item.output_text === "string"
          ? item.output_text
          : "";
  }).join("");
}

function selectedProvider(payload: RawCompletionPayload): string | undefined {
  const metadata = payload.openrouter_metadata;
  return payload.provider
    || metadata?.endpoints?.available?.find((endpoint) => endpoint.selected)?.provider
    || [...(metadata?.attempts || [])].reverse().find((attempt) => attempt.status === 200)?.provider;
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
    reasoning:
      usage.completion_tokens_details?.reasoning_tokens
      ?? usage.output_tokens_details?.reasoning_tokens
      ?? 0,
  };
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
      // A reasoning-only or interrupted response is not a valid assistant turn.
      // Re-sending an empty turn can make some chat templates produce another empty answer.
      if (message.content.trim()) {
        apiMessages.push({ role: "assistant", content: message.content });
      }
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

export function serializeCompletionRequest(
  settings: AppSettings,
  provider: ProviderPreset,
  messages: ApiMessage[],
  tools?: ApiTool[],
  reasoning: ReasoningSettings = provider.reasoning,
  streamOverride?: boolean,
): string {
  const stream = streamOverride ?? settings.stream;
  let extraBody: Record<string, unknown> = {};
  if (provider.extraBody.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(provider.extraBody);
    } catch {
      throw new Error("추가 요청 JSON 문법 오류");
    }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("추가 요청 JSON 형식 오류 · 객체 필요");
    }
    extraBody = parsed as Record<string, unknown>;
  }

  const body: Record<string, unknown> = {
    model: provider.model.trim(),
    messages,
    temperature: settings.temperature,
    max_tokens: settings.maxTokens,
    stream,
  };
  mergeRequestOptions(body, extraBody);
  const overrides = reasoningOptions(reasoning);
  if (reasoning.format === "reasoning" && reasoning.level !== "default"
    && body.reasoning && typeof body.reasoning === "object") {
    const existing = body.reasoning as Record<string, unknown>;
    delete existing.effort;
    delete existing.max_tokens;
    delete existing.enabled;
  }
  mergeRequestOptions(body, overrides);

  if (streamOverride !== undefined) body.stream = stream;
  if (stream) body.stream_options = { include_usage: true };
  else if (streamOverride !== undefined) delete body.stream_options;
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  return JSON.stringify(body);
}

function parseJsonCompletion(
  payload: RawCompletionPayload,
  response: Response,
  requestBytes: number,
): CompletionResult {
  if (payload.error) {
    const message = typeof payload.error === "string"
      ? payload.error
      : payload.error.message || JSON.stringify(payload.error);
    throw new Error(`API 응답 오류: ${message}`);
  }
  const message = payload.choices?.[0]?.message || {};
  const reasoning = readReasoning(message);
  const content = readContent(message.content) || readContent(payload.choices?.[0]?.text);
  return {
    content,
    reasoning: reasoning.content || undefined,
    usage: normalizeUsage(payload.usage),
    finishReason: payload.choices?.[0]?.finish_reason || undefined,
    toolCalls: message.tool_calls || [],
    rawAssistantMessage: {
      role: "assistant",
      content: message.content ?? content,
      ...(reasoning.field ? { [reasoning.field]: reasoning.content } : {}),
      ...(Array.isArray(message.reasoning_details) ? { reasoning_details: message.reasoning_details } : {}),
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    },
    diagnostics: {
      id: payload.id || response.headers.get("x-generation-id") || response.headers.get("x-request-id") || undefined,
      model: payload.model,
      provider: selectedProvider(payload),
      requestBytes,
    },
  };
}

async function requestCompletionOnce({
  settings,
  provider,
  reasoning: reasoningSettings,
  messages,
  tools,
  signal,
  onDelta,
  onReasoningDelta,
}: CompletionOptions, streamOverride?: boolean): Promise<CompletionResult> {
  const requestStream = streamOverride ?? settings.stream;
  const requestUrl = resolveCompletionUrl(provider);
  const useProxy = normalizeConnectionMode(provider.connectionMode) === "cors-proxy";
  const serializedBody = serializeCompletionRequest(
    settings, provider, messages, tools, reasoningSettings, streamOverride,
  );
  const requestBytes = new TextEncoder().encode(serializedBody).byteLength;

  const headers = new Headers({ "Content-Type": "application/json" });
  if (useProxy) headers.set(UPSTREAM_HEADER, resolveChatUrl(provider.baseUrl));
  if (provider.apiKey.trim()) {
    headers.set("Authorization", `Bearer ${provider.apiKey.trim()}`);
  }

  let response: Response;
  try {
    response = await fetch(requestUrl, {
      method: "POST",
      headers,
      body: serializedBody,
      signal,
      ...(useProxy ? { credentials: "omit" as const, redirect: "error" as const } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error(
      useProxy
        ? "Cloudflare 중계 연결 실패 · 네트워크 / 접근 허용 출처 확인"
        : "API 연결 실패 · 엔드포인트 / 네트워크 / CORS 오류",
    );
  }

  if (!response.ok) {
    throw apiError(response.status, await response.text(), requestBytes);
  }

  const contentType = response.headers.get("content-type") || "";
  if (!requestStream || !contentType.includes("text/event-stream")) {
    let payload: RawCompletionPayload;
    try {
      payload = (await response.json()) as RawCompletionPayload;
    } catch {
      throw new Error("API 응답 형식 오류 · JSON 또는 SSE 필요");
    }
    return parseJsonCompletion(payload, response, requestBytes);
  }

  if (!response.body) throw new Error("API 응답 스트림 없음");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";
  let wireReasoning = "";
  let reasoningField: ReasoningField | undefined;
  let usage: TokenUsage | undefined;
  let finishReason: string | undefined;
  let responseId = response.headers.get("x-generation-id") || response.headers.get("x-request-id") || undefined;
  let responseModel: string | undefined;
  let responseProvider: string | undefined;
  let receivedEvents = 0;
  let malformedEvents = 0;
  const toolCalls: OpenAIToolCall[] = [];
  const reasoningDetails: Record<string, unknown>[] = [];

  const processLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") return;

    let payload: RawCompletionPayload;
    try {
      payload = JSON.parse(data) as RawCompletionPayload;
    } catch {
      malformedEvents += 1;
      return;
    }

    receivedEvents += 1;

    if (payload.error) {
      const message =
        typeof payload.error === "string"
          ? payload.error
          : payload.error?.message || JSON.stringify(payload.error);
      throw new Error(`API 스트림 오류: ${message}`);
    }

    const choice = payload.choices?.[0];
    const delta = choice?.delta || {};
    responseId = payload.id || responseId;
    responseModel = payload.model || responseModel;
    responseProvider = selectedProvider(payload) || responseProvider;
    if (choice?.finish_reason || delta.finish_reason) {
      finishReason = choice?.finish_reason || delta.finish_reason || undefined;
    }
    const reasoningDelta = readReasoning(delta);
    if (reasoningDelta.content) {
      reasoning += reasoningDelta.content;
      reasoningField ||= reasoningDelta.field;
      if (reasoningDelta.field) wireReasoning += reasoningDelta.content;
      onReasoningDelta?.(reasoningDelta.content);
    }
    // Keep the provider's signed/encrypted sequence intact for the next tool round.
    if (Array.isArray(delta.reasoning_details)) reasoningDetails.push(...delta.reasoning_details);
    const text = readContent(delta.content) || readContent(delta.output_text) || readContent(choice?.text);
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
    finishReason,
    toolCalls,
    rawAssistantMessage: {
      role: "assistant",
      content,
      ...(reasoningField ? { [reasoningField]: wireReasoning } : {}),
      ...(reasoningDetails.length ? { reasoning_details: reasoningDetails } : {}),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    },
    diagnostics: {
      id: responseId,
      model: responseModel,
      provider: responseProvider,
      requestBytes,
      receivedEvents,
      malformedEvents,
    },
  };
}

function isUsableCompletion(result: CompletionResult): boolean {
  if (result.content.trim() || result.toolCalls.length) return true;
  return result.finishReason === "content_filter";
}

function isRetryableEmptyCompletion(result: CompletionResult): boolean {
  if (result.reasoning?.trim() || (result.usage?.output || 0) > 0) return false;
  return !result.finishReason || result.finishReason === "stop" || result.finishReason === "error";
}

function formatDiagnosticCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function describeEmptyCompletion(label: string, result: CompletionResult): string {
  const parts = [
    label,
    result.diagnostics.provider || "공급자 미확인",
    result.finishReason ? `종료 ${result.finishReason}` : "종료 사유 없음",
    result.usage ? `IN ${formatDiagnosticCount(result.usage.input)}` : "",
    result.usage ? `OUT ${formatDiagnosticCount(result.usage.output)}` : "",
    result.diagnostics.id ? `ID ${result.diagnostics.id}` : "",
    result.diagnostics.malformedEvents ? `손상 이벤트 ${result.diagnostics.malformedEvents}` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

function describeRequest(options: CompletionOptions, result: CompletionResult): string {
  const bytes = result.diagnostics.requestBytes;
  const reasoning = options.reasoning || options.provider.reasoning;
  return [
    `요청 ${options.messages.length}개 메시지`,
    `${options.tools?.length || 0}개 도구`,
    bytes ? `${formatDiagnosticCount(bytes)}B` : "",
    `MAX ${formatDiagnosticCount(options.settings.maxTokens)}`,
    `추론 ${reasoning.format}/${reasoning.level}`,
  ].filter(Boolean).join(" · ");
}

export async function requestCompletion(options: CompletionOptions): Promise<CompletionResult> {
  const first = await requestCompletionOnce(options);
  if (isUsableCompletion(first)) return first;
  if (!isRetryableEmptyCompletion(first)) {
    const kind = first.reasoning?.trim() ? "thinking만 수신" : "본문 없음";
    throw new Error(
      `API 응답 본문 없음 · ${kind} · ${describeEmptyCompletion("1차", first)} · ${describeRequest(options, first)}`,
    );
  }

  options.onRetry?.();
  const second = await requestCompletionOnce({
    ...options,
    onDelta: undefined,
    onReasoningDelta: undefined,
    onRetry: undefined,
  }, false);
  if (isUsableCompletion(second)) return second;

  throw new Error([
    "API 빈 응답",
    describeEmptyCompletion("1차", first),
    describeEmptyCompletion("2차", second),
    describeRequest(options, second),
  ].join(" · "));
}
