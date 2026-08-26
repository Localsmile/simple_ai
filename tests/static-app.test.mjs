import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("exports a GitHub Pages-ready app", async () => {
  const [html, page] = await Promise.all([
    readFile(new URL("dist/index.html", root), "utf8"),
    readFile(new URL("app/page.tsx", root), "utf8"),
  ]);
  assert.match(html, /<title>Simple AI — OpenAI-Compatible Workspace<\/title>/i);
  assert.match(html, /<div id="root"><\/div>/);
  assert.match(html, /\/assets\/[^"']+\.js/);
  assert.match(page, /SIMPLE AI/);
  assert.doesNotMatch(page, /<h1>새 세션<\/h1>/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
  assert.doesNotMatch(html, /local\.adguard\.org/i);
  await access(new URL("dist/.nojekyll", root));
});

test("keeps credentials out of source defaults", async () => {
  const [types, storage] = await Promise.all([
    readFile(new URL("app/types.ts", root), "utf8"),
    readFile(new URL("app/lib/storage.ts", root), "utf8"),
  ]);
  assert.match(types, /apiKey:\s*""/);
  assert.match(types, /mcpToken:\s*""/);
  assert.doesNotMatch(`${types}\n${storage}`, /sk-(?:proj-)?[a-zA-Z0-9_-]{16,}/);
});

test("supports custom connection presets and message controls", async () => {
  const [types, page, settings, messageList] = await Promise.all([
    readFile(new URL("app/types.ts", root), "utf8"),
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/components/SettingsPanel.tsx", root), "utf8"),
    readFile(new URL("app/components/MessageList.tsx", root), "utf8"),
  ]);
  assert.match(types, /providerPresets:\s*ProviderPreset\[\]/);
  assert.match(types, /activeProviderId:\s*string/);
  assert.match(settings, /연결 프리셋/);
  assert.match(settings, /addProvider/);
  assert.match(settings, /removeProvider/);
  assert.doesNotMatch(settings, />OpenAI<|>OpenRouter<|>DeepSeek<|>Qwen</);
  assert.match(page, /saveMessageEdit/);
  assert.match(page, /removeMessage/);
  assert.match(page, /rerollMessage/);
  assert.match(page, /branchConversation/);
  assert.match(page, /saveConversationTitle/);
  assert.match(messageList, /다시 생성/);
  assert.match(messageList, /분기/);
});

test("branches conversations at a selected message and renames saved titles", async () => {
  const [page, messageList] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/components/MessageList.tsx", root), "utf8"),
  ]);
  assert.match(page, /conversation\.messages\.slice\(0, messageIndex \+ 1\)/);
  assert.match(page, /settings:\s*\{ \.\.\.conversation\.settings \}/);
  assert.match(page, /commitConversation\(branch\)/);
  assert.match(page, /renamingConversationId === item\.id/);
  assert.match(page, /saveConversationTitle\(item\)/);
  assert.match(page, /className="history-rename"/);
  assert.match(page, /onBranch=\{stableBranchConversation\}/);
  assert.match(messageList, /onBranch\(message\.id\)/);
});

test("keeps manually renamed titles stable after message changes", async () => {
  const [types, page] = await Promise.all([
    readFile(new URL("app/types.ts", root), "utf8"),
    readFile(new URL("app/page.tsx", root), "utf8"),
  ]);
  assert.match(types, /titleEdited:\s*boolean/);
  assert.match(page, /titleEdited:\s*false/);
  assert.match(page, /const next = \{ \.\.\.source, title, titleEdited: true \}/);
  assert.match(page, /function titleAfterMessageChange/);
  assert.match(page, /conversation\.titleEdited && currentTitle/);
  assert.match(page, /title: titleAfterMessageChange\(conversation, messages\)/);
  assert.match(page, /title: titleAfterMessageChange\(seedConversation, baseMessages\)/);
  assert.match(page, /titleEdited:\s*true,[\s\S]*?createdAt: now/);
});

test("offers conversation preset swapping in the composer", async () => {
  const page = await readFile(new URL("app/page.tsx", root), "utf8");
  assert.match(page, /const swapConversationProvider = useCallback/);
  assert.match(page, /providerPresetId: provider\.id,[\s\S]*?model: provider\.model,[\s\S]*?vision: provider\.vision/);
  assert.match(page, /className="composer-preset-select"/);
  assert.match(page, /aria-label="API 프리셋 빠른 전환"/);
  assert.match(page, /settings\.providerPresets\.map\(\(preset\)/);
});

test("enables local credential storage by default with a one-time migration", async () => {
  const [types, storage] = await Promise.all([
    readFile(new URL("app/types.ts", root), "utf8"),
    readFile(new URL("app/lib/storage.ts", root), "utf8"),
  ]);
  assert.match(types, /rememberCredentials:\s*true/);
  assert.match(storage, /CREDENTIAL_DEFAULT_MIGRATION_KEY/);
  assert.match(storage, /const rememberCredentials = applyCredentialDefault[\s\S]*?DEFAULT_SETTINGS\.rememberCredentials/);
  assert.match(storage, /localStorage\.setItem\(CREDENTIAL_DEFAULT_MIGRATION_KEY, "1"\)/);
});

test("preserves regenerated answers as selectable response variants", async () => {
  const [types, page, messageList] = await Promise.all([
    readFile(new URL("app/types.ts", root), "utf8"),
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/components/MessageList.tsx", root), "utf8"),
  ]);
  assert.match(types, /interface ResponseVariant/);
  assert.match(types, /responseVariants\?: ResponseVariant\[\]/);
  assert.match(types, /activeResponseVariantId\?: string/);
  assert.match(types, /model\?: string/);
  assert.match(types, /providerPresetName\?: string/);
  assert.match(page, /responseVariantsForReroll\(variantTarget\)/);
  assert.match(page, /const recoverableMessages = variantTarget[\s\S]*?\[\.\.\.baseMessages, variantTarget\]/);
  assert.match(page, /responseVariants:\s*\[\.\.\.\(preservedVariants \|\| \[\]\), completedVariant\]/);
  assert.match(page, /const selectResponseVariant = async/);
  assert.match(page, /applyResponseVariant\(message, variant\)/);
  assert.match(page, /function removeActiveResponseVariant/);
  assert.match(page, /variants\.filter\(\(_, index\) => index !== activeIndex\)/);
  assert.match(page, /messageWithVariantRemoved[\s\S]*?conversation\.messages\.map/);
  assert.match(page, /if \(messageIndex < conversation\.messages\.length - 1\)[\s\S]*?createConversationBranch/);
  assert.match(page, /if \(hasFollowingConversation\)[\s\S]*?createConversationBranch\(baseMessages\)/);
  assert.match(messageList, /aria-label="답변 후보 선택"/);
  assert.match(messageList, /이전 답변 후보/);
  assert.match(messageList, /다음 답변 후보/);
  assert.match(messageList, /activeVariantIndex \+ 1/);
  assert.match(messageList, /현재 답변 후보만 삭제/);
  assert.match(page, /model: responseProvider\.model/);
  assert.match(page, /providerPresetName: responseProvider\.name/);
  assert.match(page, /model: variant\.model/);
  assert.match(page, /providerPresetName: variant\.providerPresetName/);
  assert.match(messageList, /className="message-model"/);
});

test("accounts for mobile safe areas, touch targets, and keyboard zoom", async () => {
  const styles = await readFile(new URL("app/globals.css", root), "utf8");
  assert.match(styles, /height: 100vh;\s*height: 100dvh/);
  assert.match(styles, /env\(safe-area-inset-bottom\)/);
  assert.match(styles, /env\(safe-area-inset-left\)/);
  assert.match(styles, /env\(safe-area-inset-right\)/);
  assert.match(styles, /\.message-footer button \{ min-height: 34px/);
  assert.match(styles, /\.composer-tools > button,[\s\S]*?\.send-button \{ width: 40px; height: 40px/);
  assert.match(styles, /@supports \(-webkit-touch-callout: none\)[\s\S]*?font-size: 16px !important/);
});

test("supports file drag and drop through the shared attachment flow", async () => {
  const page = await readFile(new URL("app/page.tsx", root), "utf8");
  assert.match(page, /const addFiles = async/);
  assert.match(page, /onDragEnter=\{handleDragEnter\}/);
  assert.match(page, /onDragOver=\{handleDragOver\}/);
  assert.match(page, /onDragLeave=\{handleDragLeave\}/);
  assert.match(page, /onDrop=\{handleDrop\}/);
  assert.match(page, /event\.dataTransfer\.files/);
  assert.match(page, /파일을 놓아 첨부/);
});

test("uploads pasted clipboard images through the shared attachment flow", async () => {
  const page = await readFile(new URL("app/page.tsx", root), "utf8");
  assert.match(page, /const handleComposerPaste = \(event: ClipboardEvent<HTMLTextAreaElement>\)/);
  assert.match(page, /item\.type\.startsWith\("image\/"\)/);
  assert.match(page, /event\.preventDefault\(\);\s*void addFiles\(imageFiles\)/);
  assert.match(page, /onPaste=\{handleComposerPaste\}/);
});

test("binds connection and generation settings to each conversation", async () => {
  const [types, page, settings] = await Promise.all([
    readFile(new URL("app/types.ts", root), "utf8"),
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/components/SettingsPanel.tsx", root), "utf8"),
  ]);
  assert.match(types, /interface ConversationSettings/);
  assert.match(types, /settings:\s*ConversationSettings/);
  assert.match(types, /providerPresetId:\s*string/);
  assert.match(page, /normalizeConversation/);
  assert.match(page, /syncAppDefaults/);
  assert.match(page, /setSettings\(\(current\) => syncAppDefaults\(current, next\.settings\)\)/);
  assert.match(page, /settings:\s*responseSettings/);
  assert.match(page, /provider:\s*responseProvider/);
  assert.match(settings, /현재 대화 연결/);
  assert.match(settings, /conversationSettings\.model/);
  assert.match(settings, /conversationSettings\.systemPrompt/);
});

test("supports a per-conversation markdown opening message", async () => {
  const [types, page, api, planner, settings, messageList] = await Promise.all([
    readFile(new URL("app/types.ts", root), "utf8"),
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/lib/api.ts", root), "utf8"),
    readFile(new URL("app/lib/context.ts", root), "utf8"),
    readFile(new URL("app/components/SettingsPanel.tsx", root), "utf8"),
    readFile(new URL("app/components/MessageList.tsx", root), "utf8"),
  ]);
  assert.match(types, /openingMessage:\s*string/);
  assert.match(page, /openingMessage:\s*""/);
  assert.match(page, /seedConversation\.settings\.openingMessage/);
  assert.match(page, /nextSettings\.openingMessage\.trim\(\)/);
  assert.match(api, /openingMessage = ""/);
  assert.match(api, /role: "assistant", content: openingMessage\.trim\(\)/);
  assert.match(planner, /estimateTextTokens\(settings\.openingMessage\)/);
  assert.match(settings, />시작 메시지</);
  assert.match(settings, /updateConversation\("openingMessage"/);
  assert.match(messageList, /function OpeningMessage/);
  assert.match(messageList, /<MarkdownView content=\{content\} imageWidth=\{imageWidth\}/);
});

test("uses one shared image scale and renders user messages as markdown", async () => {
  const [types, page, storage, settings, markdown, messageList] = await Promise.all([
    readFile(new URL("app/types.ts", root), "utf8"),
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/lib/storage.ts", root), "utf8"),
    readFile(new URL("app/components/SettingsPanel.tsx", root), "utf8"),
    readFile(new URL("app/components/MarkdownView.tsx", root), "utf8"),
    readFile(new URL("app/components/MessageList.tsx", root), "utf8"),
  ]);
  assert.match(types, /markdownImageWidth:\s*number/);
  assert.match(types, /markdownImageWidth:\s*100/);
  assert.match(storage, /Math\.min\(100, Math\.max\(30, saved\.markdownImageWidth\)\)/);
  assert.match(settings, /마크다운 이미지 크기/);
  assert.match(settings, /update\("markdownImageWidth"/);
  assert.match(page, /imageWidth=\{settings\.markdownImageWidth\}/);
  assert.match(markdown, /imageWidth = 100/);
  assert.match(markdown, /width=\{normalizedImageWidth\}/);
  assert.doesNotMatch(markdown, /setWidth|이미지 크기<\/span>/);
  assert.doesNotMatch(messageList, /<p className="user-text">/);
  assert.match(messageList, /message\.content && <MarkdownView content=\{message\.content\} imageWidth=\{imageWidth\}/);
});

test("starts every new conversation with an empty system prompt", async () => {
  const page = await readFile(new URL("app/page.tsx", root), "utf8");
  assert.match(
    page,
    /function conversationSettingsFromApp[\s\S]*?systemPrompt:\s*""[\s\S]*?function normalizeConversation/,
  );
  assert.match(page, /seedConversation\.settings\.systemPrompt/);
});

test("isolates long message rendering from composer input updates", async () => {
  const [page, messageList, markdown] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/components/MessageList.tsx", root), "utf8"),
    readFile(new URL("app/components/MarkdownView.tsx", root), "utf8"),
  ]);
  assert.match(page, /function useEventCallback/);
  assert.match(page, /<MessageList/);
  assert.match(messageList, /memo\(function MessageItem/);
  assert.match(messageList, /memo\(function MessageList/);
  assert.match(markdown, /memo\(function MarkdownView/);
});

test("keeps the composer writable while a response is streaming", async () => {
  const page = await readFile(new URL("app/page.tsx", root), "utf8");
  const textarea = page.match(/<textarea\s+ref=\{textareaRef\}[\s\S]*?\/>/)?.[0] || "";
  assert.ok(textarea);
  assert.doesNotMatch(textarea, /disabled=\{generating\}/);
  assert.match(page, /if \(generating\) return;[\s\S]*?event\.preventDefault\(\);[\s\S]*?void send\(\)/);
  assert.match(page, /generating \? "응답 완료 후 전송 가능"/);
  assert.doesNotMatch(page, /aria-label="파일 첨부" disabled=\{generating\}/);
  assert.doesNotMatch(page, /dropEffect = generating/);
});

test("trims old request context per conversation without deleting visible history", async () => {
  const [types, page, planner, api, settings, messageList] = await Promise.all([
    readFile(new URL("app/types.ts", root), "utf8"),
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/lib/context.ts", root), "utf8"),
    readFile(new URL("app/lib/api.ts", root), "utf8"),
    readFile(new URL("app/components/SettingsPanel.tsx", root), "utf8"),
    readFile(new URL("app/components/MessageList.tsx", root), "utf8"),
  ]);
  assert.match(types, /contextLimit:\s*number/);
  assert.match(types, /historyTurns:\s*number/);
  assert.match(types, /autoTrimContext:\s*boolean/);
  assert.match(planner, /function splitIntoUserTurns/);
  assert.match(planner, /turns\.slice\(firstIncludedTurn\)\.flat\(\)/);
  assert.match(page, /planRequestContext\(baseMessages, seedConversation\.settings\)/);
  assert.match(page, /const requestContextMessages = contextPlan\.messages/);
  assert.match(page, /buildApiMessages\(\s*requestContextMessages/);
  assert.match(page, /messages:\s*\[\.\.\.baseMessages, finishedAssistant\]/);
  assert.match(settings, /토큰 한도 자동 정리/);
  assert.match(settings, /conversationSettings\.contextLimit/);
  assert.match(settings, /conversationSettings\.historyTurns/);
  assert.match(settings, /전송할 최근 대화 턴/);
  assert.match(settings, /function IntegerSettingInput/);
  assert.match(settings, /allowUnlimited && parsed === -1/);
  assert.match(settings, /onChange=\{\(event\) => setDraft\(event\.target\.value\)\}/);
  assert.doesNotMatch(settings, /Math\.max\(2048, Number\(event\.target\.value\)\)/);
  assert.match(planner, /const unlimited = settings\.contextLimit === -1/);
  assert.match(planner, /if \(unlimited \|\| !settings\.autoTrimContext\)/);
  assert.match(planner, /settings\.historyTurns === -1/);
  assert.match(planner, /allTurns\.slice\(-Math\.max\(1, Math\.floor\(settings\.historyTurns\)\)\)/);
  assert.match(api, /export class ApiRequestError extends Error/);
  assert.match(api, /const requestBytes = new TextEncoder\(\)\.encode\(serializedBody\)\.byteLength/);
  assert.match(page, /isPayloadTooLargeError\(error\)/);
  assert.doesNotMatch(page, /shrinkRequestContext|completionRequestBytes/);
  assert.match(page, /delete normalized\.requestBodyProfile/);
  assert.match(page, /aria-label="현재 대화 누적 토큰 사용량"/);
  assert.match(messageList, /이전 메시지 \{message\.contextTrim\.omittedMessages\}개 제외/);
});

test("uses an explicit recent-turn limit without adaptive 413 retry loops", async () => {
  const [page, planner, settings] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/lib/context.ts", root), "utf8"),
    readFile(new URL("app/components/SettingsPanel.tsx", root), "utf8"),
  ]);
  assert.match(planner, /const turnLimitedMessages = settings\.historyTurns === -1/);
  assert.match(planner, /reason: tokenTrimmed \? "tokens" : omittedByTurnLimit > 0 \? "turns"/);
  assert.match(settings, /1턴 = 사용자 메시지와 응답 · -1은 전체 대화/);
  assert.doesNotMatch(page, /while \(true\)|retriedPayload|reducePayloadContext/);
});

test("offers safe web search and GitHub read-only MCP presets", async () => {
  const settings = await readFile(new URL("app/components/SettingsPanel.tsx", root), "utf8");
  assert.match(settings, /const MCP_PRESETS/);
  assert.match(settings, /https:\/\/mcp\.exa\.ai\/mcp/);
  assert.match(settings, /https:\/\/api\.githubcopilot\.com\/mcp\/readonly/);
  assert.match(settings, /detail: "저장소 코드 · 파일 · README"/);
  assert.match(settings, /authType: "bearer"/);
  assert.match(settings, /https:\/\/github\.com\/settings\/personal-access-tokens\/new/);
  assert.match(settings, /credentialLabel: "GitHub 인증 토큰 발급"/);
  assert.match(settings, /className="mcp-credential-link"/);
  assert.match(settings, /target="_blank"[\s\S]*?rel="noreferrer"/);
  assert.match(settings, /MCP_PRESETS\.map\(\(preset\)/);
  assert.match(settings, /mcpUrl: preset\.url,[\s\S]*?mcpAuthType: preset\.authType,[\s\S]*?mcpToken: ""/);
});

test("keeps utility chrome minimal and makes the GitHub token link obvious", async () => {
  const [page, styles] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
  ]);
  assert.doesNotMatch(page, /LOCAL DATA/);
  assert.doesNotMatch(styles, /\.local-status/);
  assert.match(styles, /\.mcp-credential-link \{[\s\S]*?color: var\(--blue\)/);
  assert.match(styles, /\.mcp-credential-link \{[\s\S]*?text-decoration: underline/);
});

test("diagnoses reasoning-only responses without silently replacing the final body", async () => {
  const [types, api, page, messageList, settings, storage] = await Promise.all([
    readFile(new URL("app/types.ts", root), "utf8"),
    readFile(new URL("app/lib/api.ts", root), "utf8"),
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/components/MessageList.tsx", root), "utf8"),
    readFile(new URL("app/components/SettingsPanel.tsx", root), "utf8"),
    readFile(new URL("app/lib/storage.ts", root), "utf8"),
  ]);
  assert.match(types, /reasoning\?: string/);
  assert.match(types, /finishReason\?: string/);
  assert.match(types, /extraBody: string/);
  assert.match(api, /reasoning_content\?: string/);
  assert.match(api, /onReasoningDelta\?: \(delta: string\) => void/);
  assert.match(api, /reasoningField \? \{ \[reasoningField\]: reasoning \}/);
  assert.match(api, /finish_reason\?: string \| null/);
  assert.match(api, /completion_tokens_details\?: \{ reasoning_tokens\?: number \}/);
  assert.match(api, /finishReason: payload\.choices\?\.\[0\]\?\.finish_reason/);
  assert.match(page, /onReasoningDelta: \(delta\)/);
  assert.match(page, /reasoning: accumulatedReasoning \|\| undefined/);
  assert.match(page, /content: accumulated,/);
  assert.match(page, /finishReason: finishReason \|\| "unknown"/);
  assert.doesNotMatch(page, /promoteReasoningToContent/);
  assert.match(page, /const useReasoningAsContent = async/);
  assert.match(messageList, /function ReasoningBlock/);
  assert.match(messageList, /aria-expanded=\{open\}/);
  assert.match(messageList, /<span>thinking<\/span>/);
  assert.match(messageList, /<MarkdownView content=\{reasoning\}/);
  assert.match(messageList, /message\.finishReason === "length"/);
  assert.match(messageList, /thinking을 본문으로 사용/);
  assert.match(settings, /추가 요청 JSON/);
  assert.match(settings, /updateProvider\("extraBody"/);
  assert.match(storage, /extraBody: typeof preset\.extraBody === "string"/);
  assert.match(api, /const protectedFields = new Set/);
  assert.match(api, /if \(value === null\) delete body\[key\]/);
  const styles = await readFile(new URL("app/globals.css", root), "utf8");
  assert.match(styles, /\.reasoning-toggle \{[\s\S]*?appearance: none/);
  assert.match(styles, /\.reasoning-toggle \{[\s\S]*?background: transparent/);
  assert.match(styles, /\.reasoning-content \{[\s\S]*?background: var\(--panel\)/);
});

test("follows streamed output only while the viewer remains near the bottom", async () => {
  const page = await readFile(new URL("app/page.tsx", root), "utf8");
  assert.match(page, /const followOutputRef = useRef\(true\)/);
  assert.match(page, /if \(!target \|\| !followOutputRef\.current\) return/);
  assert.match(page, /scrollHeight - target\.scrollTop - target\.clientHeight/);
  assert.match(page, /followOutputRef\.current = distanceFromBottom <= 72/);
  assert.match(page, /onScroll=\{handleMessagesScroll\}/);
});

test("shows elapsed wait time and saves the sent turn before completion", async () => {
  const [page, messageList] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/components/MessageList.tsx", root), "utf8"),
  ]);
  assert.match(messageList, /function PendingResponse/);
  assert.match(messageList, /응답 대기 중/);
  assert.match(messageList, /formatElapsed\(elapsed\)/);
  assert.match(page, /const recoverableSave = saveConversation\([\s\S]*?messages: recoverableMessages[\s\S]*?false,[\s\S]*?\)\.catch/);
  assert.doesNotMatch(page, /await saveConversation\(\{ \.\.\.workingConversation, messages: baseMessages \}\)/);
  assert.match(page, /await recoverableSave;\s*await saveConversation\(finished\)/);
  assert.match(page, /messages:\s*\[\.\.\.baseMessages, finishedAssistant\]/);
});
