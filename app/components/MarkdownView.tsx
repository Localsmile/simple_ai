"use client";

import { Check, CircleAlert, Copy, ExternalLink } from "lucide-react";
import { Children, isValidElement, memo, type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

function getText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(getText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return getText(node.props.children);
  }
  return "";
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const copyAttempt = useRef(0);
  const text = getText(children).replace(/\n$/, "");

  useEffect(() => () => {
    clearTimeout(resetTimer.current);
    copyAttempt.current += 1;
  }, []);

  const copy = async () => {
    const attempt = ++copyAttempt.current;
    clearTimeout(resetTimer.current);
    let result: "copied" | "error" = "copied";
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      result = "error";
    }
    if (attempt !== copyAttempt.current) return;
    setCopyState(result);
    resetTimer.current = setTimeout(() => setCopyState("idle"), 1400);
  };

  return (
    <div className="code-shell">
      <button className="code-copy" type="button" onClick={() => void copy()} aria-label="코드 복사">
        {copyState === "copied" ? <Check size={14} /> : copyState === "error" ? <CircleAlert size={14} /> : <Copy size={14} />}
        <span role="status">{copyState === "copied" ? "복사됨" : copyState === "error" ? "복사 실패" : "복사"}</span>
      </button>
      <pre>{children}</pre>
    </div>
  );
}

function MarkdownImage({
  src,
  alt,
}: {
  src?: string | Blob;
  alt?: string;
}) {
  const [failedSrc, setFailedSrc] = useState("");
  if (typeof src !== "string" || !src) return null;

  return (
    <span className="markdown-image">
      {failedSrc === src ? (
        <a href={src} target="_blank" rel="noreferrer noopener" className="image-error">
          이미지 열기 <ExternalLink size={14} />
        </a>
      ) : (
        <img
          src={src}
          alt={alt || ""}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailedSrc(src)}
        />
      )}
      <span className="markdown-image-caption">
        <span>{alt || "이미지"}</span>
      </span>
    </span>
  );
}

function safeUrlTransform(url: string): string {
  if (/^data:image\/(png|jpeg|jpg|gif|webp);base64,/i.test(url)) return url;
  return defaultUrlTransform(url);
}

// Stable renderer types keep controls mounted while streamed Markdown changes.
const markdownComponents: Components = {
  pre: CodeBlock,
  img: MarkdownImage,
  a: function MarkdownLink({ href, children }) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {Children.toArray(children)}
        <ExternalLink className="inline-link-icon" size={12} />
      </a>
    );
  },
};

export const MarkdownView = memo(function MarkdownView({
  content,
  imageWidth = 100,
}: {
  content: string;
  imageWidth?: number;
}) {
  const normalizedImageWidth = Math.min(100, Math.max(30, imageWidth));
  return (
    <div className="markdown-body" style={{ "--markdown-image-width": `${normalizedImageWidth}%` } as CSSProperties}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        urlTransform={safeUrlTransform}
        components={markdownComponents}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
