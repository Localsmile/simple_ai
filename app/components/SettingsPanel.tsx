"use client";

import {
  Eye,
  EyeOff,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";
import type {
  AppSettings,
  ConversationSettings,
  McpConnectionState,
  ProviderPreset,
  ModelPreset,
} from "../types";
import { DEFAULT_MODEL_PRESET, getActiveProvider, getProviderModel } from "../types";
import { modelPresetLabel } from "../lib/models";
import { ReasoningControls } from "./ReasoningControls";
import { McpSettings } from "./McpSettings";
import { MarkdownView } from "./MarkdownView";
import { supportsCorsProxy } from "../lib/connection";

type SettingsTab = "connection" | "generation" | "mcp";

interface SettingsPanelProps {
  open: boolean;
  conversationId: string;
  settings: AppSettings;
  conversationSettings: ConversationSettings;
  mcpConnections: Record<string, McpConnectionState>;
  onChange: (settings: AppSettings) => void;
  onConversationChange: (settings: ConversationSettings) => void;
  onClose: () => void;
  onConnectMcp: (id: string) => void;
}

interface IntegerSettingInputProps {
  value: number;
  minimum: number;
  maximum?: number;
  allowUnlimited?: boolean;
  onCommit: (value: number) => void;
}

function IntegerSettingInput({
  value,
  minimum,
  maximum,
  allowUnlimited = false,
  onCommit,
}: IntegerSettingInputProps) {
  const [draft, setDraft] = useState(String(value));

  const commit = () => {
    const parsed = Number(draft.trim());
    const isUnlimited = allowUnlimited && parsed === -1;
    const isInRange = Number.isSafeInteger(parsed) && parsed >= minimum && (
      maximum === undefined || parsed <= maximum
    );

    if (isUnlimited || isInRange) {
      onCommit(parsed);
      setDraft(String(parsed));
    } else {
      setDraft(String(value));
    }
  };

  return (
    <input
      type="number"
      min={allowUnlimited ? -1 : minimum}
      max={maximum}
      step="1"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setDraft(String(value));
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function presetId(): string {
  return `preset_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

export function SettingsPanel({
  open,
  conversationId,
  settings,
  conversationSettings,
  mcpConnections,
  onChange,
  onConversationChange,
  onClose,
  onConnectMcp,
}: SettingsPanelProps) {
  const [tab, setTab] = useState<SettingsTab>("connection");
  const [showApiKey, setShowApiKey] = useState(false);
  const activeProvider = settings.providerPresets.find(
    (preset) => preset.id === conversationSettings.providerPresetId,
  ) || getActiveProvider(settings);
  const activeModel = getProviderModel(activeProvider, conversationSettings.modelPresetId);

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    onChange({ ...settings, [key]: value });
  };

  const updateConversation = <K extends keyof ConversationSettings>(
    key: K,
    value: ConversationSettings[K],
  ) => {
    onConversationChange({ ...conversationSettings, [key]: value });
  };

  const updateProvider = <K extends keyof ProviderPreset>(
    key: K,
    value: ProviderPreset[K],
  ) => {
    onChange({
      ...settings,
      providerPresets: settings.providerPresets.map((preset) =>
        preset.id === activeProvider.id ? { ...preset, [key]: value } : preset,
      ),
    });
  };

  const addProvider = () => {
    const model: ModelPreset = { ...DEFAULT_MODEL_PRESET, id: presetId() };
    const next: ProviderPreset = {
      id: presetId(),
      name: `제공자 ${settings.providerPresets.length + 1}`,
      baseUrl: "",
      connectionMode: "direct",
      apiKey: "",
      models: [model],
      defaultModelId: model.id,
    };
    setShowApiKey(false);
    onChange({
      ...settings,
      activeProviderId: next.id,
      providerPresets: [...settings.providerPresets, next],
    });
  };

  const updateModel = (changes: Partial<Omit<ModelPreset, "id">>) => {
    updateProvider("models", activeProvider.models.map((model) => model.id === activeModel.id
      ? { ...model, ...changes } : model));
  };

  const addModel = () => {
    const model: ModelPreset = { ...DEFAULT_MODEL_PRESET, id: presetId() };
    onChange({ ...settings, providerPresets: settings.providerPresets.map((provider) =>
      provider.id === activeProvider.id
        ? { ...provider, models: [...provider.models, model], defaultModelId: model.id } : provider) });
  };

  const removeModel = () => {
    if (activeProvider.models.length <= 1) return;
    const models = activeProvider.models.filter((model) => model.id !== activeModel.id);
    onChange({ ...settings, providerPresets: settings.providerPresets.map((provider) =>
      provider.id === activeProvider.id ? { ...provider, models, defaultModelId: models[0].id } : provider) });
  };

  const removeProvider = () => {
    if (settings.providerPresets.length <= 1) return;
    const providerPresets = settings.providerPresets.filter(
      (preset) => preset.id !== activeProvider.id,
    );
    setShowApiKey(false);
    onChange({
      ...settings,
      providerPresets,
      activeProviderId: providerPresets[0].id,
    });
  };

  return (
    <>
      <button
        className={`settings-backdrop ${open ? "is-open" : ""}`}
        onClick={onClose}
        aria-label="설정 닫기"
        tabIndex={open ? 0 : -1}
      />
      <aside className={`settings-panel ${open ? "is-open" : ""}`} aria-hidden={!open}>
        <header className="settings-header">
          <div>
            <span className="eyebrow">CONFIGURATION</span>
            <h2>설정</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="닫기">
            <X size={18} />
          </button>
        </header>

        <nav className="settings-tabs" aria-label="설정 분류">
          <button className={tab === "connection" ? "active" : ""} onClick={() => setTab("connection")}>
            연결
          </button>
          <button className={tab === "generation" ? "active" : ""} onClick={() => setTab("generation")}>
            생성
          </button>
          <button className={tab === "mcp" ? "active" : ""} onClick={() => setTab("mcp")}>
            MCP
          </button>
        </nav>

        <div className="settings-content">
          {tab === "connection" && (
            <section className="settings-section">
              <div className="field-group">
                <span className="field-label">
                  API 제공자 <em>{settings.providerPresets.length}개</em>
                </span>
                <div className="preset-toolbar">
                  <select
                    value={activeProvider.id}
                    onChange={(event) => {
                      setShowApiKey(false);
                      update("activeProviderId", event.target.value);
                    }}
                    aria-label="API 제공자"
                  >
                    {settings.providerPresets.map((preset) => (
                      <option key={preset.id} value={preset.id}>{preset.name}</option>
                    ))}
                  </select>
                  <button type="button" onClick={addProvider} aria-label="제공자 추가" title="제공자 추가">
                    <Plus size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={removeProvider}
                    disabled={settings.providerPresets.length <= 1}
                    aria-label="제공자 삭제"
                    title="제공자 삭제"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>

              <label className="field-group">
                <span className="field-label">제공자 이름</span>
                <input
                  type="text"
                  value={activeProvider.name}
                  onChange={(event) => updateProvider("name", event.target.value)}
                  placeholder="제공자 이름"
                />
              </label>

              <label className="field-group">
                <span className="field-label">API 엔드포인트</span>
                <input
                  type="url"
                  value={activeProvider.baseUrl}
                  onChange={(event) => updateProvider("baseUrl", event.target.value)}
                  spellCheck={false}
                  placeholder="https://api.example.com/v1/chat/completions"
                />
              </label>

              <label className="field-group">
                <span className="field-label">연결 방식</span>
                <select
                  value={activeProvider.connectionMode}
                  onChange={(event) => updateProvider("connectionMode",
                    event.target.value === "cors-proxy" ? "cors-proxy" : "direct")}
                >
                  <option value="direct">직접 연결</option>
                  <option value="cors-proxy">
                    CORS 오류 시 사용
                  </option>
                </select>
                {activeProvider.connectionMode === "cors-proxy" && (
                  <small>
                    {supportsCorsProxy(activeProvider.baseUrl)
                      ? "API 키·메시지: Cloudflare 경유 · 중계 서버 저장 없음"
                      : "공개 HTTPS 엔드포인트 필요 · 로컬·IP 주소 중계 불가"}
                  </small>
                )}
              </label>

              <label className="field-group">
                <span className="field-label">API 키 <em>선택</em></span>
                <span className="input-with-action">
                  <input
                    type={showApiKey ? "text" : "password"}
                    value={activeProvider.apiKey}
                    onChange={(event) => updateProvider("apiKey", event.target.value)}
                    autoComplete="off"
                    placeholder="API key"
                  />
                  <button type="button" onClick={() => setShowApiKey((value) => !value)} aria-label="API 키 표시 전환">
                    {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </span>
              </label>

              <section className="model-settings" aria-label="모델 설정">
              <div className="field-group">
                <span className="field-label">모델 <em>{activeProvider.models.length}개</em></span>
                <div className="preset-toolbar">
                  <select value={activeModel.id} aria-label="설정 모델"
                    onChange={(event) => updateProvider("defaultModelId", event.target.value)}>
                    {activeProvider.models.map((model) => (
                      <option key={model.id} value={model.id}>{modelPresetLabel(activeProvider, model)}</option>
                    ))}
                  </select>
                  <button type="button" onClick={addModel} aria-label="모델 추가" title="모델 추가"><Plus size={16} /></button>
                  <button type="button" onClick={removeModel} disabled={activeProvider.models.length <= 1}
                    aria-label="모델 삭제" title="모델 삭제"><Trash2 size={15} /></button>
                </div>
              </div>
              <label className="field-group">
                <span className="field-label">모델 ID</span>
                <input
                  type="text"
                  value={activeModel.model}
                  onChange={(event) => updateModel({ model: event.target.value })}
                  spellCheck={false}
                  placeholder="model-name"
                />
              </label>

              <label className="switch-row">
                <span>
                  <strong>이미지 입력</strong>
                </span>
                <input
                  type="checkbox"
                  checked={activeModel.vision}
                  onChange={(event) => updateModel({ vision: event.target.checked })}
                />
              </label>

              <label className="field-group">
                <span className="field-label">최대 출력 토큰</span>
                <IntegerSettingInput key={`max-tokens:${activeModel.id}:${activeModel.maxTokens}`}
                  value={activeModel.maxTokens} minimum={1}
                  onCommit={(value) => updateModel({ maxTokens: value })} />
              </label>
              <label className="field-group">
                <span className="field-label">컨텍스트 한도</span>
                <IntegerSettingInput key={`context-limit:${activeModel.id}:${activeModel.contextLimit}`}
                  value={activeModel.contextLimit} minimum={2048} allowUnlimited
                  onCommit={(value) => updateModel({ contextLimit: value })} />
                <small>-1: 무제한</small>
              </label>
              <ReasoningControls value={activeModel.reasoning} selectedLevels={activeModel.reasoningLevels}
                onChange={(reasoning, reasoningLevels) => updateModel({ reasoning, reasoningLevels })} />

              <details className="advanced-request">
                <summary>추가 요청 옵션</summary>
                <label className="field-group">
                  <span className="field-label">추가 요청 JSON</span>
                  <textarea
                    value={activeModel.extraBody}
                    onChange={(event) => updateModel({ extraBody: event.target.value })}
                    spellCheck={false}
                    placeholder={'{\n  "parameter": "value"\n}'}
                    rows={6}
                  />
                </label>
              </details>
              </section>

              <label className="switch-row">
                <span>
                  <strong>인증정보 로컬 저장</strong>
                  <small>API 키 · MCP 토큰</small>
                </span>
                <input
                  type="checkbox"
                  checked={settings.rememberCredentials}
                  onChange={(event) => update("rememberCredentials", event.target.checked)}
                />
              </label>
            </section>
          )}

          {tab === "generation" && (
            <section className="settings-section">
              <label className="field-group">
                <span className="field-label">메시지 전송 키 <em>공용 설정</em></span>
                <select value={settings.sendKey}
                  onChange={(event) => update("sendKey", event.target.value as AppSettings["sendKey"])}>
                  <option value="auto">자동 · PC Enter / 터치 줄바꿈</option>
                  <option value="enter">Enter 전송 · Shift+Enter 줄바꿈</option>
                  <option value="ctrl-enter">Enter 줄바꿈 · Ctrl/⌘+Enter 전송</option>
                </select>
              </label>
              <label className="field-group">
                <span className="field-label">시스템 프롬프트</span>
                <textarea
                  className="system-prompt"
                  value={conversationSettings.systemPrompt}
                  onChange={(event) => updateConversation("systemPrompt", event.target.value)}
                  placeholder="역할, 규칙, 출력 형식"
                  rows={10}
                />
              </label>

              <div className="field-group">
                <span className="field-label">시작 메시지</span>
                <textarea
                  value={conversationSettings.openingMessage}
                  onChange={(event) => updateConversation("openingMessage", event.target.value)}
                  placeholder="시작 메시지"
                  rows={6}
                />
                {conversationSettings.openingMessage.trim() && (
                  <section className="opening-preview" aria-label="시작 메시지 미리보기">
                    <span>미리보기</span>
                    <MarkdownView
                      content={conversationSettings.openingMessage}
                      imageWidth={settings.markdownImageWidth}
                    />
                  </section>
                )}
              </div>

              <label className="field-group range-field">
                <span className="field-label">
                  마크다운 이미지 크기 <output>{settings.markdownImageWidth}%</output>
                </span>
                <input
                  type="range"
                  min="30"
                  max="100"
                  step="5"
                  value={settings.markdownImageWidth}
                  onChange={(event) => update("markdownImageWidth", Number(event.target.value))}
                />
                <small>공용</small>
              </label>

              <label className="field-group range-field">
                <span className="field-label">
                  Temperature <output>{conversationSettings.temperature.toFixed(1)}</output>
                </span>
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.1"
                  value={conversationSettings.temperature}
                  onChange={(event) => updateConversation("temperature", Number(event.target.value))}
                />
              </label>

              <label className="field-group">
                <span className="field-label">전송할 최근 대화 턴</span>
                <IntegerSettingInput
                  key={`history-turns:${conversationId}:${conversationSettings.historyTurns}`}
                  value={conversationSettings.historyTurns}
                  minimum={1}
                  allowUnlimited
                  onCommit={(value) => updateConversation("historyTurns", value)}
                />
                <small>-1: 전체</small>
              </label>

              <label className="switch-row">
                <span>
                  <strong>토큰 한도 자동 정리</strong>
                  <small>
                    {conversationSettings.contextLimit === -1
                      ? "비활성 · 컨텍스트 한도 없음"
                      : "대화 기록 유지"}
                  </small>
                </span>
                <input
                  type="checkbox"
                  checked={conversationSettings.autoTrimContext}
                  onChange={(event) => updateConversation("autoTrimContext", event.target.checked)}
                  disabled={conversationSettings.contextLimit === -1}
                />
              </label>

              <label className="switch-row">
                <span>
                  <strong>스트리밍</strong>
                </span>
                <input
                  type="checkbox"
                  checked={conversationSettings.stream}
                  onChange={(event) => updateConversation("stream", event.target.checked)}
                />
              </label>
            </section>
          )}

          {tab === "mcp" && (
            <McpSettings settings={settings} connections={mcpConnections}
              onChange={onChange} onConnect={onConnectMcp} />
          )}
        </div>
      </aside>
    </>
  );
}
