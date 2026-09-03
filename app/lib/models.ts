import {
  DEFAULT_MODEL_PRESET, getActiveProvider, getProviderModel,
  type AppSettings, type Conversation, type ConversationSettings,
  type ModelPreset, type ProviderPreset,
} from "../types";
import { configuredReasoningLevels, normalizeReasoning, resolvePresetReasoning } from "./reasoning";

export function normalizeOutputLimit(value: unknown, fallback = DEFAULT_MODEL_PRESET.maxTokens): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

export function normalizeContextLimit(value: unknown, fallback = DEFAULT_MODEL_PRESET.contextLimit): number {
  return Number.isSafeInteger(value) && (value === -1 || Number(value) >= 2048) ? Number(value) : fallback;
}

export function normalizeModel(
  value: Partial<ModelPreset>,
  id: string,
  limits: Pick<ModelPreset, "maxTokens" | "contextLimit"> = DEFAULT_MODEL_PRESET,
): ModelPreset {
  const reasoning = normalizeReasoning(value.reasoning);
  const reasoningLevels = configuredReasoningLevels(reasoning, value.reasoningLevels);
  return {
    id,
    model: typeof value.model === "string" ? value.model : "",
    vision: Boolean(value.vision),
    extraBody: typeof value.extraBody === "string" ? value.extraBody : "",
    reasoning: resolvePresetReasoning({ reasoning, reasoningLevels }),
    reasoningLevels,
    maxTokens: normalizeOutputLimit(value.maxTokens, limits.maxTokens),
    contextLimit: normalizeContextLimit(value.contextLimit, limits.contextLimit),
  };
}

export function modelPresetLabel(provider: ProviderPreset, model: ModelPreset): string {
  const label = model.model || "모델 미설정";
  return provider.models.filter((item) => item.model === model.model).length > 1
    ? `${label} · 출력 ${model.maxTokens} · 컨텍스트 ${model.contextLimit}` : label;
}

export function selectConversationModel(
  current: ConversationSettings,
  provider: ProviderPreset,
  modelId?: string,
): ConversationSettings {
  const model = getProviderModel(provider, modelId);
  return {
    ...current,
    providerPresetId: provider.id,
    modelPresetId: model.id,
    model: model.model,
    vision: model.vision,
    maxTokens: model.maxTokens,
    contextLimit: model.contextLimit,
    reasoning: resolvePresetReasoning(model),
  };
}

export function normalizeConversationSettings(
  stored: Partial<ConversationSettings> | undefined,
  app: AppSettings,
): ConversationSettings {
  const provider = app.providerPresets.find((item) => item.id === stored?.providerPresetId) || getActiveProvider(app);
  const model = getProviderModel(provider, stored?.modelPresetId);
  return {
    providerPresetId: provider.id,
    modelPresetId: model.id,
    model: model.model,
    vision: typeof stored?.vision === "boolean" ? stored.vision : model.vision,
    systemPrompt: typeof stored?.systemPrompt === "string" ? stored.systemPrompt : app.systemPrompt,
    openingMessage: typeof stored?.openingMessage === "string" ? stored.openingMessage : "",
    temperature: typeof stored?.temperature === "number" ? stored.temperature : app.temperature,
    maxTokens: model.maxTokens,
    contextLimit: model.contextLimit,
    historyTurns: typeof stored?.historyTurns === "number" && (stored.historyTurns === -1 || stored.historyTurns >= 1)
      ? Math.floor(stored.historyTurns) : app.historyTurns,
    autoTrimContext: typeof stored?.autoTrimContext === "boolean" ? stored.autoTrimContext : app.autoTrimContext,
    stream: typeof stored?.stream === "boolean" ? stored.stream : app.stream,
    reasoning: resolvePresetReasoning(model, stored?.reasoning?.level),
  };
}

export function conversationSettingsFromApp(app: AppSettings): ConversationSettings {
  const provider = getActiveProvider(app);
  const model = getProviderModel(provider);
  return normalizeConversationSettings({
    providerPresetId: provider.id, modelPresetId: model.id, systemPrompt: "", openingMessage: "",
  }, app);
}

export function syncAppDefaults(app: AppSettings, current: ConversationSettings): AppSettings {
  return {
    ...app,
    activeProviderId: current.providerPresetId,
    systemPrompt: "",
    temperature: current.temperature,
    historyTurns: current.historyTurns,
    autoTrimContext: current.autoTrimContext,
    stream: current.stream,
    providerPresets: app.providerPresets.map((provider) => provider.id === current.providerPresetId
      ? { ...provider, defaultModelId: current.modelPresetId } : provider),
  };
}

export function reconcileConversationModel(
  previous: AppSettings,
  next: AppSettings,
  current: ConversationSettings,
): ConversationSettings {
  const provider = getActiveProvider(next);
  const oldProvider = previous.providerPresets.find((item) => item.id === current.providerPresetId);
  if (provider.id !== current.providerPresetId || provider.defaultModelId !== oldProvider?.defaultModelId) {
    return selectConversationModel(current, provider);
  }
  const model = getProviderModel(provider, current.modelPresetId);
  if (model.id !== current.modelPresetId) return selectConversationModel(current, provider, model.id);
  const oldModel = oldProvider?.models.find((item) => item.id === current.modelPresetId);
  const updated = {
    ...current,
    model: model.model,
    maxTokens: model.maxTokens,
    contextLimit: model.contextLimit,
    vision: model.vision !== oldModel?.vision ? model.vision : current.vision,
    reasoning: resolvePresetReasoning(model,
      model.reasoning !== oldModel?.reasoning || model.reasoningLevels !== oldModel?.reasoningLevels
        ? undefined : current.reasoning.level),
  };
  const sameReasoning = updated.reasoning.format === current.reasoning.format
    && updated.reasoning.level === current.reasoning.level && updated.reasoning.budget === current.reasoning.budget
    && updated.reasoning.customMapping === current.reasoning.customMapping;
  return updated.model === current.model && updated.maxTokens === current.maxTokens
    && updated.contextLimit === current.contextLimit && updated.vision === current.vision && sameReasoning
    ? current : updated;
}

// Legacy conversations may contain a model or limits different from their old preset.
// Preserve each distinct configuration instead of overwriting a shared model on load.
export function migrateConversationModels(app: AppSettings, items: Conversation[]): {
  settings: AppSettings; conversations: Conversation[];
} {
  let settings = app;
  const conversations = items.map((conversation) => {
    const stored = conversation.settings as Partial<ConversationSettings> | undefined;
    if (!stored || stored.modelPresetId) return conversation;
    const provider = settings.providerPresets.find((item) => item.id === stored.providerPresetId);
    if (!provider) return conversation;
    const fallback = getProviderModel(provider);
    const modelName = typeof stored.model === "string" ? stored.model : fallback.model;
    const maxTokens = normalizeOutputLimit(stored.maxTokens, fallback.maxTokens);
    const contextLimit = normalizeContextLimit(stored.contextLimit, fallback.contextLimit);
    let model = provider.models.find((item) => item.model === modelName
      && item.maxTokens === maxTokens && item.contextLimit === contextLimit);
    if (!model) {
      let modelId = `legacy-${conversation.id}`;
      while (provider.models.some((item) => item.id === modelId)) modelId += "_";
      model = { ...fallback, id: modelId, model: modelName, maxTokens, contextLimit };
      settings = { ...settings, providerPresets: settings.providerPresets.map((item) => item.id === provider.id
        ? { ...item, models: [...item.models, model!] } : item) };
    }
    return { ...conversation, settings: { ...stored, modelPresetId: model.id } as ConversationSettings };
  });
  return { settings, conversations };
}
