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
        <span className="field-label">추론 전송 형식</span>
        <select value={value.format} onChange={(event) => onChange({
          ...value, format: event.target.value as ReasoningSettings["format"], level: "default",
        })}>
          <option value="effort">reasoning_effort</option>
          <option value="reasoning">reasoning 객체 · 레벨 / 토큰 예산</option>
          <option value="thinking">thinking + reasoning_effort</option>
          <option value="custom">사용자 정의 · 레벨별 JSON</option>
        </select>
      </label>
      <label className="field-group">
        <span className="field-label">추론 레벨 <em>현재 대화</em></span>
        <select value={value.level} onChange={(event) => onChange({
          ...value, level: event.target.value as ReasoningSettings["level"],
        })}>
          {levels.map((level) => <option value={level} key={level}>
            {level === "default" ? "공급자 기본값 · 옵션 미전송"
              : level === "none" ? "none · 추론 끄기"
                : level === "budget" ? "토큰 예산 지정" : level}
          </option>)}
        </select>
        <small>지원 형식·레벨은 API별로 다름 · 미지원 모델은 기본값 사용 · 명시한 추론 설정 우선</small>
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
          <small>선택한 레벨의 객체만 전송 · "$budget"은 숫자 예산으로 치환 · 기본값은 매핑 미사용</small>
        </label>
      )}
    </div>
  );
}
