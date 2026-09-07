import type {
  AppSettings,
  ChatMessage,
  OpenAIToolCall,
  CompletionProvider,
  ReasoningSettings,
  TokenUsage,
} from "../types";
import { mergeRequestOptions, reasoningOptions } from "./reasoning";
import {
  completionApiForUrl,
  isOpenCodeTarget,
  normalizeConnectionMode,
  OPENCODE_CLIENT_HEADER,
  OPENCODE_SESSION_HEADER,
  resolveCompletionTargets,
  resolveCompletionUrl,
  UPSTREAM_HEADER,
  type CompletionApi,
} from "./connection";
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
  rawAssistantMessages?: Record<string, unknown>[];
  diagnostics: CompletionDiagnostics;
}

export interface CompletionDiagnostics {
  id?: string;
  model?: string;
  requestBytes?: number;
  receivedEvents?: number;
  malformedEvents?: number;
}

export interface CompletionOptions {
  settings: AppSettings;
  provider: CompletionProvider;
  reasoning?: ReasoningSettings;
  messages: ApiMessage[];
  tools?: ApiTool[];
  sessionId?: string;
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
  cache_creation_input_tokens?: number;
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
}

interface RawResponseOutputItem extends Record<string, unknown> {
  id?: string;
  type?: string;
  content?: Array<{ type?: string; text?: string; refusal?: string }>;
  summary?: Array<{ type?: string; text?: string }>;
  call_id?: string;
  name?: string;
  arguments?: string;
}

interface RawResponsePayload {
  id?: string;
  model?: string;
  status?: string;
  output?: RawResponseOutputItem[];
  output_text?: string;
  usage?: RawUsage;
  error?: { message?: string } | string | null;
  incomplete_details?: { reason?: string } | null;
}

interface RawResponseEvent {
  type?: string;
  delta?: string;
  message?: string;
  item?: RawResponseOutputItem;
  response?: RawResponsePayload;
  error?: { message?: string } | string;
}

interface RawMessagesContentBlock extends Record<string, unknown> {
  type?: string;
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface RawMessagesPayload {
  id?: string;
  model?: string;
  content?: RawMessagesContentBlock[];
  stop_reason?: string | null;
  usage?: RawUsage;
  error?: { message?: string } | string;
}

interface RawMessagesEvent {
  type?: string;
  index?: number;
  message?: RawMessagesPayload;
  content_block?: RawMessagesContentBlock;
  delta?: RawMessagesContentBlock & { stop_reason?: string | null; partial_json?: string };
  usage?: RawUsage;
  error?: { message?: string } | string;
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
  if (/^\s*(?:<!doctype\s+html|<html)\b/i.test(body)) {
    return new ApiRequestError(status, `API ${status}: HTML 응답 · 엔드포인트 확인`, requestBytes);
  }
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

function responsesInput(messages: ApiMessage[]): ApiMessage[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
      };
    }
    if (typeof message.type === "string") return message;
    if (!Array.isArray(message.content)) return message;
    return {
      ...message,
      content: message.content.map((part) => {
        if (!part || typeof part !== "object") return part;
        const value = part as Record<string, unknown>;
        if (value.type === "text") return { type: "input_text", text: value.text };
        if (value.type === "image_url") {
          const image = value.image_url as { url?: unknown; detail?: unknown } | undefined;
          return {
            type: "input_image",
            image_url: image?.url,
            ...(typeof image?.detail === "string" ? { detail: image.detail } : {}),
          };
        }
        return part;
      }),
    };
  });
}

function responsesTools(tools: ApiTool[]): Record<string, unknown>[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.function.name,
    ...(tool.function.description ? { description: tool.function.description } : {}),
    parameters: tool.function.parameters,
  }));
}

function messagesContent(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((part) => {
    if (!part || typeof part !== "object") return part;
    const item = part as Record<string, unknown>;
    if (item.type === "image_url") {
      const image = item.image_url as { url?: unknown } | undefined;
      const url = typeof image?.url === "string" ? image.url : "";
      const data = url.match(/^data:([^;,]+);base64,(.+)$/s);
      return data
        ? { type: "image", source: { type: "base64", media_type: data[1], data: data[2] } }
        : { type: "image", source: { type: "url", url } };
    }
    return item;
  });
}

function messagesRequest(messages: ApiMessage[]): { system?: string; messages: ApiMessage[] } {
  const system = messages.filter((message) => message.role === "system")
    .map((message) => readContent(message.content)).filter(Boolean).join("\n\n");
  const output = messages.filter((message) => message.role !== "system").map((message) => {
    if (message.role === "tool") {
      return {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: message.tool_call_id,
          content: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
        }],
      };
    }
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls as OpenAIToolCall[] : [];
    const content = messagesContent(message.content);
    if (!toolCalls.length) return { ...message, content };
    const blocks = Array.isArray(content)
      ? [...content]
      : typeof content === "string" && content ? [{ type: "text", text: content }] : [];
    return {
      role: message.role,
      content: [
        ...blocks,
        ...toolCalls.map((call) => {
          let input: unknown = {};
          try { input = JSON.parse(call.function.arguments || "{}"); }
          catch { input = { value: call.function.arguments }; }
          return { type: "tool_use", id: call.id, name: call.function.name, input };
        }),
      ],
    };
  });
  return { ...(system ? { system } : {}), messages: output };
}

function messagesTools(tools: ApiTool[]): Record<string, unknown>[] {
  return tools.map((tool) => ({
    name: tool.function.name,
    ...(tool.function.description ? { description: tool.function.description } : {}),
    input_schema: tool.function.parameters,
  }));
}

export function serializeCompletionRequest(
  settings: AppSettings,
  provider: CompletionProvider,
  messages: ApiMessage[],
  tools?: ApiTool[],
  reasoning: ReasoningSettings = provider.reasoning,
  streamOverride?: boolean,
  apiOverride?: CompletionApi,
): string {
  const stream = streamOverride ?? settings.stream;
  const api = apiOverride || completionApiForUrl(provider.baseUrl);
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

  const messagesPayload = api === "messages" ? messagesRequest(messages) : undefined;
  const body: Record<string, unknown> = api === "responses"
    ? {
        model: provider.model.trim(),
        input: responsesInput(messages),
        temperature: settings.temperature,
        max_output_tokens: settings.maxTokens,
        stream,
      }
    : api === "messages"
      ? {
        model: provider.model.trim(),
        ...messagesPayload,
        temperature: settings.temperature,
        max_tokens: settings.maxTokens,
        stream,
      }
      : {
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
  if (stream && api === "chat-completions") body.stream_options = { include_usage: true };
  else if (streamOverride !== undefined) delete body.stream_options;
  if (tools?.length) {
    body.tools = api === "responses" ? responsesTools(tools)
      : api === "messages" ? messagesTools(tools) : tools;
    body.tool_choice = api === "messages" ? { type: "auto" } : "auto";
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
      requestBytes,
    },
  };
}

function responseOutputText(payload: RawResponsePayload): string {
  const content = (payload.output || []).flatMap((item) => item.type === "message" ? item.content || [] : []);
  return content.map((part) => part.type === "refusal" ? part.refusal || "" : part.text || "").join("")
    || payload.output_text || "";
}

function responseReasoning(payload: RawResponsePayload): string {
  return (payload.output || []).filter((item) => item.type === "reasoning").flatMap((item) => [
    ...(item.summary || []),
    ...(item.content || []),
  ]).map((part) => part.text || "").join("");
}

function responseToolCalls(payload: RawResponsePayload): OpenAIToolCall[] {
  return (payload.output || []).filter((item) => item.type === "function_call")
    .map((item, index) => ({
      id: item.call_id || item.id || `tool_${index}`,
      type: "function" as const,
      function: {
        name: item.name || "",
        arguments: item.arguments || "",
      },
    }));
}

function responseFinishReason(payload: RawResponsePayload, toolCalls: OpenAIToolCall[]): string | undefined {
  if (toolCalls.length) return "tool_calls";
  if (payload.status === "completed") return "stop";
  if (payload.status === "incomplete") {
    return payload.incomplete_details?.reason === "max_output_tokens"
      ? "length" : payload.incomplete_details?.reason || "incomplete";
  }
  if (payload.status === "failed" || payload.error) return "error";
  return payload.status;
}

function parseJsonResponse(
  payload: RawResponsePayload,
  response: Response,
  requestBytes: number,
): CompletionResult {
  if (payload.error) {
    const message = typeof payload.error === "string"
      ? payload.error : payload.error.message || JSON.stringify(payload.error);
    throw new Error(`API 응답 오류: ${message}`);
  }
  const content = responseOutputText(payload);
  const reasoning = responseReasoning(payload);
  const toolCalls = responseToolCalls(payload);
  const rawAssistantMessages = (payload.output || []).filter((item) => item && typeof item === "object");
  return {
    content,
    reasoning: reasoning || undefined,
    usage: normalizeUsage(payload.usage),
    finishReason: responseFinishReason(payload, toolCalls),
    toolCalls,
    rawAssistantMessage: { role: "assistant", content },
    rawAssistantMessages,
    diagnostics: {
      id: payload.id || response.headers.get("x-generation-id") || response.headers.get("x-request-id") || undefined,
      model: payload.model,
      requestBytes,
    },
  };
}

function messagesText(blocks: RawMessagesContentBlock[] = []): string {
  return blocks.filter((block) => block.type === "text").map((block) => block.text || "").join("");
}

function messagesReasoning(blocks: RawMessagesContentBlock[] = []): string {
  return blocks.filter((block) => block.type === "thinking").map((block) => block.thinking || "").join("");
}

function messagesToolCalls(blocks: RawMessagesContentBlock[] = []): OpenAIToolCall[] {
  return blocks.filter((block) => block.type === "tool_use").map((block, index) => ({
    id: block.id || `tool_${index}`,
    type: "function" as const,
    function: { name: block.name || "", arguments: JSON.stringify(block.input ?? {}) },
  }));
}

function messagesFinishReason(reason?: string | null): string | undefined {
  if (reason === "tool_use") return "tool_calls";
  if (reason === "max_tokens") return "length";
  if (reason === "end_turn" || reason === "stop_sequence") return "stop";
  return reason || undefined;
}

function parseJsonMessages(
  payload: RawMessagesPayload,
  response: Response,
  requestBytes: number,
): CompletionResult {
  if (payload.error) {
    const message = typeof payload.error === "string"
      ? payload.error : payload.error.message || JSON.stringify(payload.error);
    throw new Error(`API 응답 오류: ${message}`);
  }
  const blocks = payload.content || [];
  const content = messagesText(blocks);
  const reasoning = messagesReasoning(blocks);
  const toolCalls = messagesToolCalls(blocks);
  return {
    content,
    reasoning: reasoning || undefined,
    usage: normalizeUsage(payload.usage),
    finishReason: messagesFinishReason(payload.stop_reason),
    toolCalls,
    rawAssistantMessage: { role: "assistant", content: blocks },
    diagnostics: {
      id: payload.id || response.headers.get("x-generation-id") || response.headers.get("x-request-id") || undefined,
      model: payload.model,
      requestBytes,
    },
  };
}

async function parseMessagesStream(
  response: Response,
  requestBytes: number,
  onDelta?: (delta: string) => void,
  onReasoningDelta?: (delta: string) => void,
): Promise<CompletionResult> {
  if (!response.body) throw new Error("API 응답 스트림 없음");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const blocks: RawMessagesContentBlock[] = [];
  const partialInputs = new Map<number, string>();
  let buffer = "";
  let responseId = response.headers.get("x-generation-id") || response.headers.get("x-request-id") || undefined;
  let responseModel: string | undefined;
  let usage: TokenUsage | undefined;
  let finishReason: string | undefined;
  let receivedEvents = 0;
  let malformedEvents = 0;

  const processLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let event: RawMessagesEvent;
    try { event = JSON.parse(data) as RawMessagesEvent; }
    catch { malformedEvents += 1; return; }
    receivedEvents += 1;
    if (event.type === "error" || event.error) {
      const message = typeof event.error === "string"
        ? event.error : event.error?.message || "알 수 없는 오류";
      throw new Error(`API 스트림 오류: ${message}`);
    }
    if (event.type === "message_start" && event.message) {
      responseId = event.message.id || responseId;
      responseModel = event.message.model || responseModel;
      usage = normalizeUsage(event.message.usage) || usage;
    }
    if (event.type === "content_block_start" && event.content_block) {
      const index = event.index ?? blocks.length;
      blocks[index] = { ...event.content_block };
      if (event.content_block.type === "text" && event.content_block.text) onDelta?.(event.content_block.text);
      if (event.content_block.type === "thinking" && event.content_block.thinking) {
        onReasoningDelta?.(event.content_block.thinking);
      }
    }
    if (event.type === "content_block_delta" && event.delta) {
      const index = event.index ?? 0;
      const block = blocks[index] ||= {};
      if (event.delta.type === "text_delta" && event.delta.text) {
        block.type ||= "text";
        block.text = `${block.text || ""}${event.delta.text}`;
        onDelta?.(event.delta.text);
      }
      if (event.delta.type === "thinking_delta" && event.delta.thinking) {
        block.type ||= "thinking";
        block.thinking = `${block.thinking || ""}${event.delta.thinking}`;
        onReasoningDelta?.(event.delta.thinking);
      }
      if (event.delta.type === "signature_delta" && event.delta.signature) {
        block.signature = `${block.signature || ""}${event.delta.signature}`;
      }
      if (event.delta.type === "input_json_delta" && event.delta.partial_json) {
        partialInputs.set(index, `${partialInputs.get(index) || ""}${event.delta.partial_json}`);
      }
    }
    if (event.type === "content_block_stop") {
      const index = event.index ?? 0;
      const partial = partialInputs.get(index);
      if (partial && blocks[index]) {
        try { blocks[index].input = JSON.parse(partial); }
        catch { blocks[index].input = {}; }
        partialInputs.delete(index);
      }
    }
    if (event.type === "message_delta") {
      finishReason = messagesFinishReason(event.delta?.stop_reason);
      if (event.usage) {
        const next = normalizeUsage(event.usage);
        usage = next ? { ...usage, ...next, input: usage?.input || next.input,
          total: (usage?.input || 0) + next.output } : usage;
      }
    }
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

  const content = messagesText(blocks);
  const reasoning = messagesReasoning(blocks);
  const toolCalls = messagesToolCalls(blocks);
  return {
    content,
    reasoning: reasoning || undefined,
    usage,
    finishReason: finishReason || (toolCalls.length ? "tool_calls" : undefined),
    toolCalls,
    rawAssistantMessage: { role: "assistant", content: blocks },
    diagnostics: { id: responseId, model: responseModel, requestBytes, receivedEvents, malformedEvents },
  };
}

async function parseResponsesStream(
  response: Response,
  requestBytes: number,
  onDelta?: (delta: string) => void,
  onReasoningDelta?: (delta: string) => void,
): Promise<CompletionResult> {
  if (!response.body) throw new Error("API 응답 스트림 없음");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const outputItems: RawResponseOutputItem[] = [];
  let buffer = "";
  let content = "";
  let reasoning = "";
  let finalResponse: RawResponsePayload | undefined;
  let receivedEvents = 0;
  let malformedEvents = 0;

  const processLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let event: RawResponseEvent;
    try {
      event = JSON.parse(data) as RawResponseEvent;
    } catch {
      malformedEvents += 1;
      return;
    }
    receivedEvents += 1;
    if (event.type === "error" || event.error) {
      const message = typeof event.error === "string"
        ? event.error : event.error?.message || event.message || "알 수 없는 오류";
      throw new Error(`API 스트림 오류: ${message}`);
    }
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      content += event.delta;
      onDelta?.(event.delta);
    }
    if (["response.reasoning_summary_text.delta", "response.reasoning_text.delta"].includes(event.type || "")
      && typeof event.delta === "string") {
      reasoning += event.delta;
      onReasoningDelta?.(event.delta);
    }
    if (event.type === "response.output_item.done" && event.item) outputItems.push(event.item);
    if (["response.completed", "response.incomplete", "response.failed"].includes(event.type || "")
      && event.response) finalResponse = event.response;
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

  const parsed = parseJsonResponse(finalResponse || { output: outputItems }, response, requestBytes);
  return {
    ...parsed,
    content: content || parsed.content,
    reasoning: reasoning || parsed.reasoning,
    diagnostics: { ...parsed.diagnostics, receivedEvents, malformedEvents },
  };
}

const learnedCompletionApis = new Map<string, CompletionApi>();
const NEGOTIABLE_STATUSES = new Set([400, 404, 405, 415, 422]);

function completionCacheKey(provider: CompletionProvider): string {
  return `${provider.baseUrl.trim()}\n${provider.model.trim()}`;
}

async function requestCompletionWithTarget({
  settings,
  provider,
  reasoning: reasoningSettings,
  messages,
  tools,
  sessionId,
  signal,
  onDelta,
  onReasoningDelta,
}: CompletionOptions, target: { api: CompletionApi; url: string }, streamOverride?: boolean): Promise<CompletionResult> {
  const requestStream = streamOverride ?? settings.stream;
  const api = target.api;
  const requestUrl = resolveCompletionUrl(provider, target.url);
  const useProxy = normalizeConnectionMode(provider.connectionMode) === "cors-proxy";
  const serializedBody = serializeCompletionRequest(
    settings, provider, messages, tools, reasoningSettings, streamOverride, api,
  );
  const requestBytes = new TextEncoder().encode(serializedBody).byteLength;

  const headers = new Headers({ "Content-Type": "application/json" });
  if (useProxy) headers.set(UPSTREAM_HEADER, target.url);
  if (provider.apiKey.trim()) {
    headers.set("Authorization", `Bearer ${provider.apiKey.trim()}`);
  }
  if (sessionId && isOpenCodeTarget(target.url)) {
    headers.set(OPENCODE_SESSION_HEADER, sessionId.slice(0, 200));
    headers.set(OPENCODE_CLIENT_HEADER, "simple-ai");
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
    let payload: RawCompletionPayload | RawResponsePayload | RawMessagesPayload;
    try {
      payload = (await response.json()) as RawCompletionPayload | RawResponsePayload;
    } catch {
      throw new Error("API 응답 형식 오류 · JSON 또는 SSE 필요");
    }
    if (api === "responses") return parseJsonResponse(payload as RawResponsePayload, response, requestBytes);
    if (api === "messages") return parseJsonMessages(payload as RawMessagesPayload, response, requestBytes);
    return parseJsonCompletion(payload as RawCompletionPayload, response, requestBytes);
  }

  if (api === "responses") {
    return parseResponsesStream(response, requestBytes, onDelta, onReasoningDelta);
  }
  if (api === "messages") {
    return parseMessagesStream(response, requestBytes, onDelta, onReasoningDelta);
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
      requestBytes,
      receivedEvents,
      malformedEvents,
    },
  };
}

async function requestCompletionOnce(options: CompletionOptions, streamOverride?: boolean): Promise<CompletionResult> {
  const key = completionCacheKey(options.provider);
  const targets = resolveCompletionTargets(options.provider.baseUrl, learnedCompletionApis.get(key));
  let firstError: ApiRequestError | undefined;
  for (const target of targets) {
    try {
      const result = await requestCompletionWithTarget(options, target, streamOverride);
      learnedCompletionApis.set(key, target.api);
      return result;
    } catch (error) {
      if (!(error instanceof ApiRequestError) || !NEGOTIABLE_STATUSES.has(error.status)) throw error;
      firstError ||= error;
    }
  }
  throw firstError || new Error("API 형식 자동 선택 실패");
}

function isUsableCompletion(result: CompletionResult): boolean {
  if (result.content.trim() || result.toolCalls.length) return true;
  return result.finishReason === "content_filter";
}

function isRetryableEmptyCompletion(result: CompletionResult): boolean {
  if (result.reasoning?.trim() || (result.usage?.output || 0) > 0) return false;
  return !result.finishReason || result.finishReason === "stop" || result.finishReason === "error";
}

function logEmptyCompletion(
  options: CompletionOptions,
  first: CompletionResult,
  second?: CompletionResult,
): void {
  const reasoning = options.reasoning || options.provider.reasoning;
  const summarize = (result: CompletionResult) => ({
    id: result.diagnostics.id,
    model: result.diagnostics.model,
    finishReason: result.finishReason,
    usage: result.usage,
    requestBytes: result.diagnostics.requestBytes,
    receivedEvents: result.diagnostics.receivedEvents,
    malformedEvents: result.diagnostics.malformedEvents,
    contentLength: result.content.length,
    reasoningLength: result.reasoning?.length || 0,
    toolCallCount: result.toolCalls.length,
  });

  console.warn("[Simple AI] Completion without usable content", {
    request: {
      model: options.provider.model,
      messageCount: options.messages.length,
      toolCount: options.tools?.length || 0,
      maxTokens: options.settings.maxTokens,
      stream: options.settings.stream,
      reasoning: { format: reasoning.format, level: reasoning.level },
    },
    first: summarize(first),
    ...(second ? { second: summarize(second) } : {}),
  });
}

export async function requestCompletion(options: CompletionOptions): Promise<CompletionResult> {
  const first = await requestCompletionOnce(options);
  if (isUsableCompletion(first)) return first;
  if (!isRetryableEmptyCompletion(first)) {
    logEmptyCompletion(options, first);
    const kind = first.reasoning?.trim() ? "thinking만 수신" : "본문 없음";
    throw new Error(`API 응답 본문 없음 · ${kind}`);
  }

  options.onRetry?.();
  const second = await requestCompletionOnce({
    ...options,
    onDelta: undefined,
    onReasoningDelta: undefined,
    onRetry: undefined,
  }, false);
  if (isUsableCompletion(second)) return second;

  logEmptyCompletion(options, first, second);
  throw new Error("API 빈 응답 · 자동 재시도 실패");
}
