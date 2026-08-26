"use client";

import { Check, Copy, ExternalLink } from "lucide-react";
import { Children, isValidElement, memo, type ReactNode, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
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
  const [copied, setCopied] = useState(false);
  const text = getText(children).replace(/\n$/, "");

  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="code-shell">
      <button className="code-copy" type="button" onClick={copy} aria-label="코드 복사">
        {copied ? <Check size={14} /> : <Copy size={14} />}
        <span>{copied ? "복사됨" : "복사"}</span>
      </button>
      <pre>{children}</pre>
    </div>
  );
}

function MarkdownImage({
  src,
  alt,
  width,
}: {
  src?: string;
  alt?: string;
  width: number;
}) {
  const [failed, setFailed] = useState(false);
  if (!src) return null;

  return (
    <span className="markdown-image" style={{ width: `${width}%` }}>
      {failed ? (
        <a href={src} target="_blank" rel="noreferrer noopener" className="image-error">
          이미지 열기 <ExternalLink size={14} />
        </a>
      ) : (
        <img
          src={src}
          alt={alt || ""}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
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

export const MarkdownView = memo(function MarkdownView({
  content,
  imageWidth = 100,
}: {
  content: string;
  imageWidth?: number;
}) {
  const normalizedImageWidth = Math.min(100, Math.max(30, imageWidth));
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        urlTransform={safeUrlTransform}
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          img: ({ src, alt }) => (
            <MarkdownImage
              src={typeof src === "string" ? src : undefined}
              alt={alt}
              width={normalizedImageWidth}
            />
          ),
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {Children.toArray(children)}
              <ExternalLink className="inline-link-icon" size={12} />
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
