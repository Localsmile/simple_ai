import { useState } from "react";
import { Eye, EyeOff, ExternalLink, Plus, RotateCw, Trash2 } from "lucide-react";
import type { AppSettings, McpServerConfig, McpConnectionState } from "../types";

const MCP_PRESETS = [
  { name: "Exa hosted MCP", detail: "웹 검색 · URL 본문", url: "https://mcp.exa.ai/mcp", authType: "none" as const },
  {
    name: "GitHub MCP", detail: "저장소 코드 · 파일 · README",
    url: "https://api.githubcopilot.com/mcp/readonly", authType: "bearer" as const,
    credentialUrl: "https://github.com/settings/personal-access-tokens/new",
    credentialLabel: "GitHub 인증 토큰 발급",
  },
];

export function McpSettings({ settings, connections, onChange, onConnect }: {
  settings: AppSettings;
  connections: Record<string, McpConnectionState>;
  onChange: (settings: AppSettings) => void;
  onConnect: (id: string) => void;
}) {
  const [selectedId, setSelectedId] = useState(settings.mcpServers[0]?.id || "");
  const [showToken, setShowToken] = useState(false);
  const [search, setSearch] = useState("");
  const server = settings.mcpServers.find((item) => item.id === selectedId) || settings.mcpServers[0];
  const connection = server ? connections[server.id] : undefined;
  const tools = connection?.tools || [];
  const visibleTools = tools.filter((tool) =>
    `${tool.name} ${tool.description || ""}`.toLowerCase().includes(search.toLowerCase()),
  );
  const selectedTools = server?.selectedTools === null ? tools.map((tool) => tool.name) : server?.selectedTools || [];
  const totalSelected = settings.mcpServers.filter((item) => item.enabled).reduce((count, item) =>
    count + (item.selectedTools?.length ?? connections[item.id]?.tools.length ?? 0), 0);

  const updateServer = (patch: Partial<McpServerConfig>) => {
    if (!server) return;
    onChange({ ...settings, mcpServers: settings.mcpServers.map((item) =>
      item.id === server.id ? { ...item, ...patch } : item) });
  };
  const selectServer = (id: string) => { setSelectedId(id); setSearch(""); setShowToken(false); };
  const addServer = (preset?: typeof MCP_PRESETS[number]) => {
    const existing = preset && settings.mcpServers.find((item) => item.url === preset.url);
    if (existing) { selectServer(existing.id); return; }
    const next: McpServerConfig = {
      id: crypto.randomUUID(), name: preset?.name || `MCP ${settings.mcpServers.length + 1}`,
      url: preset?.url || "", authType: preset?.authType || "none", token: "",
      enabled: true, selectedTools: [],
    };
    onChange({ ...settings, mcpEnabled: true, mcpServers: [...settings.mcpServers, next] });
    selectServer(next.id);
  };

  return <section className="settings-section">
    <label className="switch-row emphasized">
      <span><strong>MCP 도구</strong><small>선택한 서버와 도구만 전송 · Streamable HTTP</small></span>
      <input type="checkbox" checked={settings.mcpEnabled}
        onChange={(event) => onChange({ ...settings, mcpEnabled: event.target.checked })} />
    </label>
    <div className="mcp-server-list">
      {settings.mcpServers.map((item) => <div key={item.id} className={server?.id === item.id ? "selected" : ""}>
        <input type="checkbox" checked={item.enabled} aria-label={`${item.name} 사용`}
          onChange={(event) => onChange({ ...settings, mcpServers: settings.mcpServers.map((entry) =>
            entry.id === item.id ? { ...entry, enabled: event.target.checked } : entry) })} />
        <button type="button" onClick={() => selectServer(item.id)}>
          <strong>{item.name || "MCP"}</strong>
          <small>{item.selectedTools === null ? "전체 도구" : `${item.selectedTools.length}개 선택`}
            {connections[item.id]?.status === "error" ? " · 연결 오류" : ""}</small>
        </button>
      </div>)}
      <button className="connect-button" type="button" onClick={() => addServer()}><Plus size={14} /> 서버 추가</button>
    </div>
    <label className="field-group">
      <span className="field-label">요청당 도구 수 한도 <em>{totalSelected}개 선택</em></span>
      <input type="number" min="1" max="128" key={settings.mcpToolLimit}
        defaultValue={settings.mcpToolLimit} onBlur={(event) => {
          const value = Number(event.target.value);
          if (Number.isInteger(value) && value >= 1 && value <= 128) onChange({ ...settings, mcpToolLimit: value });
          else event.target.value = String(settings.mcpToolLimit);
        }} />
      <small>한도 초과 시 전송 중단 · 자동 생략 없음</small>
    </label>
    {totalSelected > settings.mcpToolLimit && <p className="settings-error">선택한 도구가 전송 한도를 초과했습니다.</p>}
    {server && <>
      <label className="field-group"><span className="field-label">서버 이름</span>
        <input value={server.name} onChange={(event) => updateServer({ name: event.target.value })} />
      </label>
      <label className="field-group"><span className="field-label">원격 MCP URL</span>
        <input type="url" value={server.url} spellCheck={false}
          onChange={(event) => updateServer({ url: event.target.value, selectedTools: [] })} />
        <small>HTTPS · POST · 브라우저 CORS 필요</small>
      </label>
      <label className="field-group"><span className="field-label">인증 방식</span>
        <select value={server.authType} onChange={(event) => updateServer({ authType: event.target.value as McpServerConfig["authType"] })}>
          <option value="none">없음</option><option value="bearer">Bearer</option><option value="x-api-key">x-api-key</option>
        </select>
      </label>
      {server.authType !== "none" && <label className="field-group">
        <span className="field-label">MCP 인증 토큰</span><span className="input-with-action">
          <input type={showToken ? "text" : "password"} value={server.token} autoComplete="off"
            onChange={(event) => updateServer({ token: event.target.value })} />
          <button type="button" onClick={() => setShowToken((value) => !value)} aria-label="MCP 토큰 표시 전환">
            {showToken ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </span>
      </label>}
      <div className="mcp-server-actions">
        <button className="connect-button" type="button" onClick={() => onConnect(server.id)}
          disabled={!server.url.trim() || connection?.status === "connecting"}>
          <RotateCw size={14} className={connection?.status === "connecting" ? "spin" : ""} />
          {connection?.status === "connecting" ? "연결 중" : "연결 · 도구 새로고침"}
        </button>
        <button type="button" className="icon-button" aria-label="MCP 서버 삭제"
          onClick={() => {
            selectServer("");
            onChange({ ...settings, mcpServers: settings.mcpServers.filter((item) => item.id !== server.id) });
          }}>
          <Trash2 size={15} />
        </button>
      </div>
      {connection?.error && <p className="settings-error">{connection.error}</p>}
      {connection?.status === "connected" && <div className="mcp-tool-picker">
        <label className="field-group"><span className="field-label">전송할 도구 <em>{selectedTools.length} / {tools.length}</em></span>
          <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="도구 검색" />
        </label>
        <div className="mcp-selection-actions">
          <button type="button" onClick={() => updateServer({ selectedTools: [...new Set([...selectedTools, ...visibleTools.map((tool) => tool.name)])] })}>검색 결과 선택</button>
          <button type="button" onClick={() => updateServer({ selectedTools: [] })}>선택 해제</button>
        </div>
        <div className="mcp-tool-options">
          {visibleTools.slice(0, 100).map((tool) => <label key={tool.name}>
            <input type="checkbox" checked={selectedTools.includes(tool.name)}
              onChange={(event) => updateServer({ selectedTools: event.target.checked
                ? [...selectedTools, tool.name] : selectedTools.filter((name) => name !== tool.name) })} />
            <span><strong>{tool.name}</strong>{tool.description && <small title={tool.description}>{tool.description}</small>}</span>
          </label>)}
        </div>
        {visibleTools.length > 100 && <small>상위 100개 표시 · 검색으로 범위 축소</small>}
      </div>}
    </>}
    <div className="mcp-preset-list">
      {MCP_PRESETS.map((preset) => <div className="mcp-preset" key={preset.url}>
        <strong>{preset.name}</strong><small>{preset.detail}</small><code>{preset.url}</code>
        <div className="mcp-preset-actions">
          <button type="button" onClick={() => addServer(preset)}>연결 추가</button>
          {preset.credentialUrl && <a className="mcp-credential-link" href={preset.credentialUrl} target="_blank" rel="noreferrer">
            {preset.credentialLabel}<ExternalLink size={11} aria-hidden="true" />
          </a>}
        </div>
      </div>)}
    </div>
  </section>;
}
