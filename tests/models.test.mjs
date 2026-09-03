import assert from "node:assert/strict";
import test from "node:test";
import { loadTs, memoryStorage } from "./load-ts.mjs";

const {
  DEFAULT_SETTINGS, DEFAULT_PROVIDER_PRESET, DEFAULT_MODEL_PRESET, DEFAULT_REASONING,
  getProviderModel, resolveProviderModel,
} = loadTs("app/types.ts");
const {
  conversationSettingsFromApp, selectConversationModel, normalizeConversationSettings,
  reconcileConversationModel, migrateConversationModels, syncAppDefaults, normalizeModel,
} = loadTs("app/lib/models.ts");

function fixture() {
  const models = [
    { ...DEFAULT_MODEL_PRESET, id: "small", model: "custom/small", maxTokens: 7000, contextLimit: 64000,
      reasoning: { ...DEFAULT_REASONING, level: "low" }, reasoningLevels: ["low", "high"] },
    { ...DEFAULT_MODEL_PRESET, id: "large", model: "custom/large", maxTokens: 200000, contextLimit: 1000000,
      vision: true, extraBody: '{"top_p":0.8}',
      reasoning: { ...DEFAULT_REASONING, format: "reasoning", level: "budget", budget: 8192 },
      reasoningLevels: ["default", "budget"] },
  ];
  const provider = { ...DEFAULT_PROVIDER_PRESET, name: "Custom", baseUrl: "https://custom.test/v1",
    apiKey: "fixture-key", models, defaultModelId: models[0].id };
  return { ...DEFAULT_SETTINGS, providerPresets: [provider], activeProviderId: provider.id };
}

function storage() {
  const localStorage = memoryStorage(), sessionStorage = memoryStorage();
  return { localStorage, sessionStorage,
    ...loadTs("app/lib/storage.ts", { window: {}, localStorage, sessionStorage }) };
}

test("provider owns one credential pair while independent model profiles survive storage", () => {
  const { localStorage, sessionStorage, saveSettings, loadSettings } = storage();
  const app = fixture();
  saveSettings(app);
  const restored = loadSettings();
  assert.deepEqual(restored.providerPresets, app.providerPresets);
  const safe = JSON.parse(localStorage.getItem("simple-ai:settings"));
  assert.doesNotMatch(JSON.stringify(safe), /fixture-key/);
  const provider = safe.providerPresets[0];
  assert.equal(provider.model, undefined);
  assert.equal(provider.reasoning, undefined);
  assert.equal(provider.maxTokens, undefined);
  assert.ok(provider.models.every((model) => model.apiKey === undefined && model.baseUrl === undefined));
  assert.deepEqual(JSON.parse(localStorage.getItem("simple-ai:provider-keys")), { default: "fixture-key" });
  saveSettings({ ...restored, rememberCredentials: false });
  assert.equal(localStorage.getItem("simple-ai:provider-keys"), null);
  assert.match(sessionStorage.getItem("simple-ai:provider-keys"), /fixture-key/);
  assert.equal(loadSettings().providerPresets[0].apiKey, "fixture-key");
});

test("flat presets migrate without merging distinct provider names or keys", () => {
  const { localStorage, loadSettings, saveSettings } = storage();
  const legacy = { id: "first", name: "First", baseUrl: "https://custom.test/v1", model: "old/model",
    connectionMode: "cors-proxy", vision: true, extraBody: '{"top_k":12}',
    reasoning: { ...DEFAULT_REASONING, level: "high" }, reasoningLevels: ["low", "high"] };
  localStorage.setItem("simple-ai:settings", JSON.stringify({
    activeProviderId: "second", maxTokens: 96000, contextLimit: -1,
    providerPresets: [legacy, { ...legacy, id: "second", name: "Second" }],
  }));
  localStorage.setItem("simple-ai:provider-keys", JSON.stringify({ first: "key-a", second: "key-b" }));
  const result = loadSettings();
  assert.equal(result.providerPresets.length, 2);
  assert.deepEqual(result.providerPresets.map((p) => [p.name, p.apiKey]), [["First", "key-a"], ["Second", "key-b"]]);
  assert.equal(result.activeProviderId, "second");
  const model = getProviderModel(result.providerPresets[0]);
  assert.equal(model.model, "old/model");
  assert.equal(model.maxTokens, 96000);
  assert.equal(model.contextLimit, -1);
  assert.equal(model.extraBody, legacy.extraBody);
  assert.deepEqual(model.reasoning, legacy.reasoning);
  saveSettings(result);
  assert.deepEqual(loadSettings().providerPresets, result.providerPresets);
});

test("old conversation models and distinct token limits migrate losslessly and idempotently", () => {
  const app = fixture();
  const original = JSON.stringify(app);
  const legacy = (id, model, maxTokens, contextLimit) => ({ id, title: id, messages: [], settings: {
    providerPresetId: "default", model, maxTokens, contextLimit,
    systemPrompt: "private system", openingMessage: "![image](https://img.test/a.png)",
  } });
  const items = [legacy("a", "older/model", 5000, -1), legacy("b", "older/model", 5000, -1),
    legacy("c", "custom/small", 9000, 131072), legacy("d", "custom/small", 7000, 64000)];
  const migrated = migrateConversationModels(app, items);
  assert.equal(JSON.stringify(app), original);
  assert.equal(items[0].settings.modelPresetId, undefined);
  assert.equal(migrated.settings.providerPresets[0].models.length, 4);
  assert.equal(migrated.conversations[0].settings.modelPresetId, migrated.conversations[1].settings.modelPresetId);
  assert.equal(migrated.conversations[3].settings.modelPresetId, "small");
  for (const [index, conversation] of migrated.conversations.entries()) {
    const normalized = normalizeConversationSettings(conversation.settings, migrated.settings);
    assert.equal(normalized.model, items[index].settings.model);
    assert.equal(normalized.maxTokens, items[index].settings.maxTokens);
    assert.equal(normalized.contextLimit, items[index].settings.contextLimit);
    assert.equal(normalized.systemPrompt, "private system");
    assert.equal(normalized.openingMessage, items[index].settings.openingMessage);
  }
  assert.deepEqual(migrateConversationModels(migrated.settings, migrated.conversations), migrated);
  // Settings may be persisted before conversations; restarting must not add duplicates.
  assert.equal(migrateConversationModels(migrated.settings, items).settings.providerPresets[0].models.length, 4);
});

test("model swapping applies its limits and reasoning without replacing chat prompts", () => {
  const app = fixture(), provider = app.providerPresets[0];
  const current = { ...conversationSettingsFromApp(app), systemPrompt: "system", openingMessage: "opening",
    reasoning: { ...DEFAULT_REASONING, level: "high" }, temperature: 1.2 };
  const next = selectConversationModel(current, provider, "large");
  assert.equal(next.modelPresetId, "large");
  assert.equal(next.model, "custom/large");
  assert.equal(next.maxTokens, 200000);
  assert.equal(next.contextLimit, 1000000);
  assert.equal(next.vision, true);
  assert.equal(next.reasoning.level, "budget");
  assert.equal(next.reasoning.budget, 8192);
  assert.equal(next.systemPrompt, "system");
  assert.equal(next.openingMessage, "opening");
  assert.equal(next.temperature, 1.2);
  const switched = syncAppDefaults(app, next);
  assert.equal(switched.providerPresets[0].defaultModelId, "large");
  assert.deepEqual(switched.providerPresets[0].models, provider.models);
  const fresh = conversationSettingsFromApp(switched);
  assert.equal(fresh.modelPresetId, "large");
  assert.equal(fresh.maxTokens, 200000);
  assert.equal(fresh.systemPrompt, "");
  assert.equal(fresh.openingMessage, "");
  assert.equal(normalizeConversationSettings(current, switched).modelPresetId, "small");
});

test("profile edits update the selected model and restored chats without contaminating siblings", () => {
  const app = fixture(), current = conversationSettingsFromApp(app);
  current.reasoning.level = "high";
  current.vision = true;
  const changed = { ...app, providerPresets: app.providerPresets.map((provider) => ({ ...provider,
    models: provider.models.map((model) => model.id === "small" ? { ...model, maxTokens: 8192, contextLimit: -1 } : model),
  })) };
  const reconciled = reconcileConversationModel(app, changed, current);
  assert.equal(reconciled.maxTokens, 8192);
  assert.equal(reconciled.contextLimit, -1);
  assert.equal(reconciled.reasoning.level, "high");
  assert.equal(reconciled.vision, true);
  assert.equal(changed.providerPresets[0].models[1].maxTokens, 200000);
  assert.equal(normalizeConversationSettings(current, changed).maxTokens, 8192);
  assert.equal(getProviderModel(syncAppDefaults(changed, reconciled).providerPresets[0]).reasoning.level, "low");
  assert.equal(getProviderModel(syncAppDefaults(changed, reconciled).providerPresets[0]).vision, false);
});

test("adding, selecting and deleting models and providers resolves a valid active configuration", () => {
  const app = fixture(), current = conversationSettingsFromApp(app);
  const switched = { ...app, providerPresets: [{ ...app.providerPresets[0], defaultModelId: "large" }] };
  const largeChat = reconcileConversationModel(app, switched, current);
  assert.equal(largeChat.modelPresetId, "large");
  const removed = { ...switched, providerPresets: [{ ...switched.providerPresets[0], defaultModelId: "small",
    models: [switched.providerPresets[0].models[0]] }] };
  assert.equal(reconcileConversationModel(switched, removed, largeChat).modelPresetId, "small");
  const other = { ...app.providerPresets[0], id: "other", apiKey: "other-key", defaultModelId: "large" };
  const otherApp = { ...app, providerPresets: [...app.providerPresets, other], activeProviderId: "other" };
  const otherChat = reconcileConversationModel(app, otherApp, current);
  assert.equal(otherChat.providerPresetId, "other");
  assert.equal(otherChat.modelPresetId, "large");
  assert.equal(resolveProviderModel(other, otherChat.modelPresetId).apiKey, "other-key");
});

test("provider credentials and unrelated settings do not rewrite a long conversation", () => {
  const app = fixture(), current = conversationSettingsFromApp(app);
  const next = { ...app, theme: "light", providerPresets: [{ ...app.providerPresets[0], apiKey: "changed-key" }] };
  assert.equal(reconcileConversationModel(app, next, current), current);
});

test("requests for sibling models share endpoint and key but send independent model options and token caps", async () => {
  const app = fixture(), provider = app.providerPresets[0], calls = [];
  const { requestCompletion } = loadTs("app/lib/api.ts", { fetch: async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
  } });
  for (const model of provider.models) {
    const selected = selectConversationModel(conversationSettingsFromApp(app), provider, model.id);
    const { planRequestContext } = loadTs("app/lib/context.ts");
    assert.equal(planRequestContext([], selected).inputBudget, model.contextLimit - model.maxTokens - 1024);
    await requestCompletion({ provider: resolveProviderModel(provider, selected.modelPresetId),
      settings: { ...app, ...selected }, messages: [{ role: "user", content: "test" }] });
  }
  assert.deepEqual(calls.map((call) => call.url), Array(2).fill("https://custom.test/v1/chat/completions"));
  assert.deepEqual(calls.map((call) => call.headers.get("Authorization")), Array(2).fill("Bearer fixture-key"));
  assert.deepEqual(calls.map((call) => call.body.model), ["custom/small", "custom/large"]);
  assert.deepEqual(calls.map((call) => call.body.max_tokens), [7000, 200000]);
  assert.equal(calls[0].body.reasoning_effort, "low");
  assert.deepEqual(calls[1].body.reasoning, { max_tokens: 8192 });
  assert.equal(calls[1].body.top_p, 0.8);
  assert.equal(calls[0].body.top_p, undefined);
});

test("numeric model limits accept large outputs and unlimited context but reject invalid values", () => {
  assert.equal(normalizeModel({ maxTokens: 500000 }, "id").maxTokens, 500000);
  assert.equal(normalizeModel({ contextLimit: -1 }, "id").contextLimit, -1);
  for (const value of [0, -2, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(normalizeModel({ maxTokens: value }, "id").maxTokens, DEFAULT_MODEL_PRESET.maxTokens);
  }
  for (const value of [0, -2, 1000, NaN, Infinity]) {
    assert.equal(normalizeModel({ contextLimit: value }, "id").contextLimit, DEFAULT_MODEL_PRESET.contextLimit);
  }
});
