import { DEFAULT_WEB_SEARCH_MCP, type McpConnectionState, type McpServerConfig } from "../types";

export const MCP_PRESETS = [
  {
    name: DEFAULT_WEB_SEARCH_MCP.name, detail: "웹 검색", url: DEFAULT_WEB_SEARCH_MCP.url,
    authType: "none" as const, selectedTools: ["web_search_exa"],
  },
  {
    name: "GitHub MCP", detail: "저장소 코드 · 파일 · README",
    url: "https://api.githubcopilot.com/mcp/readonly", authType: "bearer" as const,
    selectedTools: [],
    credentialUrl: "https://github.com/settings/personal-access-tokens/new",
    credentialLabel: "GitHub 인증 토큰 발급",
  },
];

export function findPresetServer(servers: McpServerConfig[], url: string): McpServerConfig | undefined {
  const normalize = (value: string) => value.trim().replace(/\/+$/, "");
  return servers.find((server) => normalize(server.url) === normalize(url));
}

export function mcpPresetState(server?: McpServerConfig, connection?: McpConnectionState) {
  if (!server) return { status: "available", label: "연결 추가" };
  if (!server.enabled) return { status: "disabled", label: "추가됨 · 꺼짐" };
  if (connection?.status === "connecting") return { status: "connecting", label: "연결 중" };
  if (connection?.status === "error") return { status: "error", label: "연결 오류" };
  if (connection?.status === "connected") return { status: "connected", label: "연결됨" };
  return { status: "added", label: "추가됨" };
}
