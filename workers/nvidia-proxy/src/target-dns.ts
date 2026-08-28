import * as ipaddr from "ipaddr.js";

export class TargetDnsError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readDnsJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error("DNS response unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "", bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 131072) {
        await reader.cancel();
        throw new Error("DNS response too large");
      }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { reader.releaseLock(); }
}

export async function assertPublicDns(hostname: string, signal: AbortSignal): Promise<void> {
  try {
    const dnsSignal = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
    const answers = await Promise.all(["A", "AAAA"].map(async (type) => {
      // Only the hostname is sent to the resolver, never credentials, path, or query.
      const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`;
      const payload = await readDnsJson(await fetch(url, {
        headers: { Accept: "application/dns-json" }, signal: dnsSignal, redirect: "manual",
      }));
      if (!isRecord(payload) || payload.Status !== 0 || payload.TC === true
        || (payload.Answer !== undefined && !Array.isArray(payload.Answer))) throw new Error("DNS lookup failed");
      return (Array.isArray(payload.Answer) ? payload.Answer : []).filter((record: unknown) =>
        isRecord(record) && (record.type === 1 || record.type === 28));
    }));
    const addresses: unknown[] = answers.flat();
    if (!addresses.length) throw new Error("No DNS addresses");
    for (const record of addresses) {
      if (!isRecord(record) || typeof record.data !== "string" || !ipaddr.isValid(record.data)) {
        throw new Error("Invalid DNS address");
      }
      const address = ipaddr.parse(record.data);
      if (address.range() !== "unicast") {
        throw new TargetDnsError(403, "중계 대상의 비공개·예약 IP 주소 차단");
      }
    }
    // This pre-check does not pin DNS. Production also relies on Workers' public
    // fetch boundary; do not add origin routes, VPC, or private-network bindings.
  } catch (error) {
    if (error instanceof TargetDnsError) throw error;
    throw new TargetDnsError(502, "중계 대상 DNS 확인 실패");
  }
}
