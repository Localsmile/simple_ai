"use client";

import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  FileCode2,
  Image as ImageIcon,
  Menu,
  MessageSquare,
  Moon,
  Paperclip,
  Pencil,
  Plus,
  Settings2,
  Square,
  Sun,
  Trash2,
  UploadCloud,
  Wrench,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { MessageList } from "./components/MessageList";
import { SettingsPanel } from "./components/SettingsPanel";
import {
  buildApiMessages,
  isPayloadTooLargeError,
  requestCompletion,
} from "./lib/api";
import { planRequestContext } from "./lib/context";
import { MAX_IMAGE_SOURCE_SIZE, optimizeImageToWebp } from "./lib/image";
import { McpClient } from "./lib/mcp";
import {
  deleteConversation,
  listConversations,
  loadSettings,
  saveConversation,
  saveSettings,
} from "./lib/storage";
import type {
  AppSettings,
  Attachment,
  ChatMessage,
  Conversation,
  ConversationSettings,
  ContextTrimInfo,
  McpToolDefinition,
  ResponseVariant,
  TokenUsage,
  ToolEvent,
} from "./types";
import { DEFAULT_SETTINGS, getActiveProvider } from "./types";

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "xml", "yaml", "yml",
  "html", "htm", "css", "scss", "js", "jsx", "ts", "tsx", "py", "java", "kt",
  "go", "rs", "c", "h", "cpp", "hpp", "cs", "php", "rb", "swift", "sql", "sh",
  "ps1", "bat", "ini", "toml", "log", "conf",
]);
const MAX_FILES = 6;
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const MAX_TEXT_SIZE = 2 * 1024 * 1024;
const MAX_TOTAL_SIZE = 20 * 1024 * 1024;

function id(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

function timestamp(): number {
  return Date.now();
}

function conversationSettingsFromApp(settings: AppSettings): ConversationSettings {
  const provider = getActiveProvider(settings);
  return {
    providerPresetId: provider.id,
    model: provider.model,
    vision: provider.vision,
    systemPrompt: "",
    openingMessage: "",
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    contextLimit: settings.contextLimit,
    historyTurns: settings.historyTurns,
    autoTrimContext: settings.autoTrimContext,
    stream: settings.stream,
  };
}

function normalizeConversation(
  conversation: Conversation,
  appSettings: AppSettings,
): Conversation {
  const stored = conversation.settings as Partial<ConversationSettings> | undefined;
  const provider = appSettings.providerPresets.find(
    (preset) => preset.id === stored?.providerPresetId,
  ) || getActiveProvider(appSettings);

  const normalized = {
    ...conversation,
    messages: Array.isArray(conversation.messages)
      ? conversation.messages.map((message) => {
          if (message.role !== "assistant" || !Array.isArray(message.responseVariants)) {
            return message;
          }
          const responseVariants = message.responseVariants.filter(
            (variant) => variant && typeof variant.id === "string" && typeof variant.content === "string",
          );
          if (!responseVariants.length) {
            const { responseVariants: _variants, activeResponseVariantId: _active, ...rest } = message;
            void _variants;
            void _active;
            return rest;
          }
          const activeResponseVariantId = responseVariants.some(
            (variant) => variant.id === message.activeResponseVariantId,
          )
            ? message.activeResponseVariantId
            : responseVariants.find((variant) => variant.content === message.content)?.id
              || responseVariants.at(-1)?.id;
          return { ...message, responseVariants, activeResponseVariantId };
        })
      : [],
    settings: {
      providerPresetId: provider.id,
      model: typeof stored?.model === "string" ? stored.model : provider.model,
      vision: typeof stored?.vision === "boolean" ? stored.vision : provider.vision,
      systemPrompt: typeof stored?.systemPrompt === "string"
        ? stored.systemPrompt
        : appSettings.systemPrompt,
      openingMessage: typeof stored?.openingMessage === "string" ? stored.openingMessage : "",
      temperature: typeof stored?.temperature === "number"
        ? stored.temperature
        : appSettings.temperature,
      maxTokens: typeof stored?.maxTokens === "number" && stored.maxTokens > 0
        ? stored.maxTokens
        : appSettings.maxTokens,
      contextLimit: typeof stored?.contextLimit === "number" && (
        stored.contextLimit === -1 || stored.contextLimit >= 2048
      )
        ? stored.contextLimit
        : appSettings.contextLimit,
      historyTurns: typeof stored?.historyTurns === "number" && (
        stored.historyTurns === -1 || stored.historyTurns >= 1
      )
        ? Math.floor(stored.historyTurns)
        : appSettings.historyTurns,
      autoTrimContext: typeof stored?.autoTrimContext === "boolean"
        ? stored.autoTrimContext
        : appSettings.autoTrimContext,
      stream: typeof stored?.stream === "boolean" ? stored.stream : appSettings.stream,
    },
  } as Conversation & { requestBodyProfile?: unknown };
  const currentTitle = typeof conversation.title === "string" ? conversation.title.trim() : "";
  normalized.title = currentTitle || titleFromMessages(normalized.messages);
  normalized.titleEdited = typeof conversation.titleEdited === "boolean"
    ? conversation.titleEdited
    : currentTitle !== "" && currentTitle !== "새 대화"
      && currentTitle !== titleFromMessages(normalized.messages);
  delete normalized.requestBodyProfile;
  return normalized;
}

function syncAppDefaults(
  appSettings: AppSettings,
  conversationSettings: ConversationSettings,
): AppSettings {
  return {
    ...appSettings,
    activeProviderId: conversationSettings.providerPresetId,
    systemPrompt: "",
    temperature: conversationSettings.temperature,
    maxTokens: conversationSettings.maxTokens,
    contextLimit: conversationSettings.contextLimit,
    historyTurns: conversationSettings.historyTurns,
    autoTrimContext: conversationSettings.autoTrimContext,
    stream: conversationSettings.stream,
    providerPresets: appSettings.providerPresets.map((preset) =>
      preset.id === conversationSettings.providerPresetId
        ? {
            ...preset,
            model: conversationSettings.model,
            vision: conversationSettings.vision,
          }
        : preset,
    ),
  };
}

function newConversation(settings: AppSettings): Conversation {
  const now = Date.now();
  return {
    id: id("chat"),
    title: "새 대화",
    titleEdited: false,
    createdAt: now,
    updatedAt: now,
    settings: conversationSettingsFromApp(settings),
    messages: [],
  };
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString("ko-KR", { month: "short", day: "numeric" });
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)}MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)}KB`;
  return `${value}B`;
}

function titleFrom(text: string, attachments: Attachment[]): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized) return normalized.length > 42 ? `${normalized.slice(0, 42)}…` : normalized;
  return attachments[0]?.name || "새 대화";
}

function titleFromMessages(messages: ChatMessage[]): string {
  const firstUser = messages.find((message) => message.role === "user");
  return firstUser
    ? titleFrom(firstUser.content, firstUser.attachments || [])
    : "새 대화";
}

function titleAfterMessageChange(
  conversation: Conversation,
  messages: ChatMessage[],
): string {
  const currentTitle = conversation.title.trim();
  return conversation.titleEdited && currentTitle
    ? currentTitle
    : titleFromMessages(messages);
}

function addUsage(left: TokenUsage, right?: TokenUsage): TokenUsage {
  if (!right) return left;
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    total: left.total + right.total,
    cached: left.cached + right.cached,
    reasoning: (left.reasoning || 0) + (right.reasoning || 0),
  };
}

function cloneUsage(usage?: TokenUsage): TokenUsage | undefined {
  return usage ? { ...usage } : undefined;
}

function cloneToolEvents(toolEvents?: ToolEvent[]): ToolEvent[] | undefined {
  return toolEvents?.map((event) => ({ ...event }));
}

function cloneContextTrim(contextTrim?: ContextTrimInfo): ContextTrimInfo | undefined {
  return contextTrim ? { ...contextTrim } : undefined;
}

function appendReasoning(current: string, next: string): string {
  if (!next) return current;
  return current ? `${current}\n\n${next}` : next;
}

function responseVariantFromMessage(message: ChatMessage): ResponseVariant {
  return {
    id: id("variant"),
    content: message.content,
    reasoning: message.reasoning,
    model: message.model,
    providerPresetName: message.providerPresetName,
    createdAt: message.createdAt,
    usage: cloneUsage(message.usage),
    finishReason: message.finishReason,
    toolEvents: cloneToolEvents(message.toolEvents),
    contextTrim: cloneContextTrim(message.contextTrim),
    error: message.error,
  };
}

function responseVariantsForReroll(message: ChatMessage): ResponseVariant[] {
  if (message.responseVariants?.length) {
    return message.responseVariants.map((variant) => ({
      ...variant,
      usage: cloneUsage(variant.usage),
      toolEvents: cloneToolEvents(variant.toolEvents),
      contextTrim: cloneContextTrim(variant.contextTrim),
    }));
  }
  return [responseVariantFromMessage(message)];
}

function applyResponseVariant(message: ChatMessage, variant: ResponseVariant): ChatMessage {
  return {
    ...message,
    content: variant.content,
    reasoning: variant.reasoning,
    model: variant.model,
    providerPresetName: variant.providerPresetName,
    createdAt: variant.createdAt,
    usage: cloneUsage(variant.usage),
    finishReason: variant.finishReason,
    toolEvents: cloneToolEvents(variant.toolEvents),
    contextTrim: cloneContextTrim(variant.contextTrim),
    error: variant.error,
    activeResponseVariantId: variant.id,
  };
}

function removeActiveResponseVariant(message: ChatMessage): ChatMessage | undefined {
  const variants = message.responseVariants;
  if (message.role !== "assistant" || !variants || variants.length <= 1) {
    return undefined;
  }
  const activeIndex = variants.findIndex(
    (variant) => variant.id === message.activeResponseVariantId,
  );
  if (activeIndex < 0) return undefined;

  const remainingVariants = variants.filter((_, index) => index !== activeIndex);
  const replacement = remainingVariants[Math.min(activeIndex, remainingVariants.length - 1)];
  return {
    ...applyResponseVariant(message, replacement),
    responseVariants: remainingVariants,
  };
}

function cloneMessagesForBranch(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    ...message,
    id: id("msg"),
    attachments: message.attachments?.map((attachment) => ({
      ...attachment,
      id: id("file"),
    })),
    usage: cloneUsage(message.usage),
    toolEvents: cloneToolEvents(message.toolEvents),
    contextTrim: cloneContextTrim(message.contextTrim),
    responseVariants: message.responseVariants?.map((variant) => ({
      ...variant,
      usage: cloneUsage(variant.usage),
      toolEvents: cloneToolEvents(variant.toolEvents),
      contextTrim: cloneContextTrim(variant.contextTrim),
    })),
  }));
}

function fileExtension(name: string): string {
  return name.split(".").pop()?.toLowerCase() || "";
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function readableError(error: unknown): string {
  if (isPayloadTooLargeError(error)) {
    return `API 요청 본문(${formatBytes(error.requestBytes)})이 공급자의 업로드 한도를 초과했습니다. 컨텍스트 토큰 한도와는 별개입니다. 시스템 프롬프트, 최신 메시지, 첨부 이미지·파일 또는 MCP 도구 결과의 크기를 줄이십시오.`;
  }
  if (error instanceof Error) return error.message;
  return "알 수 없는 오류가 발생했습니다.";
}

function useEventCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const callbackRef = useRef(callback);
  useLayoutEffect(() => {
    callbackRef.current = callback;
  }, [callback]);
  return useCallback((...args: Args) => callbackRef.current(...args), []);
}

export default function Home() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [hydrated, setHydrated] = useState(false);
  const [history, setHistory] = useState<Conversation[]>([]);
  const [conversation, setConversation] = useState<Conversation>(() => newConversation(DEFAULT_SETTINGS));
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [optimizingImages, setOptimizingImages] = useState(false);
  const [composerError, setComposerError] = useState("");
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [copiedId, setCopiedId] = useState("");
  const [editingMessageId, setEditingMessageId] = useState("");
  const [editingContent, setEditingContent] = useState("");
  const [renamingConversationId, setRenamingConversationId] = useState("");
  const [conversationTitleDraft, setConversationTitleDraft] = useState("");
  const [mcpStatus, setMcpStatus] = useState<"off" | "connecting" | "connected" | "error">("off");
  const [mcpError, setMcpError] = useState("");
  const [mcpTools, setMcpTools] = useState<McpToolDefinition[]>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followOutputRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const dragDepthRef = useRef(0);
  const mcpClientRef = useRef<McpClient | null>(null);

  useEffect(() => {
    let active = true;
    Promise.resolve().then(async () => {
      const savedSettings = loadSettings();
      const items = await listConversations();
      if (!active) return;
      const normalizedItems = items.map((item) => normalizeConversation(item, savedSettings));
      const current = normalizedItems[0] || newConversation(savedSettings);
      const currentSettings = syncAppDefaults(savedSettings, current.settings);
      setSettings(currentSettings);
      document.documentElement.dataset.theme = savedSettings.theme;
      setHistory(normalizedItems);
      setConversation(current);
      setHydrated(true);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    saveSettings(settings);
    document.documentElement.dataset.theme = settings.theme;
  }, [settings, hydrated]);

  useLayoutEffect(() => {
    const target = scrollRef.current;
    if (!target) return;
    followOutputRef.current = true;
    target.scrollTop = target.scrollHeight;
  }, [conversation.id]);

  useEffect(() => {
    const target = scrollRef.current;
    if (!target || !followOutputRef.current) return;
    target.scrollTop = target.scrollHeight;
  }, [conversation.messages, generating]);

  const handleMessagesScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
    followOutputRef.current = distanceFromBottom <= 72;
  }, []);

  const activeProvider = useMemo(() => {
    const preset = settings.providerPresets.find(
      (item) => item.id === conversation.settings.providerPresetId,
    ) || getActiveProvider(settings);
    return {
      ...preset,
      model: conversation.settings.model,
      vision: conversation.settings.vision,
    };
  }, [conversation.settings, settings]);

  const requestSettings = useMemo<AppSettings>(() => ({
    ...settings,
    systemPrompt: conversation.settings.systemPrompt,
    temperature: conversation.settings.temperature,
    maxTokens: conversation.settings.maxTokens,
    contextLimit: conversation.settings.contextLimit,
    historyTurns: conversation.settings.historyTurns,
    autoTrimContext: conversation.settings.autoTrimContext,
    stream: conversation.settings.stream,
  }), [conversation.settings, settings]);

  const totalUsage = useMemo(
    () =>
      conversation.messages.reduce<TokenUsage>(
        (total, message) => {
          if (message.role === "assistant" && message.responseVariants?.length) {
            return message.responseVariants.reduce(
              (variantTotal, variant) => addUsage(variantTotal, variant.usage),
              total,
            );
          }
          return addUsage(total, message.usage);
        },
        { input: 0, output: 0, total: 0, cached: 0, reasoning: 0 },
      ),
    [conversation.messages],
  );

  const applyConversationSettings = useCallback((nextSettings: ConversationSettings) => {
    const nextConversation = {
      ...conversation,
      settings: nextSettings,
    };
    setConversation(nextConversation);
    setHistory((current) => {
      const exists = current.some((item) => item.id === nextConversation.id);
      if (exists) {
        return current.map((item) => item.id === nextConversation.id ? nextConversation : item);
      }
      return nextSettings.openingMessage.trim() ? [nextConversation, ...current] : current;
    });
    if (nextConversation.messages.length || nextSettings.openingMessage.trim()) {
      void saveConversation(nextConversation);
    }
  }, [conversation]);

  const changeSettings = useCallback(
    (next: AppSettings) => {
      const mcpChanged =
        settings.mcpEnabled !== next.mcpEnabled ||
        settings.mcpUrl !== next.mcpUrl ||
        settings.mcpAuthType !== next.mcpAuthType ||
        settings.mcpToken !== next.mcpToken;
      if (mcpChanged) {
        mcpClientRef.current = null;
        setMcpTools([]);
        setMcpError("");
        setMcpStatus("off");
      }
      if (settings.activeProviderId !== next.activeProviderId) {
        const provider = next.providerPresets.find(
          (preset) => preset.id === next.activeProviderId,
        );
        if (provider) {
          applyConversationSettings({
            ...conversation.settings,
            providerPresetId: provider.id,
            model: provider.model,
            vision: provider.vision,
          });
        }
      }
      setSettings(next);
    },
    [applyConversationSettings, conversation.settings, settings],
  );

  const changeConversationSettings = useCallback((next: ConversationSettings) => {
    applyConversationSettings(next);
    setSettings((current) => syncAppDefaults(current, next));
  }, [applyConversationSettings]);

  const swapConversationProvider = useCallback((providerPresetId: string) => {
    const provider = settings.providerPresets.find((preset) => preset.id === providerPresetId);
    if (!provider) return;
    changeConversationSettings({
      ...conversation.settings,
      providerPresetId: provider.id,
      model: provider.model,
      vision: provider.vision,
    });
  }, [changeConversationSettings, conversation.settings, settings.providerPresets]);

  const commitConversation = useCallback((next: Conversation) => {
    setConversation(next);
    setHistory((current) => {
      const without = current.filter((item) => item.id !== next.id);
      return [next, ...without].sort((a, b) => b.updatedAt - a.updatedAt);
    });
  }, []);

  const updateAssistant = useCallback(
    (assistantId: string, updater: (message: ChatMessage) => ChatMessage) => {
      setConversation((current) => ({
        ...current,
        messages: current.messages.map((message) =>
          message.id === assistantId ? updater(message) : message,
        ),
        updatedAt: Date.now(),
      }));
    },
    [],
  );

  const startNewConversation = () => {
    abortRef.current?.abort();
    const next = newConversation(settings);
    setConversation(next);
    cancelEditMessage();
    setInput("");
    setAttachments([]);
    setComposerError("");
    setRenamingConversationId("");
    setSidebarOpen(false);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const selectConversation = (item: Conversation) => {
    if (generating) abortRef.current?.abort();
    const next = normalizeConversation(item, settings);
    setConversation(next);
    setSettings((current) => syncAppDefaults(current, next.settings));
    void saveConversation(next);
    cancelEditMessage();
    setAttachments([]);
    setInput("");
    setComposerError("");
    setRenamingConversationId("");
    setSidebarOpen(false);
  };

  const removeConversation = async (event: React.MouseEvent, item: Conversation) => {
    event.stopPropagation();
    await deleteConversation(item.id);
    const nextHistory = history.filter((entry) => entry.id !== item.id);
    setHistory(nextHistory);
    if (conversation.id === item.id) {
      const next = nextHistory[0] || newConversation(settings);
      setConversation(next);
      setSettings((current) => syncAppDefaults(current, next.settings));
    }
    if (renamingConversationId === item.id) setRenamingConversationId("");
  };

  const beginConversationRename = (item: Conversation) => {
    setRenamingConversationId(item.id);
    setConversationTitleDraft(item.title);
  };

  const saveConversationTitle = (item: Conversation) => {
    const title = conversationTitleDraft.replace(/\s+/g, " ").trim().slice(0, 80);
    if (!title) return;
    const source = item.id === conversation.id ? conversation : item;
    const next = { ...source, title, titleEdited: true };
    setHistory((current) => current.map((entry) => entry.id === item.id ? next : entry));
    if (conversation.id === item.id) setConversation(next);
    setRenamingConversationId("");
    setConversationTitleDraft("");
    void saveConversation(next);
  };

  const connectMcp = useCallback(async (): Promise<McpClient | null> => {
    if (!settings.mcpEnabled || !settings.mcpUrl.trim()) return null;
    setMcpStatus("connecting");
    setMcpError("");
    const client = new McpClient(settings);
    try {
      const tools = await client.connect();
      mcpClientRef.current = client;
      setMcpTools(tools);
      setMcpStatus("connected");
      return client;
    } catch (error) {
      mcpClientRef.current = null;
      setMcpTools([]);
      setMcpStatus("error");
      setMcpError(readableError(error));
      return null;
    }
  }, [settings]);

  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    if (optimizingImages) {
      setComposerError("현재 이미지 최적화가 끝난 뒤 파일을 추가하십시오.");
      return;
    }
    setComposerError("");

    if (attachments.length + files.length > MAX_FILES) {
      setComposerError(`첨부 파일은 최대 ${MAX_FILES}개까지 가능합니다.`);
      return;
    }

    setOptimizingImages(true);
    try {
      const next: Attachment[] = [];
      let totalSize = attachments.reduce((sum, item) => sum + item.size, 0);
      for (const file of files) {
        const isImage = file.type.startsWith("image/");
        const isText = file.type.startsWith("text/")
          || TEXT_EXTENSIONS.has(fileExtension(file.name));
        if (!isImage && !isText) {
          setComposerError("지원 형식: 이미지, 텍스트, Markdown, CSV, JSON, 코드 파일");
          continue;
        }
        if (isImage && file.size > MAX_IMAGE_SOURCE_SIZE) {
          setComposerError(`${file.name}: 압축 전 이미지는 최대 40MB입니다.`);
          continue;
        }
        if (isText && file.size > MAX_TEXT_SIZE) {
          setComposerError(`${file.name}: 텍스트 파일 최대 크기는 2MB입니다.`);
          continue;
        }

        const preparedFile = isImage ? await optimizeImageToWebp(file) : file;
        if (isImage && preparedFile.size > MAX_IMAGE_SIZE) {
          setComposerError(`${file.name}: WebP 최적화 후에도 10MB를 초과합니다.`);
          continue;
        }
        if (totalSize + preparedFile.size > MAX_TOTAL_SIZE) {
          setComposerError("최적화된 첨부 파일 전체 크기는 20MB를 초과할 수 없습니다.");
          continue;
        }
        totalSize += preparedFile.size;

        next.push({
          id: id("file"),
          name: preparedFile.name,
          type: preparedFile.type || "application/octet-stream",
          size: preparedFile.size,
          originalSize: preparedFile.size < file.size ? file.size : undefined,
          kind: isImage ? "image" : "text",
          ...(isImage
            ? { dataUrl: await readAsDataUrl(preparedFile) }
            : { text: await preparedFile.text() }),
        });
      }
      setAttachments((current) => [...current, ...next]);
    } catch {
      setComposerError("이미지 또는 파일을 처리하지 못했습니다.");
    } finally {
      setOptimizingImages(false);
    }
  };

  const handleFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    void addFiles(files);
  };

  const handleComposerPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const itemFiles = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    const imageFiles = itemFiles.length
      ? itemFiles
      : Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));

    if (!imageFiles.length) return;
    event.preventDefault();
    void addFiles(imageFiles);
  };

  const isFileDrag = (event: DragEvent<HTMLElement>) =>
    Array.from(event.dataTransfer.types).includes("Files");

  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDraggingFiles(true);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (dragDepthRef.current === 0) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDraggingFiles(false);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDraggingFiles(false);
    void addFiles(Array.from(event.dataTransfer.files));
  };

  const copyMessage = async (message: ChatMessage) => {
    await navigator.clipboard.writeText(message.content);
    setCopiedId(message.id);
    window.setTimeout(() => setCopiedId(""), 1400);
  };

  const beginEditMessage = (message: ChatMessage) => {
    setEditingMessageId(message.id);
    setEditingContent(message.content);
  };

  const cancelEditMessage = () => {
    setEditingMessageId("");
    setEditingContent("");
  };

  const saveMessageEdit = async (message: ChatMessage) => {
    const content = editingContent.trim();
    if (!content && !message.attachments?.length) return;
    const messages = conversation.messages.map((item) => {
      if (item.id !== message.id) return item;
      const responseVariants = item.role === "assistant" && item.responseVariants?.length
        ? item.responseVariants.map((variant) =>
            variant.id === item.activeResponseVariantId
              ? {
                  ...variant,
                  content,
                  reasoning: undefined,
                  usage: undefined,
                  finishReason: undefined,
                  toolEvents: undefined,
                  error: false,
                }
              : variant,
          )
        : item.responseVariants;
      return {
        ...item,
        content,
        responseVariants,
        ...(item.role === "assistant"
          ? {
              reasoning: undefined,
              usage: undefined,
              finishReason: undefined,
              toolEvents: undefined,
              error: false,
            }
          : {}),
      };
    });
    const next: Conversation = {
      ...conversation,
      title: titleAfterMessageChange(conversation, messages),
      updatedAt: timestamp(),
      messages,
    };
    cancelEditMessage();
    commitConversation(next);
    await saveConversation(next);
  };

  const removeMessage = async (messageId: string) => {
    if (generating) return;
    const targetMessage = conversation.messages.find((message) => message.id === messageId);
    if (!targetMessage) return;
    const messageWithVariantRemoved = removeActiveResponseVariant(targetMessage);
    const messages = messageWithVariantRemoved
      ? conversation.messages.map((message) =>
          message.id === messageId ? messageWithVariantRemoved : message,
        )
      : conversation.messages.filter((message) => message.id !== messageId);
    cancelEditMessage();
    if (!messages.length) {
      await deleteConversation(conversation.id);
      const nextHistory = history.filter((item) => item.id !== conversation.id);
      setHistory(nextHistory);
      const next = nextHistory[0] || newConversation(settings);
      setConversation(next);
      setSettings((current) => syncAppDefaults(current, next.settings));
      return;
    }
    const next: Conversation = {
      ...conversation,
      title: titleAfterMessageChange(conversation, messages),
      updatedAt: timestamp(),
      messages,
    };
    commitConversation(next);
    await saveConversation(next);
  };

  const validateSend = (): boolean => {
    if (optimizingImages) {
      setComposerError("이미지 최적화가 끝난 뒤 전송할 수 있습니다.");
      return false;
    }
    if (!input.trim() && !attachments.length) return false;
    if (!activeProvider.baseUrl.trim()) {
      setComposerError("API 엔드포인트가 필요합니다.");
      setSettingsOpen(true);
      return false;
    }
    if (!activeProvider.model.trim()) {
      setComposerError("모델 이름이 필요합니다.");
      setSettingsOpen(true);
      return false;
    }
    if (attachments.some((item) => item.kind === "image") && !activeProvider.vision) {
      setComposerError("이미지 전송에는 Vision 설정이 필요합니다.");
      return false;
    }
    return true;
  };

  const generateResponse = async (
    baseMessages: ChatMessage[],
    seedConversation: Conversation,
    variantTarget?: ChatMessage,
  ) => {
    const abortController = new AbortController();
    abortRef.current = abortController;
    const providerPreset = settings.providerPresets.find(
      (item) => item.id === seedConversation.settings.providerPresetId,
    ) || getActiveProvider(settings);
    const responseProvider = {
      ...providerPreset,
      model: seedConversation.settings.model,
      vision: seedConversation.settings.vision,
    };
    const contextPlan = planRequestContext(baseMessages, seedConversation.settings);
    const contextTrim: ContextTrimInfo | undefined = contextPlan.omittedMessages > 0
      ? {
          omittedMessages: contextPlan.omittedMessages,
          estimatedInputTokens: contextPlan.estimatedInputTokens,
          inputBudget: contextPlan.inputBudget,
          reason: contextPlan.reason,
        }
      : undefined;
    const preservedVariants = variantTarget
      ? responseVariantsForReroll(variantTarget)
      : undefined;
    const assistantMessage: ChatMessage = {
      id: variantTarget?.id || id("msg"),
      role: "assistant",
      content: "",
      model: responseProvider.model,
      providerPresetName: responseProvider.name,
      createdAt: timestamp(),
      toolEvents: [],
      contextTrim,
      responseVariants: preservedVariants,
      activeResponseVariantId: undefined,
    };
    const workingConversation: Conversation = {
      ...seedConversation,
      title: titleAfterMessageChange(seedConversation, baseMessages),
      updatedAt: timestamp(),
      messages: [...baseMessages, assistantMessage],
    };
    commitConversation(workingConversation);
    setGenerating(true);
    const recoverableMessages = variantTarget
      ? [...baseMessages, variantTarget]
      : baseMessages;
    const recoverableSave = saveConversation(
      { ...workingConversation, messages: recoverableMessages },
      false,
    ).catch(() => undefined);

    const responseSettings: AppSettings = {
      ...requestSettings,
      systemPrompt: seedConversation.settings.systemPrompt,
      temperature: seedConversation.settings.temperature,
      maxTokens: seedConversation.settings.maxTokens,
      contextLimit: seedConversation.settings.contextLimit,
      historyTurns: seedConversation.settings.historyTurns,
      autoTrimContext: seedConversation.settings.autoTrimContext,
      stream: seedConversation.settings.stream,
    };
    const requestContextMessages = contextPlan.messages;
    let apiMessages = buildApiMessages(
      requestContextMessages,
      seedConversation.settings.systemPrompt,
      seedConversation.settings.vision,
      seedConversation.settings.openingMessage,
    );
    let accumulated = "";
    let accumulatedReasoning = "";
    let usage: TokenUsage = { input: 0, output: 0, total: 0, cached: 0, reasoning: 0 };
    let toolEvents: ToolEvent[] = [];
    let finishReason: string | undefined;

    try {
      if (contextPlan.overLimit) {
        throw new Error(
          "최근 입력과 시스템 프롬프트가 현재 컨텍스트 한도를 초과합니다. 첨부 파일을 줄이거나 이 대화의 컨텍스트 한도를 높이십시오.",
        );
      }
      let client = settings.mcpEnabled ? mcpClientRef.current : null;
      if (settings.mcpEnabled && !client) client = await connectMcp();
      if (settings.mcpEnabled && !client) {
        throw new Error(mcpError || "MCP 서버 연결에 실패했습니다.");
      }
      const apiTools = client?.toApiTools();

      for (let round = 0; round < 5; round += 1) {
        const roundBase = accumulated;
        const reasoningRoundBase = accumulatedReasoning;
        let roundReasoning = "";
        const result = await requestCompletion({
          settings: responseSettings,
          provider: responseProvider,
          messages: apiMessages,
          tools: apiTools,
          signal: abortController.signal,
          onDelta: (delta) => {
            accumulated += delta;
            updateAssistant(assistantMessage.id, (message) => ({
              ...message,
              content: roundBase + accumulated.slice(roundBase.length),
              toolEvents,
            }));
          },
          onReasoningDelta: (delta) => {
            roundReasoning += delta;
            updateAssistant(assistantMessage.id, (message) => ({
              ...message,
              reasoning: appendReasoning(reasoningRoundBase, roundReasoning),
              toolEvents,
            }));
          },
        });
        accumulated = roundBase + result.content;
        roundReasoning = result.reasoning || roundReasoning;
        accumulatedReasoning = appendReasoning(reasoningRoundBase, roundReasoning);
        usage = addUsage(usage, result.usage);
        finishReason = result.finishReason;
        updateAssistant(assistantMessage.id, (message) => ({
          ...message,
          content: accumulated,
          reasoning: accumulatedReasoning || undefined,
          toolEvents,
        }));

        if (!result.toolCalls.length || !client) break;
        apiMessages = [...apiMessages, result.rawAssistantMessage];

        for (const call of result.toolCalls) {
          const event: ToolEvent = {
            id: call.id,
            name: client.displayName(call),
            status: "running",
          };
          toolEvents = [...toolEvents, event];
          updateAssistant(assistantMessage.id, (message) => ({ ...message, toolEvents }));

          const toolResult = await client.callTool(call, abortController.signal);
          toolEvents = toolEvents.map((item) =>
            item.id === call.id
              ? {
                  ...item,
                  status: toolResult.isError ? "error" : "done",
                  summary: toolResult.text.slice(0, 160),
                }
              : item,
          );
          apiMessages.push({
            role: "tool",
            tool_call_id: call.id,
            content: toolResult.text,
          });
          updateAssistant(assistantMessage.id, (message) => ({ ...message, toolEvents }));
        }

        if (round === 4) throw new Error("MCP 도구 호출 한도에 도달했습니다.");
      }

      const completedResponse: ChatMessage = {
        ...assistantMessage,
        content: accumulated,
        reasoning: accumulatedReasoning || undefined,
        usage: usage.total > 0 ? usage : undefined,
        finishReason: finishReason || "unknown",
        toolEvents,
        contextTrim,
      };
      const completedVariant = variantTarget
        ? responseVariantFromMessage(completedResponse)
        : undefined;
      const finishedAssistant: ChatMessage = completedVariant
        ? {
            ...completedResponse,
            responseVariants: [...(preservedVariants || []), completedVariant],
            activeResponseVariantId: completedVariant.id,
          }
        : completedResponse;
      const finished: Conversation = {
        ...workingConversation,
        updatedAt: timestamp(),
        messages: [...baseMessages, finishedAssistant],
      };
      commitConversation(finished);
      await recoverableSave;
      await saveConversation(finished);
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === "AbortError";
      const failedResponse: ChatMessage = {
        ...assistantMessage,
        content: accumulated || (aborted ? "생성이 중지되었습니다." : readableError(error)),
        reasoning: accumulatedReasoning || undefined,
        usage: usage.total > 0 ? usage : undefined,
        toolEvents,
        contextTrim,
        error: !aborted,
      };
      const failedVariant = variantTarget
        ? responseVariantFromMessage(failedResponse)
        : undefined;
      const failedAssistant: ChatMessage = failedVariant
        ? {
            ...failedResponse,
            responseVariants: [...(preservedVariants || []), failedVariant],
            activeResponseVariantId: failedVariant.id,
          }
        : failedResponse;
      const failed: Conversation = {
        ...workingConversation,
        updatedAt: timestamp(),
        messages: [...baseMessages, failedAssistant],
      };
      commitConversation(failed);
      await recoverableSave;
      await saveConversation(failed);
    } finally {
      abortRef.current = null;
      setGenerating(false);
      window.setTimeout(() => textareaRef.current?.focus(), 0);
    }
  };

  const send = async () => {
    if (generating || !validateSend()) return;
    setComposerError("");
    const userMessage: ChatMessage = {
      id: id("msg"),
      role: "user",
      content: input.trim(),
      attachments,
      createdAt: timestamp(),
    };
    const baseMessages = [...conversation.messages, userMessage];
    const seedConversation: Conversation = {
      ...conversation,
      messages: baseMessages,
    };
    setInput("");
    setAttachments([]);
    await generateResponse(baseMessages, seedConversation);
  };

  const createConversationBranch = async (sourceMessages: ChatMessage[]): Promise<Conversation> => {
    const messages = cloneMessagesForBranch(sourceMessages);
    const suffix = " · 분기";
    const sourceTitle = conversation.title.trim() || titleFromMessages(messages);
    const now = timestamp();
    const branch: Conversation = {
      id: id("chat"),
      title: `${sourceTitle.slice(0, 80 - suffix.length)}${suffix}`,
      titleEdited: true,
      createdAt: now,
      updatedAt: now,
      settings: { ...conversation.settings },
      messages,
    };

    cancelEditMessage();
    setRenamingConversationId("");
    setInput("");
    setAttachments([]);
    setComposerError("");
    setSidebarOpen(false);
    commitConversation(branch);
    setSettings((current) => syncAppDefaults(current, branch.settings));
    await saveConversation(branch);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
    return branch;
  };

  const branchConversation = async (messageId: string) => {
    if (generating) return;
    const messageIndex = conversation.messages.findIndex((message) => message.id === messageId);
    if (messageIndex < 0) return;
    await createConversationBranch(conversation.messages.slice(0, messageIndex + 1));
  };

  const selectResponseVariant = async (messageId: string, variantId: string) => {
    if (generating) return;
    const messageIndex = conversation.messages.findIndex((message) => message.id === messageId);
    if (messageIndex < 0) return;
    const message = conversation.messages[messageIndex];
    const variant = message.responseVariants?.find((item) => item.id === variantId);
    if (!variant || variant.id === message.activeResponseVariantId) return;

    const selectedMessage = applyResponseVariant(message, variant);
    if (messageIndex < conversation.messages.length - 1) {
      await createConversationBranch([
        ...conversation.messages.slice(0, messageIndex),
        selectedMessage,
      ]);
      return;
    }

    const next: Conversation = {
      ...conversation,
      updatedAt: timestamp(),
      messages: conversation.messages.map((item) =>
        item.id === messageId ? selectedMessage : item,
      ),
    };
    commitConversation(next);
    await saveConversation(next);
  };

  const useReasoningAsContent = async (messageId: string) => {
    if (generating) return;
    const target = conversation.messages.find((message) => message.id === messageId);
    if (!target?.reasoning?.trim() || target.content.trim()) return;

    const content = target.reasoning;
    const responseVariants = target.responseVariants?.map((variant) =>
      variant.id === target.activeResponseVariantId
        ? { ...variant, content, reasoning: undefined }
        : variant,
    );
    const messages = conversation.messages.map((message) =>
      message.id === messageId
        ? { ...message, content, reasoning: undefined, responseVariants }
        : message,
    );
    const next: Conversation = {
      ...conversation,
      updatedAt: timestamp(),
      messages,
    };
    commitConversation(next);
    await saveConversation(next);
  };

  const rerollMessage = async (messageId: string) => {
    if (generating) return;
    const messageIndex = conversation.messages.findIndex((message) => message.id === messageId);
    if (messageIndex < 0) return;
    const selected = conversation.messages[messageIndex];
    const following = conversation.messages[messageIndex + 1];
    const variantTarget = selected.role === "assistant"
      ? selected
      : following?.role === "assistant"
        ? following
        : undefined;
    const variantTargetIndex = variantTarget
      ? conversation.messages.findIndex((message) => message.id === variantTarget.id)
      : -1;
    const hasFollowingConversation = variantTarget
      ? variantTargetIndex < conversation.messages.length - 1
      : messageIndex < conversation.messages.length - 1;
    const keepCount = selected.role === "user" ? messageIndex + 1 : messageIndex;
    const baseMessages = conversation.messages.slice(0, keepCount);
    if (!baseMessages.some((message) => message.role === "user")) return;
    cancelEditMessage();
    setComposerError("");
    if (hasFollowingConversation) {
      const branch = await createConversationBranch(baseMessages);
      await generateResponse(branch.messages, branch);
      return;
    }
    await generateResponse(
      baseMessages,
      { ...conversation, messages: baseMessages },
      variantTarget,
    );
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      if (generating) return;
      event.preventDefault();
      void send();
    }
  };

  const stableCopyMessage = useEventCallback(copyMessage);
  const stableBeginEditMessage = useEventCallback(beginEditMessage);
  const stableCancelEditMessage = useEventCallback(cancelEditMessage);
  const stableSaveMessageEdit = useEventCallback(saveMessageEdit);
  const stableBranchConversation = useEventCallback(branchConversation);
  const stableSelectResponseVariant = useEventCallback(selectResponseVariant);
  const stableUseReasoningAsContent = useEventCallback(useReasoningAsContent);
  const stableRerollMessage = useEventCallback(rerollMessage);
  const stableRemoveMessage = useEventCallback(removeMessage);

  return (
    <main className="app-shell">
      <button
        className={`mobile-backdrop ${sidebarOpen ? "is-open" : ""}`}
        onClick={() => setSidebarOpen(false)}
        aria-label="대화 목록 닫기"
      />

      <aside className={`sidebar ${sidebarOpen ? "is-open" : ""}`}>
        <div className="brand-row">
          <div className="brand-mark"><Bot size={17} /></div>
          <span>SIMPLE AI</span>
          <button className="sidebar-close" onClick={() => setSidebarOpen(false)} aria-label="닫기">
            <X size={18} />
          </button>
        </div>

        <button className="new-chat-button" type="button" onClick={startNewConversation}>
          <Plus size={16} />
          새 대화
          <kbd>Ctrl K</kbd>
        </button>

        <div className="history-header">
          <span>최근 대화</span>
          <span>{history.length}</span>
        </div>

        <nav className="history-list" aria-label="최근 대화">
          {history.length === 0 && hydrated && (
            <div className="history-empty">저장된 대화 없음</div>
          )}
          {history.map((item) => (
            <div
              key={item.id}
              className={`history-item ${conversation.id === item.id ? "active" : ""}`}
            >
              {renamingConversationId === item.id ? (
                <form
                  className="history-rename"
                  onSubmit={(event) => {
                    event.preventDefault();
                    saveConversationTitle(item);
                  }}
                >
                  <input
                    value={conversationTitleDraft}
                    maxLength={80}
                    autoFocus
                    aria-label="대화 제목"
                    onChange={(event) => setConversationTitleDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setRenamingConversationId("");
                        setConversationTitleDraft("");
                      }
                    }}
                  />
                  <button type="submit" aria-label="제목 저장" disabled={!conversationTitleDraft.trim()}>
                    <Check size={13} />
                  </button>
                  <button
                    type="button"
                    aria-label="제목 변경 취소"
                    onClick={() => {
                      setRenamingConversationId("");
                      setConversationTitleDraft("");
                    }}
                  >
                    <X size={13} />
                  </button>
                </form>
              ) : (
                <>
                  <button
                    type="button"
                    className="history-select"
                    onClick={() => selectConversation(item)}
                  >
                    <MessageSquare size={14} />
                    <span className="history-copy">
                      <strong>{item.title}</strong>
                      <small>{item.settings.model || "모델 미설정"} · {formatDate(item.updatedAt)}</small>
                    </span>
                  </button>
                  <div className="history-actions">
                    <button
                      type="button"
                      onClick={() => beginConversationRename(item)}
                      disabled={generating}
                      aria-label={`${item.title} 제목 변경`}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      type="button"
                      className="history-delete"
                      onClick={(event) => void removeConversation(event, item)}
                      aria-label={`${item.title} 삭제`}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          <button
            type="button"
            onClick={() => setSettings((current) => ({
              ...current,
              theme: current.theme === "dark" ? "light" : "dark",
            }))}
            aria-label="테마 전환"
          >
            {settings.theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
          </button>
        </div>
      </aside>

      <section className="chat-column">
        <header className="topbar">
          <div className="topbar-left">
            <button className="menu-button" type="button" onClick={() => setSidebarOpen(true)} aria-label="대화 목록">
              <Menu size={19} />
            </button>
            <div className="model-identity">
              <strong>{activeProvider.model || "모델 미설정"}</strong>
              <span>{activeProvider.name}</span>
            </div>
          </div>

          <div className="topbar-actions">
            {totalUsage.total > 0 && (
              <div className="usage-strip" aria-label="현재 대화 누적 토큰 사용량">
                <span>TOTAL</span>
                <span>IN <strong>{formatTokens(totalUsage.input)}</strong></span>
                <span>OUT <strong>{formatTokens(totalUsage.output)}</strong></span>
                {(totalUsage.reasoning || 0) > 0 && (
                  <span>THINK <strong>{formatTokens(totalUsage.reasoning || 0)}</strong></span>
                )}
                {totalUsage.cached > 0 && <span>CACHE <strong>{formatTokens(totalUsage.cached)}</strong></span>}
              </div>
            )}
            {settings.mcpEnabled && (
              <span className={`mcp-indicator ${mcpStatus}`}>
                <Wrench size={13} /> MCP
              </span>
            )}
            <button className="settings-button" type="button" onClick={() => setSettingsOpen(true)} aria-label="설정">
              <Settings2 size={16} />
              <span>설정</span>
            </button>
          </div>
        </header>

        <div className="messages-scroll" ref={scrollRef} onScroll={handleMessagesScroll}>
          {conversation.messages.length === 0 && !conversation.settings.openingMessage.trim() ? (
            <div className="empty-state">
              <div className="empty-orbit"><Bot size={27} /></div>
              <span className="eyebrow">OPENAI-COMPATIBLE WORKSPACE</span>
              <div className="session-facts">
                <span>{activeProvider.name}</span>
                <span>{activeProvider.model || "모델 미설정"}</span>
                <span>{activeProvider.vision ? "Vision ON" : "Vision OFF"}</span>
              </div>
              <div className="prompt-presets">
                {["코드 검토", "문서 요약", "이미지 분석"].map((label) => (
                  <button key={label} type="button" onClick={() => {
                    setInput(label === "이미지 분석" ? "첨부 이미지의 핵심 요소를 분석해줘." : `${label}를 진행해줘.`);
                    textareaRef.current?.focus();
                  }}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <MessageList
              messages={conversation.messages}
              openingMessage={conversation.settings.openingMessage}
              imageWidth={settings.markdownImageWidth}
              editingMessageId={editingMessageId}
              editingContent={editingContent}
              copiedId={copiedId}
              disabled={generating}
              onCopy={stableCopyMessage}
              onBeginEdit={stableBeginEditMessage}
              onEditContentChange={setEditingContent}
              onCancelEdit={stableCancelEditMessage}
              onSaveEdit={stableSaveMessageEdit}
              onReroll={stableRerollMessage}
              onBranch={stableBranchConversation}
              onSelectVariant={stableSelectResponseVariant}
              onUseReasoningAsContent={stableUseReasoningAsContent}
              onRemove={stableRemoveMessage}
            />
          )}
        </div>

        <div
          className={`composer-zone ${isDraggingFiles ? "is-file-dragging" : ""}`}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {isDraggingFiles && (
            <div className="drop-overlay" role="status" aria-live="polite">
              <UploadCloud size={22} />
              <strong>파일을 놓아 첨부</strong>
              <span>이미지 · 텍스트 · 코드</span>
            </div>
          )}
          {conversation.settings.systemPrompt && (
            <button className="system-chip" type="button" onClick={() => setSettingsOpen(true)}>
              SYSTEM <span>{conversation.settings.systemPrompt.slice(0, 60)}</span> <ChevronDown size={13} />
            </button>
          )}

          {attachments.length > 0 && (
            <div className="attachment-tray">
              {attachments.map((attachment) => (
                <div key={attachment.id} className="attachment-card">
                  {attachment.kind === "image" && attachment.dataUrl ? (
                    <img src={attachment.dataUrl} alt="" />
                  ) : (
                    <FileCode2 size={18} />
                  )}
                  <span>
                    <strong>{attachment.name}</strong>
                    <small>
                      {attachment.kind === "image" ? attachment.type.replace("image/", "").toUpperCase() : "TEXT"}
                      {` · ${formatBytes(attachment.size)}`}
                      {attachment.originalSize
                        ? ` · 원본 ${formatBytes(attachment.originalSize)}`
                        : ""}
                    </small>
                  </span>
                  <button type="button" onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))} aria-label={`${attachment.name} 제거`}>
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {optimizingImages && (
            <div className="attachment-processing" role="status">
              이미지 WebP 최적화 중…
            </div>
          )}

          {composerError && <div className="composer-error">{composerError}</div>}

          <div className="composer">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(event) => {
                setInput(event.target.value);
                setComposerError("");
              }}
              onPaste={handleComposerPaste}
              onKeyDown={handleComposerKeyDown}
              placeholder="메시지 입력"
              rows={1}
              aria-label="메시지"
            />
            <div className="composer-toolbar">
              <div className="composer-tools">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  hidden
                  disabled={optimizingImages}
                  accept="image/*,.txt,.md,.markdown,.csv,.tsv,.json,.jsonl,.xml,.yaml,.yml,.html,.css,.js,.jsx,.ts,.tsx,.py,.java,.kt,.go,.rs,.c,.h,.cpp,.cs,.php,.rb,.swift,.sql,.sh,.ps1,.bat,.ini,.toml,.log"
                  onChange={handleFiles}
                />
                <button type="button" onClick={() => fileInputRef.current?.click()} aria-label="파일 첨부">
                  <Paperclip size={17} />
                </button>
                <select
                  className="composer-preset-select"
                  value={conversation.settings.providerPresetId}
                  onChange={(event) => swapConversationProvider(event.target.value)}
                  disabled={generating}
                  aria-label="API 프리셋 빠른 전환"
                  title="API 프리셋"
                >
                  {settings.providerPresets.map((preset) => (
                    <option key={preset.id} value={preset.id}>{preset.name}</option>
                  ))}
                </select>
                <span className={`vision-badge ${activeProvider.vision ? "on" : ""}`}>
                  <ImageIcon size={13} /> VISION {activeProvider.vision ? "ON" : "OFF"}
                </span>
              </div>
              <div className="composer-submit">
                <span>{generating ? "응답 완료 후 전송 가능" : "Enter 전송 · Shift+Enter 줄바꿈"}</span>
                {generating ? (
                  <button className="send-button stop" type="button" onClick={() => abortRef.current?.abort()} aria-label="생성 중지">
                    <Square size={13} fill="currentColor" />
                  </button>
                ) : (
                  <button
                    className="send-button"
                    type="button"
                    onClick={() => void send()}
                    disabled={optimizingImages || (!input.trim() && !attachments.length)}
                    aria-label="전송"
                  >
                    <ArrowUp size={17} />
                  </button>
                )}
              </div>
            </div>
          </div>
          <p className="local-note">키와 대화 데이터는 설정된 브라우저 저장소 범위에서만 처리됩니다.</p>
        </div>
      </section>

      <SettingsPanel
        open={settingsOpen}
        conversationId={conversation.id}
        settings={settings}
        conversationSettings={conversation.settings}
        mcpStatus={mcpStatus}
        mcpError={mcpError}
        mcpTools={mcpTools}
        onChange={changeSettings}
        onConversationChange={changeConversationSettings}
        onClose={() => setSettingsOpen(false)}
        onConnectMcp={() => void connectMcp()}
      />
    </main>
  );
}
