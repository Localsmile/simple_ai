type Message = Record<string, unknown>;

export const IMAGE_CONTEXT_ID = Symbol("simple-ai-image-id");

export type ImagePart = Record<string | symbol, unknown>;

export function isImagePart(part: unknown): part is ImagePart {
  return Boolean(part && typeof part === "object"
    && ["image_url", "input_image", "image"].includes(String((part as Message).type)));
}

export function taggedImagePart(id: string, dataUrl: string): ImagePart {
  return {
    type: "image_url",
    image_url: { url: dataUrl, detail: "auto" },
    [IMAGE_CONTEXT_ID]: id,
  };
}

export function imagePartId(part: unknown): string | undefined {
  if (!isImagePart(part)) return undefined;
  const id = part[IMAGE_CONTEXT_ID];
  return typeof id === "string" && id ? id : undefined;
}

export function imageCount(messages: Message[]): number {
  return messages.reduce((count, message) => count + (Array.isArray(message.content)
    ? message.content.filter(isImagePart).length : 0), 0);
}

export function latestUserOverflow(messages: Message[], limit: number): ImagePart[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    return message.content.filter(isImagePart).slice(limit);
  }
  return [];
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
  let remaining = limit;
  const result = [...messages];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!Array.isArray(message.content)) continue;
    const content: unknown[] = [];
    let changed = false;
    for (const part of message.content) {
      if (!isImagePart(part)) { content.push(part); continue; }
      if (remaining > 0) { remaining -= 1; content.push(part); continue; }
      const id = imagePartId(part);
      changed = true;
      content.push({
        type: "text",
        text: id
          ? `[이미지 원본 제외: ${id}. 세부 확인이 필요하면 inspect_conversation_images 도구로 원본을 확인할 것.]`
          : "[과거 첨부 이미지 원본 제외. 기존 대화의 설명·분석만 참고 가능.]",
      });
    }
    if (changed) result[index] = { ...message, content };
  }
  return result;
}
