import type { ReasoningSettings } from "../types";
import { REASONING_LEVELS } from "../lib/reasoning";

export function ReasoningControls({ value, onChange }: {
  value: ReasoningSettings; onChange: (value: ReasoningSettings) => void;
}) {
  const levels = REASONING_LEVELS.filter((level) => {
    if (value.format === "thinking") return ["default", "none", "low", "high", "max"].includes(level);
    return level !== "budget" || value.format === "reasoning" || value.format === "custom";
  });
  return (
    <div className="reasoning-settings">
      <label className="field-group">
        <span className="field-label">추론 API 형식</span>
        <select value={value.format} onChange={(event) => onChange({
          ...value, format: event.target.value as ReasoningSettings["format"], level: "default",
        })}>
          <option value="effort">reasoning_effort</option>
          <option value="reasoning">reasoning</option>
          <option value="thinking">thinking + reasoning_effort</option>
          <option value="custom">사용자 정의 JSON</option>
        </select>
      </label>
      <label className="field-group">
        <span className="field-label">추론 레벨 <em>API 값</em></span>
        <select value={value.level} onChange={(event) => onChange({
          ...value, level: event.target.value as ReasoningSettings["level"],
        })}>
          {levels.map((level) => <option value={level} key={level}>
            {level === "default" ? "기본값"
              : level === "budget" ? "토큰 예산" : level}
          </option>)}
        </select>
      </label>
      {value.level === "budget" && (
        <label className="field-group">
          <span className="field-label">추론 토큰 예산</span>
          <input type="number" min="1" step="1" key={value.budget}
            defaultValue={value.budget}
            onBlur={(event) => {
              const budget = Number(event.target.value);
              if (Number.isSafeInteger(budget) && budget > 0) onChange({ ...value, budget });
              else event.target.value = String(value.budget);
            }}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
          />
        </label>
      )}
      {value.format === "custom" && (
        <label className="field-group">
          <span className="field-label">레벨별 요청 JSON</span>
          <textarea value={value.customMapping} rows={7} spellCheck={false}
            placeholder={'{\n  "low": {"custom_parameter": "value"}\n}'}
            onChange={(event) => onChange({ ...value, customMapping: event.target.value })} />
        </label>
      )}
    </div>
  );
}
