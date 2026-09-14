import type { ApiMessage, ApiTool } from "./api";
import { taggedImagePart } from "./image-context";
import type { ChatMessage, CompletionProvider, OpenAIToolCall } from "../types";

export const LIST_IMAGES_TOOL = "list_conversation_images";
export const INSPECT_IMAGES_TOOL = "inspect_conversation_images";
const unsupportedProviders = new Set<string>();

function providerKey(provider: CompletionProvider): string {
  return `${provider.baseUrl.trim()}\n${provider.model.trim()}`;
}

export function imageToolsSupported(provider: CompletionProvider): boolean {
  return !unsupportedProviders.has(providerKey(provider));
}

export function markImageToolsUnsupported(provider: CompletionProvider): void {
  unsupportedProviders.add(providerKey(provider));
}

interface ImageEntry {
  id: string;
  name: string;
  dataUrl: string;
  message: number;
  prompt: string;
}

export interface ImageToolResult {
  text: string;
  isError: boolean;
  imageMessage?: ApiMessage;
}

function catalog(messages: ChatMessage[]): ImageEntry[] {
  return messages.flatMap((message, messageIndex) => message.role === "user"
    ? (message.attachments || []).filter((attachment) => attachment.kind === "image" && attachment.dataUrl)
      .map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        dataUrl: attachment.dataUrl!,
        message: messageIndex + 1,
        prompt: message.content.replace(/\s+/g, " ").trim().slice(0, 160),
      }))
    : []);
}

function parseArguments(call: OpenAIToolCall): Record<string, unknown> | undefined {
  try {
    const value = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    return value && !Array.isArray(value) && typeof value === "object"
      ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

export class ConversationImageTools {
  private readonly images: ImageEntry[];
  private remainingInRound = 0;

  constructor(
    messages: ChatMessage[],
    private readonly provider: CompletionProvider,
    private readonly getLimit: (provider: CompletionProvider) => number | undefined,
  ) {
    this.images = catalog(messages);
  }

  available(): boolean { return this.images.length > 0; }

  handles(call: OpenAIToolCall): boolean {
    return call.function.name === LIST_IMAGES_TOOL || call.function.name === INSPECT_IMAGES_TOOL;
  }

  beginRound(): void {
    this.remainingInRound = Math.max(1, this.getLimit(this.provider) || 4);
  }

  displayName(call: OpenAIToolCall): string {
    return call.function.name === LIST_IMAGES_TOOL ? "대화 이미지 목록" : "이미지 원본 확인";
  }

  toApiTools(): ApiTool[] {
    if (!this.available()) return [];
    return [{
      type: "function",
      function: {
        name: LIST_IMAGES_TOOL,
        description: `List the ${this.images.length} image originals stored in this conversation. Use when the request refers to an earlier image and its ID is not already visible.`,
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Optional filename or prompt keyword" },
          },
          additionalProperties: false,
        },
      },
    }, {
      type: "function",
      function: {
        name: INSPECT_IMAGES_TOOL,
        description: "Load selected stored image originals for direct visual inspection. Call this before answering when an omitted image or a specific detail in an earlier image must be checked.",
        parameters: {
          type: "object",
          properties: {
            image_ids: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              description: "Exact IDs returned by list_conversation_images or shown beside an image",
            },
            focus: {
              type: "string",
              description: "Optional visual element, text, region, or comparison to inspect closely",
            },
          },
          required: ["image_ids"],
          additionalProperties: false,
        },
      },
    }];
  }

  async callTool(call: OpenAIToolCall, signal?: AbortSignal): Promise<ImageToolResult> {
    signal?.throwIfAborted();
    const args = parseArguments(call);
    if (!args) return { text: "도구 인자 JSON 파싱 실패", isError: true };

    if (call.function.name === LIST_IMAGES_TOOL) {
      const query = typeof args.query === "string" ? args.query.trim().toLocaleLowerCase() : "";
      const matches = query ? this.images.filter((image) =>
        `${image.name} ${image.prompt}`.toLocaleLowerCase().includes(query)) : this.images;
      return {
        text: JSON.stringify({
          total: this.images.length,
          matches: matches.slice(-200).map((image) => ({
            id: image.id, name: image.name, message: image.message, prompt: image.prompt,
          })),
        }),
        isError: false,
      };
    }

    if (call.function.name !== INSPECT_IMAGES_TOOL) {
      return { text: "미등록 이미지 도구", isError: true };
    }
    const requested = Array.isArray(args.image_ids)
      ? [...new Set(args.image_ids.filter((id): id is string => typeof id === "string" && Boolean(id)))]
      : [];
    if (!requested.length) return { text: "image_ids 필요", isError: true };
    const byId = new Map(this.images.map((image) => [image.id, image]));
    const found = requested.map((id) => byId.get(id)).filter((image): image is ImageEntry => Boolean(image));
    const missing = requested.filter((id) => !byId.has(id));
    if (!found.length) return { text: `이미지 ID 없음: ${missing.join(", ")}`, isError: true };

    const selected = found.slice(0, this.remainingInRound);
    this.remainingInRound = Math.max(0, this.remainingInRound - selected.length);
    const remaining = found.slice(selected.length).map((image) => image.id);
    const focus = typeof args.focus === "string" ? args.focus.trim().slice(0, 500) : "";
    if (!selected.length) {
      return {
        text: `이번 묶음의 이미지 한도 도달 · 다음 도구 호출로 확인 필요: ${remaining.join(", ")}`,
        isError: false,
      };
    }
    return {
      text: [
        `원본 이미지 제공: ${selected.map((image) => image.id).join(", ")}`,
        remaining.length ? `이번 묶음에서 제외: ${remaining.join(", ")} · 다음 도구 호출로 확인 필요` : "",
        missing.length ? `찾을 수 없음: ${missing.join(", ")}` : "",
      ].filter(Boolean).join("\n"),
      isError: false,
      imageMessage: {
        role: "user",
        content: [
          { type: "text", text: [
            "도구로 요청한 대화 이미지 원본이다. 이미지 ID별로 직접 확인하고 현재 질문에 필요한 세부 사항을 반영할 것.",
            focus ? `집중 확인 항목: ${focus}` : "",
          ].filter(Boolean).join("\n") },
          ...selected.flatMap((image) => [
            { type: "text", text: `[이미지 ID: ${image.id}]` },
            taggedImagePart(image.id, image.dataUrl),
          ]),
        ],
      },
    };
  }
}
