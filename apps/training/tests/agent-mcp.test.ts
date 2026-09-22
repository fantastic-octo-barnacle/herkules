import { it, expect } from "vite-plus/test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { WebSocket } from "ws";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

it("serves real MCP tools over stdio and round-trips acknowledged commands", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/agent/main.ts", import.meta.url))],
    env: { ...(process.env as Record<string, string>), TRAINING_BRIDGE_PORT: "0" },
    stderr: "pipe",
  });
  const client = new Client({ name: "training-test", version: "1" });
  let browser: WebSocket | undefined;
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("set_parameters");
    const pairing = await client.callTool({ name: "connect_lab", arguments: {} });
    const content = pairing.content as { text: string }[];
    const { url } = JSON.parse(content[0]!.text) as { url: string };
    browser = new WebSocket(url, { origin: "http://127.0.0.1:3004" });
    await once(browser, "open");
    browser.send(JSON.stringify({ type: "snapshot", snapshot: { current: { time: 10 } } }));
    await expect
      .poll(async () => (await client.callTool({ name: "read_lab", arguments: {} })).isError)
      .not.toBe(true);
    browser.on("message", (raw) => {
      const message = JSON.parse(
        (Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer)).toString(),
      ) as { id: string; command: unknown };
      browser!.send(
        JSON.stringify({ type: "reply", id: message.id, snapshot: { applied: message.command } }),
      );
    });
    const updated = await client.callTool({
      name: "set_parameters",
      arguments: { kp: 400, limit: 300 },
    });
    expect(updated.isError).not.toBe(true);
    expect(JSON.stringify(updated.content)).toContain("400");
    const invalid = await client.callTool({ name: "set_parameters", arguments: { kp: 401 } });
    expect(invalid.isError).toBe(true);
  } finally {
    browser?.terminate();
    await client.close();
    await transport.close();
  }
});
