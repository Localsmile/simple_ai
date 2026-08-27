import { DEFAULT_REASONING, type ReasoningSettings, type ReasoningLevel } from "../types";

export const REASONING_LEVELS: ReasoningLevel[] = [
  "default", "none", "minimal", "low", "medium", "high", "xhigh", "max", "budget",
];

export function normalizeReasoning(value?: Partial<ReasoningSettings>): ReasoningSettings {
  return {
    format: ["effort", "reasoning", "thinking", "custom"].includes(value?.format || "")
      ? value!.format! : DEFAULT_REASONING.format,
    level: REASONING_LEVELS.includes(value?.level as ReasoningLevel)
      ? value!.level! : "default",
    budget: Number.isSafeInteger(value?.budget) && value!.budget! > 0
      ? value!.budget! : DEFAULT_REASONING.budget,
    customMapping: typeof value?.customMapping === "string" ? value.customMapping : "",
  };
}

export function reasoningOptions(config: ReasoningSettings): Record<string, unknown> {
  const { level, format, budget } = config;
  if (level === "default") return {};
  if (level === "budget" && (!Number.isSafeInteger(budget) || budget <= 0)) {
    throw new Error("추론 토큰 예산은 양의 정수여야 합니다.");
  }
  if (format === "custom") {
    let mapping: Record<string, unknown>;
    try { mapping = JSON.parse(config.customMapping); }
    catch { throw new Error("추론 레벨별 JSON 매핑 문법이 올바르지 않습니다."); }
    const value = mapping && !Array.isArray(mapping) ? mapping[level] : undefined;
    if (!value || Array.isArray(value) || typeof value !== "object") {
      throw new Error(`추론 JSON 매핑에 ${level} 객체가 필요합니다.`);
    }
    // Exact placeholders preserve numeric and boolean JSON values.
    return JSON.parse(JSON.stringify(value), (_, item) =>
      item === "$budget" ? budget : item === "$level" ? level : item,
    ) as Record<string, unknown>;
  }
  if (format === "reasoning") {
    return { reasoning: level === "budget" ? { max_tokens: budget } : { effort: level } };
  }
  if (level === "budget") {
    throw new Error("토큰 예산은 reasoning 객체 또는 사용자 정의 형식에서 설정할 수 있습니다.");
  }
  if (format === "thinking") {
    return level === "none"
      ? { thinking: { type: "disabled" }, reasoning_effort: null }
      : { thinking: { type: "enabled" }, reasoning_effort: level };
  }
  return { reasoning_effort: level };
}

export const PROTECTED_REQUEST_FIELDS = new Set([
  "model", "messages", "stream", "stream_options", "tools", "tool_choice", "n",
  "__proto__", "constructor", "prototype",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function mergeRequestOptions(
  target: Record<string, unknown>,
  options: Record<string, unknown>,
  nested = false,
): void {
  for (const [key, value] of Object.entries(options)) {
    if ((!nested && PROTECTED_REQUEST_FIELDS.has(key))
      || ["__proto__", "constructor", "prototype"].includes(key)) {
      throw new Error(`추가 요청 옵션에서 ${key} 필드는 변경할 수 없습니다.`);
    }
    if (value === null) delete target[key];
    else if (isObject(value)) {
      if (!isObject(target[key])) target[key] = {};
      mergeRequestOptions(target[key] as Record<string, unknown>, value, true);
    } else target[key] = value;
  }
}
