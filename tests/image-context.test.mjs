import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./load-ts.mjs";

const { DEFAULT_SETTINGS, DEFAULT_PROVIDER_PRESET, resolveProviderModel } = loadTs("app/types.ts");
const provider = { ...resolveProviderModel(DEFAULT_PROVIDER_PRESET), baseUrl: "https://api.example.com/v1",
  model: "custom-vision", connectionMode: "direct" };
const limitError = "Streaming response failed: [400] At most 4 image(s) may be provided in one prompt. (parameter=image)";
const image = (index) => ({ type: "image_url", image_url: { url: `data:image/webp;base64,${index}` } });
const history = () => [
  { role: "system", content: "system" },
  ...Array.from({ length: 6 }, (_, index) => [
    { role: "user", content: [{ type: "text", text: `question ${index}` }, image(index)] },
    { role: "assistant", content: `analysis ${index}` },
  ]).flat(),
  { role: "user", content: [{ type: "text", text: "current" }, image(6)] },
];

function success(api) {
  if (api === "responses") return { status: "completed", output: [
    { type: "message", content: [{ type: "output_text", text: "ok" }] },
  ] };
  if (api === "messages") return { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] };
  return { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] };
}

test("image-count errors recover on the same endpoint in JSON and all three stream formats", async () => {
  for (const api of ["chat/completions", "responses", "messages"]) {
    for (const streamed of [false, true]) {
      const requests = [];
      let cancelled = false;
      let retries = 0;
      const { requestCompletion } = loadTs("app/lib/api.ts", { fetch: async (url, init) => {
        requests.push({ url, body: JSON.parse(init.body) });
        if (requests.length > 1) return Response.json(success(api));
        if (!streamed) return Response.json({ error: { message: limitError } }, { status: 400 });
        return new Response(new ReadableStream({
          start(controller) {
            const event = api === "responses"
              ? { type: "response.failed", response: { error: { message: limitError } } }
              : { type: "error", error: { message: limitError } };
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
            // response.failed is finalized after EOF in the Responses parser.
            if (api === "responses") controller.close();
          },
          cancel() { cancelled = true; },
        }), { headers: { "Content-Type": "text/event-stream" } });
      } });
      const messages = history();
      const original = structuredClone(messages);
      const options = { provider: { ...provider, baseUrl: `https://api.example.com/v1/${api}` },
        settings: { ...DEFAULT_SETTINGS, stream: streamed }, messages, onRetry: () => { retries += 1; } };
      assert.equal((await requestCompletion(options)).content, "ok");
      assert.equal(requests.length, 2);
      assert.equal(requests[0].url, requests[1].url);
      assert.equal(retries, 1);
      if (streamed && api !== "responses") assert.equal(cancelled, true);
      const body = JSON.stringify(requests[1].body);
      const count = (body.match(/"type":"(?:image_url|input_image|image)"/g) || []).length;
      assert.equal(count, 4);
      assert.match(body, /analysis 0/);
      assert.match(body, /question 0/);
      assert.match(body, /원본 제외/);
      assert.doesNotMatch(body, /base64,0/);
      assert.deepEqual(messages, original);
      await requestCompletion(options);
      assert.equal(requests.length, 3);
      assert.deepEqual(requests[2].body, requests[1].body);
    }
  }
});

test("history reduction preserves every current image, tool exchanges, order and source objects", () => {
  const { limitHistoryImages, imageCount } = loadTs("app/lib/image-context.ts");
  const messages = history();
  messages.at(-1).content.push(image(7));
  messages.push({ role: "assistant", content: "", tool_calls: [{ id: "t1" }] },
    { role: "tool", tool_call_id: "t1", content: "lookup result" });
  const before = structuredClone(messages);
  const limited = limitHistoryImages(messages, 4);
  assert.equal(imageCount(limited), 4);
  assert.deepEqual(limited.at(-3), messages.at(-3));
  assert.deepEqual(limited.slice(-2), messages.slice(-2));
  assert.deepEqual(messages, before);
  const retained = limited.flatMap((m) => Array.isArray(m.content) ? m.content : [])
    .filter((part) => part.type === "image_url").map((part) => part.image_url.url);
  assert.deepEqual(retained, [4, 5, 6, 7].map((index) => image(index).image_url.url));
  assert.throws(() => limitHistoryImages(messages, 1), /현재 첨부 이미지 2장/);
});

test("unrelated image errors never cause image removal; repeated count errors stop", async () => {
  const { imageLimitFromError } = loadTs("app/lib/image-context.ts");
  for (const message of ["At most 4 MB per image", "Maximum image size: 4096 pixels",
    "image decode failed", "maximum 4 tokens", "Maximum images: 0"]) {
    assert.equal(imageLimitFromError(new Error(message)), undefined, message);
  }
  for (const message of [limitError, "Maximum number of images is 4", "image limit: 4"]) {
    assert.equal(imageLimitFromError(new Error(message)), 4);
  }
  let calls = 0;
  const { requestCompletion } = loadTs("app/lib/api.ts", { fetch: async () => {
    calls += 1;
    return Response.json({ error: { message: limitError } }, { status: 400 });
  } });
  await assert.rejects(requestCompletion({ provider, settings: DEFAULT_SETTINGS, messages: history() }), /At most 4/);
  assert.equal(calls, 2);
});

test("model switches do not inherit another model's limit and cancellation prevents image retries", async () => {
  const bodies = [];
  const abort = new AbortController();
  const { requestCompletion } = loadTs("app/lib/api.ts", { fetch: async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    if (bodies.length === 1) return Response.json({ error: { message: limitError } }, { status: 400 });
    return Response.json(success("chat/completions"));
  } });
  const options = { provider, settings: DEFAULT_SETTINGS, messages: history() };
  await requestCompletion(options);
  await requestCompletion({ ...options, provider: { ...provider, model: "other-model" } });
  assert.equal((JSON.stringify(bodies[2]).match(/"type":"image_url"/g) || []).length, 7);
  const cancelled = loadTs("app/lib/api.ts", { fetch: async () => {
    abort.abort();
    return Response.json({ error: { message: limitError } }, { status: 400 });
  } });
  await assert.rejects(cancelled.requestCompletion({ ...options, signal: abort.signal }), { name: "AbortError" });
});
