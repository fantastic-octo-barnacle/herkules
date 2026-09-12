import { expect, test } from "vite-plus/test";
import { FreeRateLimit, freeRequest } from "../src/openrouter.ts";

test("free limits apply across models and users, with a rolling minute", () => {
  const limit = new FreeRateLimit();
  for (let user = 1; user <= 3; user++) {
    for (let n = 0; n < 6; n++) limit.acquire(user, 1000);
    expect(() => limit.acquire(user, 1000)).toThrow("free_model_rate_limit");
  }
  expect(() => limit.acquire(4, 1000)).toThrow("free_model_rate_limit");
  expect(() => limit.acquire(4, 61000)).not.toThrow();
});

test("caller cannot supply paid fallback models, plugins or routing", () => {
  const result = freeRequest({
    model: "google/gemma-4-31b-it:free",
    messages: [],
    models: ["paid/model"],
    plugins: [{ id: "web" }],
    provider: { max_price: { prompt: 100 } },
    tools: [{ type: "function" }],
    stream: true,
  });
  expect(result.models).toBeUndefined();
  expect(result.plugins).toBeUndefined();
  expect(result.provider).toEqual({
    max_price: { prompt: 0, completion: 0 },
    allow_fallbacks: false,
  });
  expect(result.tools).toEqual([{ type: "function" }]);
});
