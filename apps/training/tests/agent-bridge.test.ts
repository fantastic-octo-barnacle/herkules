import { describe, it, expect } from "vite-plus/test";
import { WebSocket } from "ws";
import { once } from "node:events";
import { createBridge } from "../src/agent/bridge";

describe("local agent bridge", () => {
  it("requires pairing and origin, returns browser-confirmed writes, and rejects disconnection", async () => {
    const bridge = await createBridge(0);
    let browser: WebSocket | undefined;
    try {
      expect(() => bridge.read()).toThrow("No fresh");
      const denied = new WebSocket(bridge.url, { origin: "https://untrusted.example" });
      const [failure] = await once(denied, "error");
      expect(String(failure)).toContain("403");
      const badToken = new WebSocket(bridge.url.replace(/token=.*/, "token=invalid"), {
        origin: "http://127.0.0.1:3004",
      });
      expect(String((await once(badToken, "error"))[0])).toContain("403");
      browser = new WebSocket(bridge.url, { origin: "http://127.0.0.1:3004" });
      await once(browser, "open");
      browser.send(JSON.stringify({ type: "snapshot", snapshot: { time: 42 } }));
      await expect
        .poll(() => {
          try {
            return bridge.read();
          } catch {
            return null;
          }
        })
        .toEqual({ time: 42 });
      const received = once(browser, "message");
      const write = bridge.command({ type: "parameters", patch: { kp: 100 } });
      const [raw] = await received;
      const command = JSON.parse(String(raw)) as { id: string; command: unknown };
      expect(command.command).toEqual({ type: "parameters", patch: { kp: 100 } });
      browser.send(
        JSON.stringify({ type: "reply", id: command.id, snapshot: { time: 43, kp: 100 } }),
      );
      await expect(write).resolves.toEqual({ time: 43, kp: 100 });
      const inFlight = bridge.command({ type: "reset" });
      const rejected = expect(inFlight).rejects.toThrow("outcome unknown");
      browser.close();
      await rejected;
      expect(() => bridge.read()).toThrow("No fresh");
    } finally {
      browser?.terminate();
      await bridge.close();
    }
  });
});
