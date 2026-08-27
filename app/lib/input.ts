import type { SendKey } from "../types";

export function enterSendsMessage(preference: SendKey, touchInput: boolean): boolean {
  return preference === "enter" || (preference === "auto" && !touchInput);
}

export function shouldSendMessage(
  event: {
    key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean;
    altKey: boolean; isComposing: boolean; keyCode?: number;
  },
  preference: SendKey,
  touchInput: boolean,
): boolean {
  if (event.key !== "Enter" || event.isComposing || event.keyCode === 229
    || event.shiftKey || event.altKey) return false;
  return event.ctrlKey || event.metaKey || enterSendsMessage(preference, touchInput);
}
