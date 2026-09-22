import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { bounds } from "../simulation.ts";
import { createBridge } from "./bridge.ts";
const bridge = await createBridge(Number(process.env.TRAINING_BRIDGE_PORT ?? 3014));
const server = new McpServer({ name: "herkules-pid-tuning", version: "0.1.0" });
const number = (key: keyof typeof bounds) =>
  z.number().min(bounds[key].min).max(bounds[key].max).optional();
const parameters = z
  .object({
    kp: number("kp"),
    ki: number("ki"),
    kd: number("kd"),
    limit: number("limit"),
    yaw: number("yaw"),
    pitch: number("pitch"),
    antiWindup: z.boolean().optional(),
  })
  .strict();
const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});
server.registerTool(
  "connect_lab",
  {
    description:
      "Get the local pairing URL. Ask the user to paste it into the lab Agent panel and connect. One browser tab per bridge.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  },
  () => result({ url: bridge.url, lab: "http://127.0.0.1:3004/labs/pid" }),
);
server.registerTool(
  "read_lab",
  {
    description:
      "Read live parameters, limits, actual angles, torque, running state and up to 12 seconds of measured history. Throws if disconnected or stale.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  },
  () => result(bridge.read()),
);
server.registerTool(
  "set_parameters",
  {
    description:
      "Patch tuning gains or targets, preserving motion, integral state and history. Returns browser-confirmed state. Gains are shared by both axes; targets are degrees, torque N m.",
    inputSchema: parameters,
  },
  async (patch) => result(await bridge.command({ type: "parameters", patch })),
);
server.registerTool(
  "set_running",
  {
    description: "Pause or resume without resetting state.",
    inputSchema: z.object({ running: z.boolean() }),
  },
  async ({ running }) => result(await bridge.command({ type: "running", running })),
);
server.registerTool(
  "reset_lab",
  {
    description:
      "Explicitly clear motion, integral state, elapsed time and history; retain parameters and running state. Use only when a fresh experiment is requested.",
    inputSchema: z.object({}),
  },
  async () => result(await bridge.command({ type: "reset" })),
);
await server.connect(new StdioServerTransport());
process.stdin.on("end", () => {
  void bridge.close().then(() => server.close());
});
