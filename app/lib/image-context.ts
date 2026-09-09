type Message = Record<string, unknown>;

function isImage(part: unknown): boolean {
  return Boolean(part && typeof part === "object"
    && ["image_url", "input_image", "image"].includes(String((part as Message).type)));
}

export function imageCount(messages: Message[]): number {
  return messages.reduce((count, message) => count + (Array.isArray(message.content)
    ? message.content.filter(isImage).length : 0), 0);
}

// Match an explicit image-count ceiling, never dimensions, bytes or token limits.
export function imageLimitFromError(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const patterns = [
    /(?:at most|maximum of|up to|no more than)\s+(\d+)\s+images?(?:\(s\))?\b/i,
    /(?:maximum|max)\s+(?:number of\s+)?images?(?:\(s\))?\s*(?:allowed|supported|per (?:request|prompt))?\s*(?:is|:|=)?\s*(\d+)\b/i,
    /images?\s+(?:count\s+)?limit\s*(?:is|:|=)\s*(\d+)\b/i,
  ];
  for (const pattern of patterns) {
    const match = error.message.match(pattern);
    if (!match) continue;
    const limit = Number(match[1]);
    if (Number.isSafeInteger(limit) && limit > 0) return limit;
  }
  return undefined;
}

export function limitHistoryImages(messages: Message[], limit: number): Message[] {
  if (imageCount(messages) <= limit) return messages;
  let latestUser = messages.length - 1;
  while (latestUser >= 0 && messages[latestUser].role !== "user") latestUser -= 1;
  const currentCount = latestUser < 0 ? 0 : imageCount([messages[latestUser]]);
  if (currentCount > limit) {
    throw new Error(`현재 첨부 이미지 ${currentCount}장 · API 요청당 최대 ${limit}장`);
  }
  let remaining = limit;
  const result = [...messages];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!Array.isArray(message.content)) continue;
    let omitted = 0;
    const content = message.content.filter((part) => {
      if (!isImage(part)) return true;
      if (remaining > 0) { remaining -= 1; return true; }
      omitted += 1;
      return false;
    });
    if (omitted) {
      result[index] = { ...message, content: [...content, {
        type: "text",
        text: `[과거 첨부 이미지 ${omitted}장: API 이미지 수 제한으로 이번 요청에서 원본 제외. 기존 대화의 설명·분석만 참고할 수 있으며, 원본의 세부 정보는 확인할 수 없음.]`,
      }] };
    }
  }
  return result;
}
