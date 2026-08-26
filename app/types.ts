export type AttachmentKind = "image" | "text";

export interface Attachment {
  id: string;
  name: string;
  type: string;
  size: number;
  kind: AttachmentKind;
  dataUrl?: string;
  text?: string;
}

export interface TokenUsage {
  input: number;
  output: number;
  total: number;
  cached: number;
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
}

export type McpAuthType = "none" | "bearer" | "x-api-key";

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
  mcpEnabled: boolean;
  mcpUrl: string;
  mcpAuthType: McpAuthType;
  mcpToken: string;
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

export const DEFAULT_PROVIDER_PRESET: ProviderPreset = {
  id: "default",
  name: "연결 1",
  baseUrl: "",
  apiKey: "",
  model: "",
  vision: false,
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
  mcpEnabled: false,
  mcpUrl: "https://mcp.exa.ai/mcp",
  mcpAuthType: "none",
  mcpToken: "",
};

export function getActiveProvider(settings: AppSettings): ProviderPreset {
  return (
    settings.providerPresets.find((preset) => preset.id === settings.activeProviderId) ||
    settings.providerPresets[0] ||
    DEFAULT_PROVIDER_PRESET
  );
}
