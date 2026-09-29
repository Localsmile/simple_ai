import { useCallback, useRef, useState, type SetStateAction } from "react";

// Event batches and async completions must read the last submitted update.
export function useLiveState<T>(initial: T | (() => T)) {
  const [state, setState] = useState(initial);
  const latest = useRef(state);
  const update = useCallback((action: SetStateAction<T>) => {
    const next = typeof action === "function"
      ? (action as (current: T) => T)(latest.current) : action;
    if (Object.is(next, latest.current)) return;
    latest.current = next;
    setState(next);
  }, []);
  return [state, update, latest] as const;
}
