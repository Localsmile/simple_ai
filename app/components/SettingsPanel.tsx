"use client";

import {
  Eye,
  EyeOff,
  ExternalLink,
  Plus,
  PlugZap,
  RotateCw,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";
import type {
  AppSettings,
  ConversationSettings,
  McpToolDefinition,
  ProviderPreset,
} from "../types";
import { getActiveProvider } from "../types";

type SettingsTab = "connection" | "generation" | "mcp";

const MCP_PRESETS: Array<{
  id: string;
  eyebrow: string;
  name: string;
  detail: string;
  url: string;
  authType: AppSettings["mcpAuthType"];
  credentialUrl?: string;
  credentialLabel?: string;
}> = [
  {
    id: "exa-search",
    eyebrow: "WEB SEARCH",
    name: "Exa hosted MCP",
    detail: "웹 검색 · URL 본문",
    url: "https://mcp.exa.ai/mcp",
    authType: "none",
  },
  {
    id: "github-readonly",
    eyebrow: "GITHUB READ ONLY",
    name: "GitHub MCP",
    detail: "저장소 코드 · 파일 · README",
    url: "https://api.githubcopilot.com/mcp/readonly",
    authType: "bearer",
    credentialUrl: "https://github.com/settings/personal-access-tokens/new",
    credentialLabel: "GitHub 인증 토큰 발급",
  },
];

interface SettingsPanelProps {
  open: boolean;
  conversationId: string;
  settings: AppSettings;
  conversationSettings: ConversationSettings;
  mcpStatus: "off" | "connecting" | "connected" | "error";
  mcpError: string;
  mcpTools: McpToolDefinition[];
  onChange: (settings: AppSettings) => void;
  onConversationChange: (settings: ConversationSettings) => void;
  onClose: () => void;
  onConnectMcp: () => void;
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
    const isInRange = Number.isInteger(parsed) && parsed >= minimum && (
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
  mcpStatus,
  mcpError,
  mcpTools,
  onChange,
  onConversationChange,
  onClose,
  onConnectMcp,
}: SettingsPanelProps) {
  const [tab, setTab] = useState<SettingsTab>("connection");
  const [showApiKey, setShowApiKey] = useState(false);
  const [showMcpToken, setShowMcpToken] = useState(false);
  const activeProvider = settings.providerPresets.find(
    (preset) => preset.id === conversationSettings.providerPresetId,
  ) || getActiveProvider(settings);

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
    const next: ProviderPreset = {
      id: presetId(),
      name: `연결 ${settings.providerPresets.length + 1}`,
      baseUrl: "",
      apiKey: "",
      model: "",
      vision: false,
    };
    setShowApiKey(false);
    onChange({
      ...settings,
      activeProviderId: next.id,
      providerPresets: [...settings.providerPresets, next],
    });
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
                  현재 대화 연결 <em>{settings.providerPresets.length}개</em>
                </span>
                <div className="preset-toolbar">
                  <select
                    value={activeProvider.id}
                    onChange={(event) => {
                      setShowApiKey(false);
                      update("activeProviderId", event.target.value);
                    }}
                    aria-label="활성 연결 프리셋"
                  >
                    {settings.providerPresets.map((preset) => (
                      <option key={preset.id} value={preset.id}>{preset.name}</option>
                    ))}
                  </select>
                  <button type="button" onClick={addProvider} aria-label="연결 프리셋 추가" title="추가">
                    <Plus size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={removeProvider}
                    disabled={settings.providerPresets.length <= 1}
                    aria-label="현재 연결 프리셋 삭제"
                    title="삭제"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
                <small>연결과 모델 선택은 대화별로 저장</small>
              </div>

              <label className="field-group">
                <span className="field-label">프리셋 이름</span>
                <input
                  type="text"
                  value={activeProvider.name}
                  onChange={(event) => updateProvider("name", event.target.value)}
                  placeholder="연결 이름"
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
                <small>기본 URL과 전체 /chat/completions URL 모두 지원</small>
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

              <label className="field-group">
                <span className="field-label">모델</span>
                <input
                  type="text"
                  value={conversationSettings.model}
                  onChange={(event) => updateConversation("model", event.target.value)}
                  spellCheck={false}
                  placeholder="model-name"
                />
              </label>

              <label className="switch-row">
                <span>
                  <strong>Vision</strong>
                  <small>현재 대화의 이미지 입력 허용</small>
                </span>
                <input
                  type="checkbox"
                  checked={conversationSettings.vision}
                  onChange={(event) => updateConversation("vision", event.target.checked)}
                />
              </label>

              <label className="switch-row">
                <span>
                  <strong>인증정보 로컬 저장</strong>
                  <small>모든 프리셋의 키와 MCP 토큰 저장</small>
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
                <span className="field-label">시스템 프롬프트</span>
                <textarea
                  className="system-prompt"
                  value={conversationSettings.systemPrompt}
                  onChange={(event) => updateConversation("systemPrompt", event.target.value)}
                  placeholder="역할, 규칙, 출력 형식"
                  rows={10}
                />
              </label>

              <label className="field-group">
                <span className="field-label">시작 메시지</span>
                <textarea
                  value={conversationSettings.openingMessage}
                  onChange={(event) => updateConversation("openingMessage", event.target.value)}
                  placeholder="대화 시작 상황 · 마크다운 및 이미지 문법 지원"
                  rows={6}
                />
                <small>현재 대화 상단에 표시되며 첫 assistant 문맥으로 전송</small>
              </label>

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
                <small>모든 대화의 사용자·시작·AI 메시지에 공통 적용</small>
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
                <span className="field-label">최대 출력 토큰</span>
                <IntegerSettingInput
                  key={`max-tokens:${conversationId}:${conversationSettings.maxTokens}`}
                  value={conversationSettings.maxTokens}
                  minimum={1}
                  maximum={131072}
                  onCommit={(value) => updateConversation("maxTokens", value)}
                />
              </label>

              <label className="field-group">
                <span className="field-label">컨텍스트 한도</span>
                <IntegerSettingInput
                  key={`context-limit:${conversationId}:${conversationSettings.contextLimit}`}
                  value={conversationSettings.contextLimit}
                  minimum={2048}
                  allowUnlimited
                  onCommit={(value) => updateConversation("contextLimit", value)}
                />
                <small>-1은 무제한 · 그 외에는 2048 이상의 정수</small>
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
                <small>1턴 = 사용자 메시지와 응답 · -1은 전체 대화</small>
              </label>

              <label className="switch-row">
                <span>
                  <strong>토큰 한도 자동 정리</strong>
                  <small>
                    {conversationSettings.contextLimit === -1
                      ? "무제한 설정에서는 적용되지 않음"
                      : "오래된 메시지는 API 요청에서만 제외 · 대화 기록은 유지"}
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
                  <small>실시간 응답 출력</small>
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
            <section className="settings-section">
              <label className="switch-row emphasized">
                <span>
                  <strong>MCP 도구</strong>
                  <small>Streamable HTTP · Beta</small>
                </span>
                <input
                  type="checkbox"
                  checked={settings.mcpEnabled}
                  onChange={(event) => update("mcpEnabled", event.target.checked)}
                />
              </label>

              <label className="field-group">
                <span className="field-label">원격 MCP URL</span>
                <input
                  type="url"
                  value={settings.mcpUrl}
                  onChange={(event) => update("mcpUrl", event.target.value)}
                  spellCheck={false}
                  placeholder="https://server.example.com/mcp"
                  disabled={!settings.mcpEnabled}
                />
                <small>HTTPS · POST · 브라우저 CORS 필요</small>
              </label>

              <label className="field-group">
                <span className="field-label">인증 방식</span>
                <select
                  value={settings.mcpAuthType}
                  onChange={(event) => update("mcpAuthType", event.target.value as AppSettings["mcpAuthType"])}
                  disabled={!settings.mcpEnabled}
                >
                  <option value="none">없음</option>
                  <option value="bearer">Bearer</option>
                  <option value="x-api-key">x-api-key</option>
                </select>
              </label>

              {settings.mcpAuthType !== "none" && (
                <label className="field-group">
                  <span className="field-label">MCP 인증 토큰</span>
                  <span className="input-with-action">
                    <input
                      type={showMcpToken ? "text" : "password"}
                      value={settings.mcpToken}
                      onChange={(event) => update("mcpToken", event.target.value)}
                      autoComplete="off"
                      disabled={!settings.mcpEnabled}
                    />
                    <button type="button" onClick={() => setShowMcpToken((value) => !value)} aria-label="MCP 토큰 표시 전환">
                      {showMcpToken ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </span>
                </label>
              )}

              <button
                type="button"
                className="connect-button"
                onClick={onConnectMcp}
                disabled={!settings.mcpEnabled || !settings.mcpUrl || mcpStatus === "connecting"}
              >
                {mcpStatus === "connecting" ? <RotateCw className="spin" size={16} /> : <PlugZap size={16} />}
                {mcpStatus === "connected" ? `${mcpTools.length}개 도구 연결됨` : "연결 확인"}
              </button>

              {mcpStatus === "error" && <p className="settings-error">{mcpError}</p>}

              {mcpTools.length > 0 && (
                <div className="tool-list">
                  {mcpTools.map((tool) => (
                    <div key={tool.name}>
                      <strong>{tool.name}</strong>
                      {tool.description && <span>{tool.description}</span>}
                    </div>
                  ))}
                </div>
              )}

              <div className="mcp-preset-list">
                {MCP_PRESETS.map((preset) => (
                  <div className="mcp-preset" key={preset.id}>
                    <span className="eyebrow">{preset.eyebrow}</span>
                    <strong>{preset.name}</strong>
                    <small>{preset.detail}</small>
                    <code>{preset.url}</code>
                    <div className="mcp-preset-actions">
                      <button
                        type="button"
                        onClick={() =>
                          onChange({
                            ...settings,
                            mcpEnabled: true,
                            mcpUrl: preset.url,
                            mcpAuthType: preset.authType,
                            mcpToken: "",
                          })
                        }
                      >
                        프리셋 적용
                      </button>
                      {preset.credentialUrl && (
                        <a
                          className="mcp-credential-link"
                          href={preset.credentialUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {preset.credentialLabel}
                          <ExternalLink size={11} aria-hidden="true" />
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </aside>
    </>
  );
}
