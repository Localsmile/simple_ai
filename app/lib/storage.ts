import type { AppSettings, Conversation, ProviderPreset, McpServerConfig, McpAuthType } from "../types";
import { DEFAULT_PROVIDER_PRESET, DEFAULT_SETTINGS } from "../types";
import { normalizeReasoning } from "./reasoning";

const DB_NAME = "simple-ai";
const DB_VERSION = 1;
const STORE_NAME = "conversations";
const SETTINGS_KEY = "simple-ai:settings";
const PRESET_KEYS_KEY = "simple-ai:provider-keys";
const LEGACY_API_KEY = "simple-ai:api-key";
const MCP_TOKEN_KEY = "simple-ai:mcp-token";
const MCP_TOKENS_KEY = "simple-ai:mcp-tokens";
const CREDENTIAL_DEFAULT_MIGRATION_KEY = "simple-ai:credential-default-v1";
const MAX_CONVERSATIONS = 30;

interface LegacySettings {
  baseUrl?: string;
  model?: string;
  vision?: boolean;
  mcpUrl?: string;
  mcpAuthType?: McpAuthType;
  mcpToken?: string;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function runTransaction<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDatabase().then(
    (database) =>
      new Promise<T>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, mode);
        const request = action(transaction.objectStore(STORE_NAME));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => database.close();
        transaction.onerror = () => reject(transaction.error);
      }),
  );
}

export async function listConversations(): Promise<Conversation[]> {
  if (typeof indexedDB === "undefined") return [];
  const rows = await runTransaction<Conversation[]>("readonly", (store) => store.getAll());
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveConversation(
  conversation: Conversation,
  pruneHistory = true,
): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  await runTransaction("readwrite", (store) => store.put(conversation));
  if (!pruneHistory) return;

  const conversations = await listConversations();
  const overflow = conversations.slice(MAX_CONVERSATIONS);
  await Promise.all(overflow.map((item) => deleteConversation(item.id)));
}

export async function deleteConversation(id: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  await runTransaction("readwrite", (store) => store.delete(id));
}

export async function clearConversations(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  await runTransaction("readwrite", (store) => store.clear());
}

function readJson<T>(storage: Storage, key: string, fallback: T): T {
  try {
    return JSON.parse(storage.getItem(key) || "") as T;
  } catch {
    return fallback;
  }
}

function normalizePresets(saved: Partial<AppSettings> & LegacySettings): ProviderPreset[] {
  if (Array.isArray(saved.providerPresets) && saved.providerPresets.length) {
    return saved.providerPresets.map((preset, index) => ({
      id: typeof preset.id === "string" && preset.id ? preset.id : `preset-${index + 1}`,
      name: typeof preset.name === "string" && preset.name ? preset.name : `연결 ${index + 1}`,
      baseUrl: typeof preset.baseUrl === "string" ? preset.baseUrl : "",
      apiKey: "",
      model: typeof preset.model === "string" ? preset.model : "",
      vision: Boolean(preset.vision),
      extraBody: typeof preset.extraBody === "string" ? preset.extraBody : "",
      reasoning: normalizeReasoning(preset.reasoning),
    }));
  }

  return [{
    ...DEFAULT_PROVIDER_PRESET,
    baseUrl: typeof saved.baseUrl === "string" ? saved.baseUrl : "",
    model: typeof saved.model === "string" ? saved.model : "",
    vision: Boolean(saved.vision),
  }];
}

export function normalizeMcpServers(saved: Partial<AppSettings> & LegacySettings): McpServerConfig[] {
  if (Array.isArray(saved.mcpServers)) {
    const ids = new Set<string>();
    return saved.mcpServers.map((server, index) => {
      let id = typeof server.id === "string" && server.id ? server.id : `mcp-${index}`;
      while (ids.has(id)) id += "_";
      ids.add(id);
      return {
        id,
        name: typeof server.name === "string" ? server.name : `MCP ${index + 1}`,
        url: typeof server.url === "string" ? server.url : "",
        authType: server.authType === "bearer" || server.authType === "x-api-key"
          ? server.authType : "none",
        token: "",
        enabled: Boolean(server.enabled),
        selectedTools: server.selectedTools === null ? null : Array.isArray(server.selectedTools)
          ? [...new Set(server.selectedTools.filter((name) => typeof name === "string"))] : [],
      };
    });
  }
  return saved.mcpUrl ? [{
    id: "mcp-legacy",
    name: "MCP 1",
    url: saved.mcpUrl,
    authType: saved.mcpAuthType === "bearer" || saved.mcpAuthType === "x-api-key"
      ? saved.mcpAuthType : "none",
    token: "",
    enabled: true,
    selectedTools: null,
  }] : [];
}

export function loadSettings(): AppSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;

  const saved = readJson<Partial<AppSettings> & LegacySettings>(localStorage, SETTINGS_KEY, {});
  const applyCredentialDefault = localStorage.getItem(CREDENTIAL_DEFAULT_MIGRATION_KEY) !== "1";
  const storedRememberCredentials = typeof saved.rememberCredentials === "boolean"
    ? saved.rememberCredentials
    : DEFAULT_SETTINGS.rememberCredentials;
  const rememberCredentials = applyCredentialDefault
    ? DEFAULT_SETTINGS.rememberCredentials
    : storedRememberCredentials;
  const credentialStore = applyCredentialDefault && saved.rememberCredentials === false
    ? sessionStorage
    : rememberCredentials ? localStorage : sessionStorage;
  const providerPresets = normalizePresets(saved);
  const keyMap = readJson<Record<string, string>>(credentialStore, PRESET_KEYS_KEY, {});
  const legacyKey = credentialStore.getItem(LEGACY_API_KEY) || "";
  const presetsWithKeys = providerPresets.map((preset, index) => ({
    ...preset,
    apiKey: keyMap[preset.id] || (index === 0 ? legacyKey : ""),
  }));
  const requestedActiveId = typeof saved.activeProviderId === "string" ? saved.activeProviderId : "";
  const activeProviderId = presetsWithKeys.some((preset) => preset.id === requestedActiveId)
    ? requestedActiveId
    : presetsWithKeys[0].id;
  const mcpTokens = readJson<Record<string, string>>(credentialStore, MCP_TOKENS_KEY, {});
  const legacyMcpToken = Array.isArray(saved.mcpServers) ? "" : credentialStore.getItem(MCP_TOKEN_KEY) || "";
  const mcpServers = normalizeMcpServers(saved).map((server) => ({
    ...server, token: mcpTokens[server.id] || legacyMcpToken,
  }));

  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    providerPresets: presetsWithKeys,
    activeProviderId,
    rememberCredentials,
    sendKey: saved.sendKey === "enter" || saved.sendKey === "ctrl-enter" ? saved.sendKey : "auto",
    mcpServers,
    mcpToolLimit: Number.isSafeInteger(saved.mcpToolLimit) && saved.mcpToolLimit! > 0
      ? Math.min(128, saved.mcpToolLimit!) : DEFAULT_SETTINGS.mcpToolLimit,
    markdownImageWidth: typeof saved.markdownImageWidth === "number"
      ? Math.min(100, Math.max(30, saved.markdownImageWidth))
      : DEFAULT_SETTINGS.markdownImageWidth,
  };
}

export function saveSettings(settings: AppSettings): void {
  if (typeof window === "undefined") return;

  const safeSettings = {
    ...settings,
    mcpServers: settings.mcpServers.map(({ token: _token, ...server }) => {
      void _token;
      return server;
    }),
    providerPresets: settings.providerPresets.map((preset) => ({
      id: preset.id,
      name: preset.name,
      baseUrl: preset.baseUrl,
      model: preset.model,
      vision: preset.vision,
      extraBody: preset.extraBody,
      reasoning: preset.reasoning,
    })),
  };
  for (const key of ["mcpUrl", "mcpAuthType", "mcpToken"] as const) {
    delete (safeSettings as Partial<LegacySettings>)[key];
  }
  const providerKeys = Object.fromEntries(
    settings.providerPresets
      .filter((preset) => preset.apiKey)
      .map((preset) => [preset.id, preset.apiKey]),
  );
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(safeSettings));
  localStorage.setItem(CREDENTIAL_DEFAULT_MIGRATION_KEY, "1");

  const activeStore = settings.rememberCredentials ? localStorage : sessionStorage;
  const inactiveStore = settings.rememberCredentials ? sessionStorage : localStorage;
  activeStore.setItem(PRESET_KEYS_KEY, JSON.stringify(providerKeys));
  activeStore.setItem(MCP_TOKENS_KEY, JSON.stringify(Object.fromEntries(
    settings.mcpServers.filter((server) => server.token).map((server) => [server.id, server.token]),
  )));
  inactiveStore.removeItem(PRESET_KEYS_KEY);
  inactiveStore.removeItem(MCP_TOKENS_KEY);
  localStorage.removeItem(MCP_TOKEN_KEY);
  sessionStorage.removeItem(MCP_TOKEN_KEY);
  localStorage.removeItem(LEGACY_API_KEY);
  sessionStorage.removeItem(LEGACY_API_KEY);
}
