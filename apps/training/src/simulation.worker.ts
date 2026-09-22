import {
  createState,
  defaults,
  sampleState,
  STEP,
  stepSimulation,
  validateParameters,
  type PidParameters,
  type Sample,
} from "./simulation";
let state = createState();
let parameters = { ...defaults };
let running = false;
let history: Sample[] = [sampleState(state, parameters)];
let previous = performance.now();
let accumulator = 0;
let steps = 0;
const publish = () =>
  self.postMessage({ history, current: sampleState(state, parameters), running });
self.onmessage = (
  event: MessageEvent<{
    type: "parameters" | "running" | "reset";
    parameters?: PidParameters;
    running?: boolean;
  }>,
) => {
  try {
    const message = event.data;
    if (message.type === "parameters" && message.parameters) {
      validateParameters(message.parameters);
      parameters = { ...message.parameters };
    } else if (message.type === "running") {
      running = message.running === true;
      previous = performance.now();
    } else if (message.type === "reset") {
      state = createState();
      accumulator = 0;
      steps = 0;
      history = [sampleState(state, parameters)];
      previous = performance.now();
    }
    publish();
  } catch {
    self.postMessage({ error: "参数无效，请重试。" });
  }
};
setInterval(() => {
  const now = performance.now();
  // Do not fast-forward through time spent in a suspended/background tab.
  if (running) accumulator += Math.min((now - previous) / 1000, 0.1);
  previous = now;
  if (!running) return;
  while (accumulator >= STEP) {
    stepSimulation(state, parameters);
    accumulator -= STEP;
    if (++steps % 4 === 0) history.push(sampleState(state, parameters));
  }
  if (history.length > 601) history.splice(0, history.length - 601);
  publish();
}, 1000 / 30);
