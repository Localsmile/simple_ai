import type { ProviderPreset } from "../types";
import { CORS_PROXY_URL, parsePublicApiTarget } from "../../shared/proxy-target";
export { CORS_PROXY_URL, UPSTREAM_HEADER } from "../../shared/proxy-target";

export type CompletionApi = "chat-completions" | "responses";

export function normalizeConnectionMode(value: unknown): ProviderPreset["connectionMode"] {
  return value === "cors-proxy" || value === "nvidia-proxy" ? "cors-proxy" : "direct";
}

export function resolveChatUrl(baseUrl: string): string {
  const normalized = baseUrl.trim();
  try {
    const url = new URL(normalized);
    const path = url.pathname.replace(/\/+$/, "");
    url.pathname = /\/(?:chat\/completions|responses)$/i.test(path) ? path : `${path}/chat/completions`;
    return url.href;
  } catch { /* Preserve the direct-connection validation path for incomplete input. */ }
  const fallback = normalized.replace(/\/+$/, "");
  if (/\/(?:chat\/completions|responses)(?:[?#].*)?$/i.test(fallback)) return fallback;
  return `${fallback}/chat/completions`;
}

export function completionApiForUrl(value: string): CompletionApi {
  try {
    return /\/responses\/?$/i.test(new URL(resolveChatUrl(value)).pathname)
      ? "responses" : "chat-completions";
  } catch {
    return /\/responses(?:[?#].*)?$/i.test(value.trim()) ? "responses" : "chat-completions";
  }
}

export function supportsCorsProxy(baseUrl: string): boolean {
  try {
    parsePublicApiTarget(resolveChatUrl(baseUrl));
    return true;
  } catch {
    return false;
  }
}

export function resolveCompletionUrl(provider: Pick<ProviderPreset, "baseUrl" | "connectionMode">): string {
  const target = resolveChatUrl(provider.baseUrl);
  if (normalizeConnectionMode(provider.connectionMode) === "direct") return target;
  parsePublicApiTarget(target);
  return CORS_PROXY_URL;
}
