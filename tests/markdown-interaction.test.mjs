import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { loadTs } from "./load-ts.mjs";

const window = new Window({ url: "https://chat.test/" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? window : window[name] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const { MarkdownView } = loadTs("app/components/MarkdownView.tsx");
const { MessageList } = loadTs("app/components/MessageList.tsx");
after(() => window.happyDOM.close());

function surface(t) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return {
    container,
    render: async (element) => act(async () => root.render(element)),
  };
}

function clipboard(writeText) {
  Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: writeText });
}

test("streamed code keeps the same copy button and copies the click-time text", async (t) => {
  const { container, render } = surface(t);
  const copied = [];
  let finishCopy;
  clipboard((text) => {
    copied.push(text);
    return new Promise((resolve) => { finishCopy = resolve; });
  });
  const markdown = (code) => createElement(MarkdownView, { content: `\`\`\`js\n${code}`, imageWidth: 80 });
  await render(markdown("const n = 1;"));
  const button = container.querySelector(".code-copy");
  button.focus();
  button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  await render(markdown("const n = 12;"));
  assert.equal(container.querySelector(".code-copy"), button);
  assert.equal(document.activeElement, button);
  await act(async () => button.click());
  assert.deepEqual(copied, ["const n = 12;"]);
  await render(markdown("const n = 123;\nconsole.log(n);\n```"));
  await act(async () => finishCopy());
  assert.match(button.textContent, /복사됨/);
  await render(markdown("const n = 123;\nconsole.log(n);\n```\n\n완료"));
  assert.equal(container.querySelector(".code-copy"), button);
  assert.match(button.textContent, /복사됨/);
  assert.deepEqual(copied, ["const n = 12;"]);
});

test("clipboard failure is visible and a subsequent code copy can succeed", async (t) => {
  const { container, render } = surface(t);
  await render(createElement(MarkdownView, { content: "```txt\nfirst\n```" }));
  const button = container.querySelector(".code-copy");
  clipboard(async () => { throw new Error("Permission denied"); });
  await act(async () => button.click());
  assert.match(button.textContent, /복사 실패/);
  let copied;
  clipboard(async (text) => { copied = text; });
  await render(createElement(MarkdownView, { content: "```txt\nupdated\n```" }));
  await act(async () => button.click());
  assert.equal(copied, "updated");
  assert.match(button.textContent, /복사됨/);
});

test("each code block copies only its own text and survives image scale updates", async (t) => {
  const { container, render } = surface(t);
  const copied = [];
  clipboard(async (text) => { copied.push(text); });
  const content = "```js\nconst a = 1;\n```\n\n```txt\nsecond\n```\n\n![picture](https://img.test/a.png)";
  await render(createElement(MarkdownView, { content, imageWidth: 80 }));
  const buttons = [...container.querySelectorAll(".code-copy")];
  await act(async () => buttons[1].click());
  await render(createElement(MarkdownView, { content, imageWidth: 40 }));
  assert.deepEqual([...container.querySelectorAll(".code-copy")], buttons);
  assert.equal(container.querySelector(".markdown-body").style.getPropertyValue("--markdown-image-width"), "40%");
  await act(async () => buttons[0].click());
  assert.deepEqual(copied, ["second", "const a = 1;"]);
});

test("a failed partial image URL can recover when streaming changes the URL", async (t) => {
  const { container, render } = surface(t);
  await render(createElement(MarkdownView, { content: "![picture](https://img.test/partial)" }));
  await act(async () => container.querySelector("img").dispatchEvent(new Event("error")));
  assert.ok(container.querySelector(".image-error"));
  await render(createElement(MarkdownView, { content: "![picture](https://img.test/complete.png)" }));
  assert.equal(container.querySelector("img").src, "https://img.test/complete.png");
  assert.equal(container.querySelector(".image-error"), null);
});

test("message copy stays enabled during generation while mutation actions stay disabled", async (t) => {
  const { container, render } = surface(t);
  const message = { id: "response", role: "assistant", content: "partial answer", createdAt: Date.now() };
  let copied;
  const noop = () => {};
  await render(createElement(MessageList, {
    messages: [message], openingMessage: "", imageWidth: 100,
    editingMessageId: "", editingContent: "", copiedId: "", disabled: true,
    onCopy: (value) => { copied = value.content; }, onBeginEdit: noop, onEditContentChange: noop,
    onCancelEdit: noop, onSaveEdit: noop, onBranch: noop, onSelectVariant: noop,
    onUseReasoningAsContent: noop, onReroll: noop, onRemove: noop,
  }));
  const actions = [...container.querySelectorAll(".message-actions button")];
  const copy = actions.find((button) => button.textContent === "복사");
  assert.equal(copy.disabled, false);
  await act(async () => copy.click());
  assert.equal(copied, "partial answer");
  assert.ok(actions.filter((button) => button !== copy).every((button) => button.disabled));
});
