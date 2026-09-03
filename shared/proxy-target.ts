export const PROXY_HOST = "simple-ai-nvidia-proxy.localai0301.workers.dev";
export const CORS_PROXY_URL = `https://${PROXY_HOST}/proxy/openai`;
export const UPSTREAM_HEADER = "X-Upstream-Url";

export function parsePublicApiTarget(value: string): URL {
  if (!value || value.length > 8192 || /[\s\\]/.test(value)) {
    throw new Error("중계 대상 URL 형식 오류");
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("중계 대상 URL 형식 오류"); }
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash) {
    throw new Error("중계는 인증정보가 없는 HTTPS 주소·기본 포트만 지원");
  }
  const host = url.hostname;
  const labels = host.split(".");
  if (host.length > 253 || labels.length < 2 || labels.some((label) =>
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
    || /^\d+$/.test(labels.at(-1) || "")
    || /(^|\.)(localhost|local|localdomain|internal|lan|home|arpa|invalid|test|example|onion)$/.test(host)
    || host === PROXY_HOST || host.endsWith(`.${PROXY_HOST}`)) {
    throw new Error("중계는 공개 도메인만 지원 · 로컬·IP 주소 사용 불가");
  }
  if (!/(?:\/chat\/completions|\/responses)\/?$/i.test(url.pathname)
    || /%(2f|5c|25)/i.test(url.pathname)) {
    throw new Error("중계는 Chat Completions 또는 Responses 경로만 지원");
  }
  return url;
}
