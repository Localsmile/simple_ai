import type { ChatMessage, ConversationSettings } from "../types";

const REQUEST_OVERHEAD_TOKENS = 48;
const SAFETY_MARGIN_TOKENS = 1024;
const MESSAGE_OVERHEAD_TOKENS = 8;
const IMAGE_ESTIMATE_TOKENS = 1536;

export interface ContextPlan {
  messages: ChatMessage[];
  omittedMessages: number;
  estimatedInputTokens: number;
  inputBudget: number;
  overLimit: boolean;
  reason?: "turns" | "tokens";
}

function estimateTextTokens(text: string): number {
  if (!text) return 0;
  const cjkCount = (text.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) || []).length;
  return cjkCount + Math.ceil((text.length - cjkCount) / 4);
}

function estimateMessageTokens(
  message: ChatMessage,
  visionEnabled: boolean,
): number {
  let tokens = MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(message.content);

  for (const attachment of message.attachments || []) {
    if (attachment.kind === "text") {
      tokens += estimateTextTokens(attachment.name) + estimateTextTokens(attachment.text || "") + 12;
    } else if (visionEnabled && attachment.dataUrl) {
      tokens += IMAGE_ESTIMATE_TOKENS;
    }
  }

  return tokens;
}

function splitIntoUserTurns(messages: ChatMessage[]): ChatMessage[][] {
  const turns: ChatMessage[][] = [];
  for (const message of messages) {
    if (message.role === "user") {
      turns.push([message]);
    } else if (turns.length) {
      turns[turns.length - 1].push(message);
    }
  }
  return turns;
}

function estimateRequestContextTokens(
  messages: ChatMessage[],
  settings: ConversationSettings,
): number {
  return messages.reduce(
    (total, message) => total + estimateMessageTokens(message, settings.vision),
    estimateTextTokens(settings.systemPrompt)
      + (settings.openingMessage.trim()
        ? MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(settings.openingMessage)
        : 0)
      + REQUEST_OVERHEAD_TOKENS,
  );
}

export function planRequestContext(
  messages: ChatMessage[],
  settings: ConversationSettings,
): ContextPlan {
  const requestMessages = messages.filter((message) => !message.error);
  const allTurns = splitIntoUserTurns(requestMessages);
  const turnLimitedMessages = settings.historyTurns === -1
    ? allTurns.flat()
    : allTurns.slice(-Math.max(1, Math.floor(settings.historyTurns))).flat();
  const omittedByTurnLimit = requestMessages.length - turnLimitedMessages.length;
  const systemTokens = estimateTextTokens(settings.systemPrompt)
    + (settings.openingMessage.trim()
      ? MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(settings.openingMessage)
      : 0)
    + REQUEST_OVERHEAD_TOKENS;
  const unlimited = settings.contextLimit === -1;
  const inputBudget = unlimited
    ? -1
    : Math.max(
        0,
        Math.floor(settings.contextLimit) - Math.floor(settings.maxTokens) - SAFETY_MARGIN_TOKENS,
      );
  const allMessageTokens = estimateRequestContextTokens(turnLimitedMessages, settings);

  if (unlimited || !settings.autoTrimContext) {
    return {
      messages: turnLimitedMessages,
      omittedMessages: omittedByTurnLimit,
      estimatedInputTokens: allMessageTokens,
      inputBudget,
      overLimit: false,
      reason: omittedByTurnLimit > 0 ? "turns" : undefined,
    };
  }

  const turns = splitIntoUserTurns(turnLimitedMessages);
  if (!turns.length) {
    return {
      messages: [],
      omittedMessages: requestMessages.length,
      estimatedInputTokens: systemTokens,
      inputBudget,
      overLimit: systemTokens > inputBudget,
      reason: requestMessages.length > 0 ? "turns" : undefined,
    };
  }

  let estimatedInputTokens = systemTokens;
  let firstIncludedTurn = turns.length - 1;

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turnTokens = turns[index].reduce(
      (total, message) => total + estimateMessageTokens(message, settings.vision),
      0,
    );
    if (index !== turns.length - 1 && estimatedInputTokens + turnTokens > inputBudget) break;
    estimatedInputTokens += turnTokens;
    firstIncludedTurn = index;
  }

  const selectedMessages = turns.slice(firstIncludedTurn).flat();
  const tokenTrimmed = selectedMessages.length < turnLimitedMessages.length;
  return {
    messages: selectedMessages,
    omittedMessages: requestMessages.length - selectedMessages.length,
    estimatedInputTokens,
    inputBudget,
    overLimit: estimatedInputTokens > inputBudget,
    reason: tokenTrimmed ? "tokens" : omittedByTurnLimit > 0 ? "turns" : undefined,
  };
}
