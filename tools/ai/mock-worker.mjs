import { createServer } from "node:http";
const key = process.env.AI_MOCK_KEY;
if (!key) throw new Error("AI_MOCK_KEY is required");
createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${key}`) {
    res.writeHead(401);
    res.end();
    return;
  }
  if (req.url === "/healthz") {
    res.writeHead(200);
    res.end('{"ready":true}');
    return;
  }
  if (req.url !== "/v1/chat/completions") {
    res.writeHead(404);
    res.end();
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const data = JSON.parse(Buffer.concat(chunks).toString());
  const promptTokens = Math.ceil(JSON.stringify(data.messages).length / 4);
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
  res.flushHeaders();
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 1000);
  const timer = setTimeout(
    () => {
      clearInterval(heartbeat);
      const common = {
        id: "chatcmpl-local-test",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: data.model,
      };
      res.write(
        `data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: "assistant", content: "Hello from the local test worker." }, finish_reason: null }] })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: promptTokens, completion_tokens: 8, total_tokens: promptTokens + 8 } })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    },
    Number(process.env.AI_MOCK_DELAY_MS ?? 1500),
  );
  res.on("close", () => {
    clearInterval(heartbeat);
    clearTimeout(timer);
  });
}).listen(4015, "127.0.0.1", () => console.log("Local mock worker ready"));
