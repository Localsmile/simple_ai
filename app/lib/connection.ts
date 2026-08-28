import type { ProviderPreset } from "../types";

export const NVIDIA_PROXY_URL = "https://simple-ai-nvidia-proxy.localai0301.workers.dev/v1/chat/completions";

export function resolveChatUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(normalized)) return normalized;
  return `${normalized}/chat/completions`;
}

export function supportsNvidiaProxy(baseUrl: string): boolean {
  try {
    const url = new URL(resolveChatUrl(baseUrl));
    return url.origin === "https://integrate.api.nvidia.com"
      && url.pathname === "/v1/chat/completions"
      && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function resolveCompletionUrl(provider: Pick<ProviderPreset, "baseUrl" | "connectionMode">): string {
  if (provider.connectionMode !== "nvidia-proxy") return resolveChatUrl(provider.baseUrl);
  if (!supportsNvidiaProxy(provider.baseUrl)) {
    throw new Error("Cloudflare 중계는 NVIDIA integrate.api.nvidia.com/v1 전용");
  }
  return NVIDIA_PROXY_URL;
}
