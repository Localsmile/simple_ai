import { DEFAULT_REASONING, type ModelPreset, type ReasoningSettings, type ReasoningLevel } from "../types";

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

export function reasoningLevelsForFormat(format: ReasoningSettings["format"]): ReasoningLevel[] {
  return REASONING_LEVELS.filter((level) => {
    if (format === "thinking") return ["default", "none", "low", "high", "max"].includes(level);
    return level !== "budget" || format === "reasoning" || format === "custom";
  });
}

export function configuredReasoningLevels(
  reasoning: ReasoningSettings,
  selected?: ReasoningLevel[],
): ReasoningLevel[] {
  const available = reasoningLevelsForFormat(normalizeReasoning(reasoning).format);
  if (!Array.isArray(selected)) return available;
  const levels = available.filter((level) => selected.includes(level));
  return levels.length ? levels : ["default"];
}

export function resolvePresetReasoning(
  preset: Pick<ModelPreset, "reasoning" | "reasoningLevels">,
  level?: ReasoningLevel,
): ReasoningSettings {
  const config = normalizeReasoning(preset.reasoning);
  const levels = configuredReasoningLevels(config, preset.reasoningLevels);
  const defaultLevel = levels.includes(config.level) ? config.level : levels[0];
  return { ...config, level: level && levels.includes(level) ? level : defaultLevel };
}

export function reasoningLevelLabel(level: ReasoningLevel): string {
  return level === "default" ? "API 기본값" : level === "budget" ? "토큰 예산" : level;
}

export function reasoningOptions(config: ReasoningSettings): Record<string, unknown> {
  const { level, format, budget } = config;
  if (level === "default") return {};
  if (level === "budget" && (!Number.isSafeInteger(budget) || budget <= 0)) {
    throw new Error("추론 토큰 예산 오류 · 양의 정수 필요");
  }
  if (format === "custom") {
    let mapping: Record<string, unknown>;
    try { mapping = JSON.parse(config.customMapping); }
    catch { throw new Error("추론 레벨별 JSON 매핑 문법 오류"); }
    const value = mapping && !Array.isArray(mapping) ? mapping[level] : undefined;
    if (!value || Array.isArray(value) || typeof value !== "object") {
      throw new Error(`추론 JSON 매핑 오류 · ${level} 객체 없음`);
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
    throw new Error("토큰 예산 미지원 형식 · reasoning 또는 사용자 정의 JSON 필요");
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
      throw new Error(`추가 요청 옵션 오류 · 보호된 필드: ${key}`);
    }
    if (value === null) delete target[key];
    else if (isObject(value)) {
      if (!isObject(target[key])) target[key] = {};
      mergeRequestOptions(target[key] as Record<string, unknown>, value, true);
    } else target[key] = value;
  }
}
