import { simulate, type PidParameters } from "./simulation";
self.onmessage = (event: MessageEvent<{ id: number; parameters: PidParameters }>) => {
  try {
    self.postMessage({ id: event.data.id, result: simulate(event.data.parameters) });
  } catch {
    self.postMessage({ id: event.data.id, error: "参数无效，请重置后重试。" });
  }
};
