export type AttachmentKind = "image" | "text";

export interface Attachment {
  id: string;
  name: string;
  type: string;
  size: number;
  originalSize?: number;
  kind: AttachmentKind;
  dataUrl?: string;
  text?: string;
}

export interface TokenUsage {
  input: number;
  output: number;
  total: number;
  cached: number;
  reasoning?: number;
}

export interface ToolEvent {
  id: string;
  name: string;
  status: "running" | "done" | "error";
  summary?: string;
}

export interface ContextTrimInfo {
  omittedMessages: number;
  estimatedInputTokens: number;
  inputBudget: number;
  reason?: "turns" | "tokens";
}

export interface ResponseVariant {
  id: string;
  content: string;
  reasoning?: string;
  model?: string;
  providerPresetName?: string;
  createdAt: number;
  usage?: TokenUsage;
  finishReason?: string;
  toolEvents?: ToolEvent[];
  contextTrim?: ContextTrimInfo;
  error?: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  model?: string;
  providerPresetName?: string;
  createdAt: number;
  attachments?: Attachment[];
  usage?: TokenUsage;
  finishReason?: string;
  toolEvents?: ToolEvent[];
  contextTrim?: ContextTrimInfo;
  error?: boolean;
  responseVariants?: ResponseVariant[];
  activeResponseVariantId?: string;
}

export interface ConversationSettings {
  providerPresetId: string;
  model: string;
  vision: boolean;
  systemPrompt: string;
  openingMessage: string;
  temperature: number;
  maxTokens: number;
  contextLimit: number;
  historyTurns: number;
  autoTrimContext: boolean;
  stream: boolean;
  reasoning: ReasoningSettings;
}

export interface Conversation {
  id: string;
  title: string;
  titleEdited: boolean;
  createdAt: number;
  updatedAt: number;
  settings: ConversationSettings;
  messages: ChatMessage[];
}

export interface ProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  vision: boolean;
  extraBody: string;
  reasoning: ReasoningSettings;
}

export type ReasoningLevel = "default" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "budget";
export interface ReasoningSettings {
  format: "effort" | "reasoning" | "thinking" | "custom";
  level: ReasoningLevel;
  budget: number;
  customMapping: string;
}

export type SendKey = "auto" | "enter" | "ctrl-enter";

export type McpAuthType = "none" | "bearer" | "x-api-key";

export interface McpServerConfig {
  id: string;
  name: string;
  url: string;
  authType: McpAuthType;
  token: string;
  enabled: boolean;
  selectedTools: string[] | null;
}

export interface McpConnectionState {
  status: "connecting" | "connected" | "error";
  tools: McpToolDefinition[];
  error?: string;
}

export interface AppSettings {
  providerPresets: ProviderPreset[];
  activeProviderId: string;
  rememberCredentials: boolean;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  contextLimit: number;
  historyTurns: number;
  autoTrimContext: boolean;
  stream: boolean;
  markdownImageWidth: number;
  theme: "dark" | "light";
  sendKey: SendKey;
  mcpEnabled: boolean;
  mcpServers: McpServerConfig[];
  mcpToolLimit: number;
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export const DEFAULT_REASONING: ReasoningSettings = {
  format: "effort",
  level: "default",
  budget: 2048,
  customMapping: "",
};

export const DEFAULT_PROVIDER_PRESET: ProviderPreset = {
  id: "default",
  name: "연결 1",
  baseUrl: "",
  apiKey: "",
  model: "",
  vision: false,
  extraBody: "",
  reasoning: DEFAULT_REASONING,
};

export const DEFAULT_SETTINGS: AppSettings = {
  providerPresets: [DEFAULT_PROVIDER_PRESET],
  activeProviderId: DEFAULT_PROVIDER_PRESET.id,
  rememberCredentials: true,
  systemPrompt: "",
  temperature: 0.7,
  maxTokens: 4096,
  contextLimit: 131072,
  historyTurns: 20,
  autoTrimContext: true,
  stream: true,
  markdownImageWidth: 100,
  theme: "dark",
  sendKey: "auto",
  mcpEnabled: false,
  mcpServers: [],
  mcpToolLimit: 24,
};

export function getActiveProvider(settings: AppSettings): ProviderPreset {
  return (
    settings.providerPresets.find((preset) => preset.id === settings.activeProviderId) ||
    settings.providerPresets[0] ||
    DEFAULT_PROVIDER_PRESET
  );
}
