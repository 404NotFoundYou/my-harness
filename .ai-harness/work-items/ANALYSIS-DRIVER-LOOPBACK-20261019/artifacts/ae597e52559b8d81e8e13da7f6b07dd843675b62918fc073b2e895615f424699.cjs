const fs = require("node:fs");
const http = require("node:http");
const { createHash } = require("node:crypto");

const mode = process.env.FIXTURE_MODE;
if (!["success", "timeout"].includes(mode)) throw new Error("Invalid fixture mode");
const observation = "/output/provider-observation.json";
let count = 0;
const server = http.createServer(async (request, response) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) { response.writeHead(413).end(); return; }
    chunks.push(chunk);
  }
  if (request.method !== "POST" || request.url !== "/v1/responses") { response.writeHead(404).end(); return; }
  const body = Buffer.concat(chunks);
  const payload = JSON.parse(body.toString("utf8"));
  count++;
  fs.writeFileSync(observation, JSON.stringify({ mode, count, requestSha256: createHash("sha256").update(body).digest("hex"),
    authorizationHeaderPresent: Boolean(request.headers.authorization), model: payload.model ?? null }) + "\n");
  if (mode === "timeout") return;
  const id = `fixed-${count}`;
  const text = JSON.stringify({ completed: true, summary: "fixed local response", tests: [] });
  const events = [
    { type: "response.created", response: { id } },
    { type: "response.output_item.done", item: { type: "message", role: "assistant", id: `message-${count}`, content: [{ type: "output_text", text }] } },
    { type: "response.completed", response: { id, usage: { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 } } },
  ];
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "close" });
  for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
});
server.listen(37555, "127.0.0.1", () => fs.writeFileSync("/tmp/fixed-response-ready", "ready\n"));
