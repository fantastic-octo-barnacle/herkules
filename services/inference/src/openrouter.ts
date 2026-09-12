import { AdmissionError } from "./queue.ts";

export const freeModels = [
  "google/gemma-4-26b-a4b-it:free",
  "google/gemma-4-31b-it:free",
  "poolside/laguna-s-2.1:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
];

export const freeProviderPolicy = {
  max_price: { prompt: 0, completion: 0 },
  allow_fallbacks: false,
  data_collection: "deny",
} as const;

// One gateway process. OpenRouter owns the durable account-wide daily ceiling.
export class FreeRateLimit {
  private requests: { user: number; time: number }[] = [];
  acquire(user: number, now = Date.now()) {
    this.requests = this.requests.filter((r) => now - r.time < 60_000);
    if (this.requests.length >= 18 || this.requests.filter((r) => r.user === user).length >= 6)
      throw new AdmissionError("free_model_rate_limit", 429);
    this.requests.push({ user, time: now });
  }
}

// Never forward caller-selected routing, fallbacks, plugins, or paid tools.
export function freeRequest(input: Record<string, unknown>) {
  const allowed = [
    "model",
    "messages",
    "stream",
    "stream_options",
    "max_tokens",
    "temperature",
    "top_p",
    "top_k",
    "stop",
    "seed",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "response_format",
    "frequency_penalty",
    "presence_penalty",
    "reasoning",
  ];
  const result = Object.fromEntries(
    allowed.filter((k) => input[k] !== undefined).map((k) => [k, input[k]]),
  );
  result.provider = freeProviderPolicy;
  return result;
}
