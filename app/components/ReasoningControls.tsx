import type { ReasoningLevel, ReasoningSettings } from "../types";
import { configuredReasoningLevels, reasoningLevelLabel, reasoningLevelsForFormat, resolvePresetReasoning } from "../lib/reasoning";

export function ReasoningControls({ value, selectedLevels, onChange }: {
  value: ReasoningSettings;
  selectedLevels?: ReasoningLevel[];
  onChange: (value: ReasoningSettings, levels: ReasoningLevel[]) => void;
}) {
  const available = reasoningLevelsForFormat(value.format);
  const levels = configuredReasoningLevels(value, selectedLevels);
  const config = resolvePresetReasoning({ reasoning: value, reasoningLevels: levels });
  const updateLevels = (next: ReasoningLevel[]) => onChange(
    resolvePresetReasoning({ reasoning: value, reasoningLevels: next }), next,
  );
  return (
    <div className="reasoning-settings">
      <label className="field-group">
        <span className="field-label">추론 API 형식</span>
        <select value={value.format} onChange={(event) => {
          const format = event.target.value as ReasoningSettings["format"];
          onChange({ ...value, format, level: "default" }, reasoningLevelsForFormat(format));
        }}>
          <option value="effort">reasoning_effort</option>
          <option value="reasoning">reasoning</option>
          <option value="thinking">thinking + reasoning_effort</option>
          <option value="custom">사용자 정의 JSON</option>
        </select>
      </label>
      <fieldset className="reasoning-level-options">
        <legend>사용할 추론 레벨</legend>
        <div>
          {available.map((level) => <label key={level}>
            <input type="checkbox" checked={levels.includes(level)}
              disabled={levels.length === 1 && levels.includes(level)}
              onChange={(event) => updateLevels(event.target.checked
                ? [...levels, level] : levels.filter((item) => item !== level))} />
            <span>{reasoningLevelLabel(level)}</span>
          </label>)}
        </div>
      </fieldset>
      <label className="field-group">
        <span className="field-label">기본 추론 레벨</span>
        <select value={config.level} onChange={(event) => onChange({
          ...value, level: event.target.value as ReasoningSettings["level"],
        }, levels)}>
          {levels.map((level) => <option value={level} key={level}>
            {reasoningLevelLabel(level)}
          </option>)}
        </select>
      </label>
      {levels.includes("budget") && (
        <label className="field-group">
          <span className="field-label">추론 토큰 예산</span>
          <input type="number" min="1" step="1" key={value.budget}
            defaultValue={value.budget}
            onBlur={(event) => {
              const budget = Number(event.target.value);
              if (Number.isSafeInteger(budget) && budget > 0) onChange({ ...value, budget }, levels);
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
            onChange={(event) => onChange({ ...value, customMapping: event.target.value }, levels)} />
        </label>
      )}
    </div>
  );
}
