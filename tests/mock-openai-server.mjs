import http from "node:http";

const port = Number(process.env.MOCK_API_PORT || 18765);
const markdown = [
  "## Markdown 렌더링 확인",
  "",
  "이미지 앞 문단입니다.",
  "",
  "![본문 이미지](https://placehold.co/960x420/171a20/e7ff70?text=Simple+AI)",
  "",
  "이미지 뒤 문단입니다.",
  "",
  "```ts",
  "const compatible = true;",
  "console.log({ compatible });",
  "```",
  "",
  "| 항목 | 상태 |",
  "| --- | --- |",
  "| Markdown | 정상 |",
  "| Usage | 정상 |",
].join("\n");

const server = http.createServer((request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "authorization, content-type, http-referer, x-title");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (request.method === "OPTIONS") {
    response.writeHead(204).end();
    return;
  }
  if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
    response.writeHead(404).end("Not found");
    return;
  }

  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    const payload = JSON.parse(body || "{}");
    const lastMessage = payload.messages?.at?.(-1);
    const userText = typeof lastMessage?.content === "string" ? lastMessage.content : "";
    const toolName = payload.tools?.[0]?.function?.name;

    if (payload.stream && toolName && lastMessage?.role === "user" && userText.includes("MCP 도구 호출 테스트")) {
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      response.write(`data: ${JSON.stringify({
        id: "mock-tool",
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_mock_search",
              type: "function",
              function: {
                name: toolName,
                arguments: JSON.stringify({ query: "Model Context Protocol Streamable HTTP" }),
              },
            }],
          },
          finish_reason: null,
        }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: "mock-tool",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 18, completion_tokens: 12, total_tokens: 30 },
      })}\n\n`);
      response.end("data: [DONE]\n\n");
      return;
    }

    if (!payload.stream) {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: markdown } }],
        usage: {
          prompt_tokens: 21,
          completion_tokens: 64,
          total_tokens: 85,
          prompt_tokens_details: { cached_tokens: 8 },
        },
      }));
      return;
    }

    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const chunks = markdown.match(/.{1,70}/gs) || [];
    chunks.forEach((content, index) => {
      response.write(`data: ${JSON.stringify({
        id: "mock",
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      })}\n\n`);
      if (index === chunks.length - 1) {
        response.write(`data: ${JSON.stringify({
          id: "mock",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 21,
            completion_tokens: 64,
            total_tokens: 85,
            prompt_tokens_details: { cached_tokens: 8 },
          },
        })}\n\n`);
        response.end("data: [DONE]\n\n");
      }
    });
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Mock OpenAI API: http://127.0.0.1:${port}/v1`);
});
