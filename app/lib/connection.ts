import type { ProviderPreset } from "../types";
import { CORS_PROXY_URL, parsePublicApiTarget } from "../../shared/proxy-target";
export {
  CORS_PROXY_URL,
  OPENCODE_CLIENT_HEADER,
  OPENCODE_SESSION_HEADER,
  UPSTREAM_HEADER,
} from "../../shared/proxy-target";

export type CompletionApi = "chat-completions" | "responses" | "messages";

export interface CompletionTarget {
  api: CompletionApi;
  url: string;
}

const API_PATHS: Record<CompletionApi, string> = {
  "chat-completions": "chat/completions",
  responses: "responses",
  messages: "messages",
};

const API_SUFFIX = /\/(chat\/completions|responses|messages)\/?$/i;

export function normalizeConnectionMode(value: unknown): ProviderPreset["connectionMode"] {
  return value === "cors-proxy" || value === "nvidia-proxy" ? "cors-proxy" : "direct";
}

export function resolveChatUrl(baseUrl: string): string {
  return resolveApiUrl(baseUrl, "chat-completions", true);
}

export function resolveApiUrl(baseUrl: string, api: CompletionApi, preserveExplicit = false): string {
  const normalized = baseUrl.trim();
  try {
    const url = new URL(normalized);
    const path = url.pathname.replace(/\/+$/, "");
    const match = path.match(API_SUFFIX);
    if (match && preserveExplicit) return url.href;
    const root = match ? path.slice(0, -match[0].length) : path;
    url.pathname = `${root}/${API_PATHS[api]}`;
    return url.href;
  } catch { /* Preserve the direct-connection validation path for incomplete input. */ }
  const fallback = normalized.replace(/\/+$/, "");
  if (preserveExplicit && /\/(?:chat\/completions|responses|messages)(?:[?#].*)?$/i.test(fallback)) return fallback;
  return `${fallback}/${API_PATHS[api]}`;
}

export function completionApiForUrl(value: string): CompletionApi {
  try {
    const path = new URL(value.trim()).pathname.replace(/\/+$/, "");
    if (/\/responses$/i.test(path)) return "responses";
    if (/\/messages$/i.test(path)) return "messages";
    return "chat-completions";
  } catch {
    if (/\/responses(?:[?#].*)?$/i.test(value.trim())) return "responses";
    if (/\/messages(?:[?#].*)?$/i.test(value.trim())) return "messages";
    return "chat-completions";
  }
}

export function resolveCompletionTargets(baseUrl: string, preferred?: CompletionApi): CompletionTarget[] {
  const first = preferred || completionApiForUrl(baseUrl);
  const order = [first, "chat-completions", "responses", "messages"] as CompletionApi[];
  return [...new Set(order)].map((api) => ({ api, url: resolveApiUrl(baseUrl, api) }));
}

export function isOpenCodeTarget(value: string): boolean {
  try { return new URL(value).hostname.toLowerCase() === "opencode.ai"; }
  catch { return false; }
}

export function supportsCorsProxy(baseUrl: string): boolean {
  try {
    parsePublicApiTarget(resolveChatUrl(baseUrl));
    return true;
  } catch {
    return false;
  }
}

export function resolveCompletionUrl(
  provider: Pick<ProviderPreset, "baseUrl" | "connectionMode">,
  target = resolveChatUrl(provider.baseUrl),
): string {
  if (normalizeConnectionMode(provider.connectionMode) === "direct") return target;
  parsePublicApiTarget(target);
  return CORS_PROXY_URL;
}
