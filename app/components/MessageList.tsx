"use client";

import {
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileCode2,
  GitBranch,
  Pencil,
  RotateCcw,
  Scissors,
  Trash2,
  Wrench,
} from "lucide-react";
import { memo, useEffect, useState } from "react";
import type { ChatMessage } from "../types";
import { MarkdownView } from "./MarkdownView";

type MessageAction = (message: ChatMessage) => void | Promise<void>;
type MessageIdAction = (messageId: string) => void | Promise<void>;
type MessageVariantAction = (messageId: string, variantId: string) => void | Promise<void>;

interface MessageListProps {
  messages: ChatMessage[];
  openingMessage: string;
  imageWidth: number;
  editingMessageId: string;
  editingContent: string;
  copiedId: string;
  disabled: boolean;
  onCopy: MessageAction;
  onBeginEdit: MessageAction;
  onEditContentChange: (content: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: MessageAction;
  onBranch: MessageIdAction;
  onSelectVariant: MessageVariantAction;
  onReroll: MessageIdAction;
  onRemove: MessageIdAction;
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString("ko-KR", { month: "short", day: "numeric" });
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

const PendingResponse = memo(function PendingResponse({ startedAt }: { startedAt: number }) {
  const [elapsed, setElapsed] = useState(() =>
    Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
  );

  useEffect(() => {
    const timer = window.setInterval(() => {
      setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  return (
    <div className="pending-response" role="status">
      <span className="typing-indicator" aria-hidden="true"><i /><i /><i /></span>
      <strong>{elapsed < 2 ? "요청 준비 중" : "응답 대기 중"}</strong>
      <time>{formatElapsed(elapsed)}</time>
    </div>
  );
});

const ReasoningBlock = memo(function ReasoningBlock({
  reasoning,
  imageWidth,
}: {
  reasoning: string;
  imageWidth: number;
}) {
  const [open, setOpen] = useState(false);

  return (
    <section className="message-reasoning">
      <button
        type="button"
        className="reasoning-toggle"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>thinking</span>
        <ChevronDown className={open ? "open" : ""} size={14} />
      </button>
      {open && (
        <div className="reasoning-content">
          <MarkdownView content={reasoning} imageWidth={imageWidth} />
        </div>
      )}
    </section>
  );
});

interface MessageItemProps {
  message: ChatMessage;
  imageWidth: number;
  editing: boolean;
  editingContent: string;
  copied: boolean;
  disabled: boolean;
  hasFollowingMessages: boolean;
  onCopy: MessageAction;
  onBeginEdit: MessageAction;
  onEditContentChange: (content: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: MessageAction;
  onBranch: MessageIdAction;
  onSelectVariant: MessageVariantAction;
  onReroll: MessageIdAction;
  onRemove: MessageIdAction;
}

const MessageItem = memo(function MessageItem({
  message,
  imageWidth,
  editing,
  editingContent,
  copied,
  disabled,
  hasFollowingMessages,
  onCopy,
  onBeginEdit,
  onEditContentChange,
  onCancelEdit,
  onSaveEdit,
  onBranch,
  onSelectVariant,
  onReroll,
  onRemove,
}: MessageItemProps) {
  const responseVariants = message.responseVariants || [];
  const activeVariantIndex = responseVariants.findIndex(
    (variant) => variant.id === message.activeResponseVariantId,
  );
  const hasResponseVariants = message.role === "assistant"
    && responseVariants.length > 1
    && activeVariantIndex >= 0;
  const variantSelectionTitle = hasFollowingMessages
    ? "이 답변을 선택해 새 대화로 분기"
    : "이 답변 선택";
  const responseIdentity = message.role === "assistant"
    ? [message.model, message.providerPresetName].filter(Boolean).join(" · ")
    : "";

  return (
    <article className={`message ${message.role} ${message.error ? "error" : ""}`}>
      <div className="message-gutter">
        <div className="role-icon">
          {message.role === "assistant" ? <Bot size={15} /> : <span>U</span>}
        </div>
      </div>
      <div className="message-main">
        <header className="message-meta">
          <div className="message-author">
            <strong>{message.role === "assistant" ? "Assistant" : "User"}</strong>
            {responseIdentity && (
              <span className="message-model" title={responseIdentity}>{responseIdentity}</span>
            )}
          </div>
          <time>{formatDate(message.createdAt)}</time>
        </header>

        {message.attachments && message.attachments.length > 0 && (
          <div className="message-attachments">
            {message.attachments.map((attachment) =>
              attachment.kind === "image" && attachment.dataUrl ? (
                <img
                  key={attachment.id}
                  src={attachment.dataUrl}
                  alt={attachment.name}
                  loading="lazy"
                  decoding="async"
                />
              ) : (
                <span key={attachment.id}>
                  <FileCode2 size={14} /> {attachment.name}
                </span>
              ),
            )}
          </div>
        )}

        {message.toolEvents && message.toolEvents.length > 0 && (
          <div className="tool-events">
            {message.toolEvents.map((event) => (
              <span key={event.id} className={event.status} title={event.summary}>
                {event.status === "done" ? <Check size={12} /> : <Wrench size={12} />}
                {event.name}
              </span>
            ))}
          </div>
        )}

        {message.contextTrim && message.contextTrim.omittedMessages > 0 && (
          <div className="context-trim-notice">
            <Scissors size={12} />
            이전 메시지 {message.contextTrim.omittedMessages}개 제외
            <span>
              약 {formatTokens(message.contextTrim.estimatedInputTokens)} 입력 토큰
              {message.contextTrim.reason === "turns" && " · 최근 턴 설정"}
            </span>
          </div>
        )}

        {!editing && message.role === "assistant" && message.reasoning && (
          <ReasoningBlock reasoning={message.reasoning} imageWidth={imageWidth} />
        )}

        {editing ? (
          <div className="message-editor">
            <textarea
              value={editingContent}
              onChange={(event) => onEditContentChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") onCancelEdit();
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  void onSaveEdit(message);
                }
              }}
              rows={Math.min(12, Math.max(3, editingContent.split("\n").length + 1))}
              autoFocus
              aria-label="메시지 수정"
            />
            <div className="message-editor-actions">
              <span>Ctrl+Enter 저장 · Esc 취소</span>
              <button type="button" onClick={onCancelEdit}>취소</button>
              <button
                type="button"
                className="primary"
                onClick={() => void onSaveEdit(message)}
                disabled={!editingContent.trim() && !message.attachments?.length}
              >
                저장
              </button>
            </div>
          </div>
        ) : message.role === "assistant" ? (
          message.content
            ? <MarkdownView content={message.content} imageWidth={imageWidth} />
            : <PendingResponse startedAt={message.createdAt} />
        ) : (
          message.content && <MarkdownView content={message.content} imageWidth={imageWidth} />
        )}

        {(message.content || message.attachments?.length) && (
          <footer className="message-footer">
            <div className="message-actions">
              {message.content && (
                <button type="button" onClick={() => void onCopy(message)} disabled={disabled}>
                  {copied ? <Check size={13} /> : <Copy size={13} />}
                  {copied ? "복사됨" : "복사"}
                </button>
              )}
              <button type="button" onClick={() => onBeginEdit(message)} disabled={disabled}>
                <Pencil size={13} /> 수정
              </button>
              <button
                type="button"
                onClick={() => void onBranch(message.id)}
                disabled={disabled}
                title="이 메시지까지 복사해 새 대화로 분기"
              >
                <GitBranch size={13} /> 분기
              </button>
              <button
                type="button"
                onClick={() => void onReroll(message.id)}
                disabled={disabled}
                title="기존 답변을 보존하고 다시 생성"
              >
                <RotateCcw size={13} /> 다시 생성
              </button>
              {hasResponseVariants && (
                <div className="response-variants" role="group" aria-label="답변 후보 선택">
                  <button
                    type="button"
                    onClick={() => void onSelectVariant(
                      message.id,
                      responseVariants[activeVariantIndex - 1].id,
                    )}
                    disabled={disabled || activeVariantIndex === 0}
                    title={variantSelectionTitle}
                    aria-label="이전 답변 후보"
                  >
                    <ChevronLeft size={13} />
                  </button>
                  <span>{activeVariantIndex + 1} / {responseVariants.length}</span>
                  <button
                    type="button"
                    onClick={() => void onSelectVariant(
                      message.id,
                      responseVariants[activeVariantIndex + 1].id,
                    )}
                    disabled={disabled || activeVariantIndex === responseVariants.length - 1}
                    title={variantSelectionTitle}
                    aria-label="다음 답변 후보"
                  >
                    <ChevronRight size={13} />
                  </button>
                </div>
              )}
              <button
                type="button"
                className="danger"
                onClick={() => void onRemove(message.id)}
                disabled={disabled}
                title={hasResponseVariants ? "현재 답변 후보만 삭제" : "메시지 삭제"}
              >
                <Trash2 size={13} /> 삭제
              </button>
            </div>
            {message.usage && (
              <span className="message-usage">
                {formatTokens(message.usage.input)} in · {formatTokens(message.usage.output)} out
                {message.usage.cached > 0 && ` · ${formatTokens(message.usage.cached)} cached`}
              </span>
            )}
          </footer>
        )}
      </div>
    </article>
  );
});

const OpeningMessage = memo(function OpeningMessage({
  content,
  imageWidth,
}: {
  content: string;
  imageWidth: number;
}) {
  if (!content.trim()) return null;
  return (
    <article className="message assistant opening-message">
      <div className="message-gutter">
        <div className="role-icon"><Bot size={15} /></div>
      </div>
      <div className="message-main">
        <header className="message-meta">
          <div className="message-author"><strong>시작 메시지</strong></div>
        </header>
        <MarkdownView content={content} imageWidth={imageWidth} />
      </div>
    </article>
  );
});

export const MessageList = memo(function MessageList({
  messages,
  openingMessage,
  imageWidth,
  editingMessageId,
  editingContent,
  copiedId,
  disabled,
  onCopy,
  onBeginEdit,
  onEditContentChange,
  onCancelEdit,
  onSaveEdit,
  onBranch,
  onSelectVariant,
  onReroll,
  onRemove,
}: MessageListProps) {
  return (
    <div className="message-list">
      <OpeningMessage content={openingMessage} imageWidth={imageWidth} />
      {messages.map((message, index) => {
        const editing = editingMessageId === message.id;
        return (
          <MessageItem
            key={message.id}
            message={message}
            imageWidth={imageWidth}
            editing={editing}
            editingContent={editing ? editingContent : ""}
            copied={copiedId === message.id}
            disabled={disabled}
            hasFollowingMessages={index < messages.length - 1}
            onCopy={onCopy}
            onBeginEdit={onBeginEdit}
            onEditContentChange={onEditContentChange}
            onCancelEdit={onCancelEdit}
            onSaveEdit={onSaveEdit}
            onBranch={onBranch}
            onSelectVariant={onSelectVariant}
            onReroll={onReroll}
            onRemove={onRemove}
          />
        );
      })}
    </div>
  );
});
