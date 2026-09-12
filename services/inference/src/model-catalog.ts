import { z } from "zod";
import { DEFAULT_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS } from "./limits.ts";

export const modelInfoSchema = z.object({
  provider: z.enum(["local", "deepseek", "openrouter"]).optional(),
  pricing: z
    .object({
      input: z.number(),
      cached_input: z.number(),
      output: z.number(),
      currency: z.literal("USD"),
      per_tokens: z.literal(1000000),
      basis: z.string(),
    })
    .optional(),
  name: z.string().min(1),
  description: z.string(),
  source: z.string().url(),
  context_length: z.number().int().min(2),
  quantization: z.string(),
  tags: z.array(z.string()),
  reasoning_efforts: z.array(z.string()).default([]),
  tools: z.boolean().optional(),
  defaults: z
    .object({
      temperature: z.number().min(0).max(2).optional(),
      top_p: z.number().min(0).max(1).optional(),
    })
    .default({}),
});
export const catalogSchema = z.record(z.string(), modelInfoSchema);
export type ModelCatalog = z.infer<typeof catalogSchema>;

// Serving limits, not the upstream weights' maximum capabilities. Only text
// and chat completions are enabled by this gateway, even for multimodal weights.
export const modelCatalog: ModelCatalog = {
  ...Object.fromEntries(
    ["26b-a4b", "31b"].map((size) => [
      `google/gemma-4-${size}-it:free`,
      {
        name: `Gemma 4 ${size.toUpperCase()} (free)`,
        provider: "openrouter" as const,
        description:
          "General-purpose hosted chat and tool calling. Coding accuracy and sustained speed are unmeasured here. Free endpoint with shared rate limits and variable availability.",
        source: `https://openrouter.ai/google/gemma-4-${size}-it:free`,
        context_length: 262144,
        quantization: "provider-managed",
        tags: ["free", "hosted"],
        reasoning_efforts: [],
        defaults: {},
        pricing: {
          input: 0,
          cached_input: 0,
          output: 0,
          currency: "USD" as const,
          per_tokens: 1000000 as const,
          basis: "Free endpoint",
        },
      },
    ]),
  ),
  "poolside/laguna-s-2.1:free": {
    name: "Laguna S 2.1 (free)",
    provider: "openrouter",
    description:
      "Coding and tool-calling candidate. Our initial request was rate-limited upstream; quality and speed are unverified. Free hosted endpoint with shared rate limits and variable availability.",
    source: "https://openrouter.ai/poolside/laguna-s-2.1:free",
    context_length: 262144,
    quantization: "provider-managed",
    tags: ["free", "hosted"],
    reasoning_efforts: [],
    defaults: {},
    pricing: {
      input: 0,
      cached_input: 0,
      output: 0,
      currency: "USD",
      per_tokens: 1000000,
      basis: "Free endpoint",
    },
  },
  "nvidia/nemotron-3-super-120b-a12b:free": {
    name: "Nemotron 3 Super (free)",
    provider: "openrouter",
    description:
      "Reasoning and tool-calling candidate. Passed a short JSON arithmetic and deduplication check at zero cost; coding accuracy and sustained speed are unmeasured. Free hosted endpoint with shared rate limits and variable availability.",
    source: "https://openrouter.ai/nvidia/nemotron-3-super-120b-a12b:free",
    context_length: 262144,
    quantization: "provider-managed",
    tags: ["free", "hosted"],
    reasoning_efforts: [],
    defaults: {},
    pricing: {
      input: 0,
      cached_input: 0,
      output: 0,
      currency: "USD",
      per_tokens: 1000000,
      basis: "Free endpoint",
    },
  },
  "thinkingmachines/inkling:free": {
    name: "Inkling (free)",
    provider: "openrouter",
    description:
      "Disabled: OpenRouter rejected our smoke test because this endpoint requires an approved agentic application. Quality, speed and advertised context are unverified. Free hosted endpoint with shared rate limits and variable availability.",
    source: "https://openrouter.ai/thinkingmachines/inkling:free",
    context_length: 1048576,
    quantization: "provider-managed",
    tags: ["free", "hosted"],
    reasoning_efforts: [],
    defaults: {},
    pricing: {
      input: 0,
      cached_input: 0,
      output: 0,
      currency: "USD",
      per_tokens: 1000000,
      basis: "Free endpoint",
    },
  },
  "deepseek-flash": {
    name: "DeepSeek V4.1 Flash",
    provider: "deepseek",
    description:
      "Lower-cost hosted DeepSeek option for coding and general chat. Uses cloud credits. A basic request is verified; comparative coding accuracy and speed have not been measured here.",
    source: "https://api-docs.deepseek.com/quick_start/pricing/",
    context_length: 1_000_000,
    quantization: "provider-managed",
    tags: ["cloud", "thinking", "coding"],
    reasoning_efforts: [],
    defaults: {},
    pricing: {
      input: 0.3,
      cached_input: 0.006,
      output: 1.2,
      currency: "USD",
      per_tokens: 1000000,
      basis:
        "Peak-rate credit accounting; provider off-peak rates are 50% lower. Verified 2026-09-12.",
    },
  },
  "deepseek-v4-pro": {
    name: "DeepSeek V4 Pro 0813",
    provider: "deepseek",
    description:
      "Hosted DeepSeek reasoning option for complex tasks. More expensive than Flash and uses cloud credits. Comparative accuracy and speed have not been measured here.",
    source: "https://api-docs.deepseek.com/quick_start/pricing/",
    context_length: 1_000_000,
    quantization: "provider-managed",
    tags: ["cloud", "thinking", "coding"],
    reasoning_efforts: [],
    defaults: {},
    pricing: {
      input: 1.32,
      cached_input: 0.044,
      output: 3.96,
      currency: "USD",
      per_tokens: 1000000,
      basis:
        "Peak-rate credit accounting; provider off-peak rates are 50% lower. Verified 2026-09-12.",
    },
  },
  "lfm2.5-1.2b": {
    name: "LFM2.5 1.2B",
    description:
      "Fast casual chat and short completions: approximately 770 tokens/s in our short native decode test. Coding quality and tool calling are unvalidated. One 32K slot.",
    source: "https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct",
    context_length: 32768,
    quantization: "Q4_0",
    tags: ["fast-chat"],
    reasoning_efforts: [],
    tools: false,
    defaults: { temperature: 0.1 },
  },
  "qwen3.8-27b": {
    name: "Qwen3.8 27B",
    description:
      "Our strongest tested local coding model: 25/30 on our Aider Polyglot subset at low reasoning effort. Around 76 tokens/s in short-context single-stream tests; long prompts slow decoding. One 128K slot with MTP.",
    source: "https://huggingface.co/Qwen/Qwen3.8-27B",
    context_length: 131072,
    quantization: "UD-Q4_K_M",
    tags: ["coding", "thinking", "mtp"],
    reasoning_efforts: ["low", "medium", "xhigh"],
    defaults: { temperature: 1, top_p: 0.95 },
  },
  "qwen3.6-35b-a3b": {
    name: "Qwen3.6 35B A3B",
    description:
      "MoE coding model with two 128K slots. Repetition occurred in our coding benchmark; suitability depends on sampling and workload. Reliable comparative accuracy and speed are not yet established.",
    source: "https://huggingface.co/Qwen/Qwen3.6-35B-A3B",
    context_length: 131072,
    quantization: "UD-IQ4_XS",
    tags: ["coding", "thinking", "moe"],
    reasoning_efforts: [],
    defaults: { temperature: 0.6, top_p: 0.95 },
  },
  "ling-3.0-tiny": {
    name: "Ling 3.0 Tiny",
    description:
      "Small MoE with four 128K slots. Our coding run stopped after repetition and 0/5 completed tasks passed. Experimental for chat; not recommended for unattended coding.",
    source: "https://huggingface.co/inclusionAI/Ling-3.0-tiny",
    context_length: 131072,
    quantization: "Q6_K",
    tags: ["thinking", "moe"],
    reasoning_efforts: [],
    defaults: { temperature: 1, top_p: 0.95 },
  },
  "gemma-4-12b": {
    name: "Gemma 4 12B",
    description:
      "General-purpose text chat with two 128K slots. Approximately 83–94 tokens/s in our coding run; 2/6 completed tasks passed before stopping. The partial run is not a full benchmark score.",
    source: "https://huggingface.co/google",
    context_length: 131072,
    quantization: "QAT-Q4_0",
    tags: ["general"],
    reasoning_efforts: [],
    defaults: {},
  },
  "granite-4.2-8b": {
    name: "Granite 4.2 8B",
    description:
      "Compact general-purpose model with one 128K slot. Approximately 95–108 tokens/s in early coding measurements. Coding evaluation is incomplete; no established accuracy score.",
    source: "https://huggingface.co/ibm-granite",
    context_length: 131072,
    quantization: "Q6_K",
    tags: ["general"],
    reasoning_efforts: [],
    defaults: {},
  },
  "mellum2-12b": {
    name: "Mellum2 12B",
    description:
      "Fast MoE coding experiment, approximately 166–248 tokens/s in our runs. Failed all three tasks in a six-attempt repair probe. Two 128K slots; not recommended for unattended coding.",
    source: "https://huggingface.co/JetBrains",
    context_length: 131072,
    quantization: "Q8_0",
    tags: ["coding", "moe"],
    reasoning_efforts: [],
    defaults: {},
  },
};

export function outputLimits(info?: ModelCatalog[string]) {
  const max = info ? Math.min(MAX_OUTPUT_TOKENS, info.context_length - 1) : MAX_OUTPUT_TOKENS;
  // Leave room for a prompt on smaller deployments instead of reserving the whole context.
  const defaultTokens = info
    ? Math.min(DEFAULT_OUTPUT_TOKENS, Math.floor(info.context_length / 2), max)
    : DEFAULT_OUTPUT_TOKENS;
  return { max, defaultTokens };
}

export function enrichModels(
  value: unknown,
  catalog: ModelCatalog,
  workers: { model: string; capacity?: number }[],
) {
  if (!value || typeof value !== "object" || !("data" in value) || !Array.isArray(value.data))
    return value;
  return {
    ...value,
    data: value.data.map((entry: unknown) => {
      if (!entry || typeof entry !== "object" || !("id" in entry) || typeof entry.id !== "string")
        return entry;
      const info = catalog[entry.id];
      const serving = workers.filter((w) => w.model === entry.id);
      if (!info || !serving.length) return entry;
      return {
        ...entry,
        name: info.name,
        description: info.description,
        context_length: info.context_length,
        architecture: {
          input_modalities: ["text"],
          output_modalities: ["text"],
          modality: "text->text",
        },
        supported_parameters: [
          "max_tokens",
          "temperature",
          "top_p",
          ...(info.tools === false ? [] : ["tools", "tool_choice"]),
          "stream",
          ...(info.reasoning_efforts.length ? ["reasoning_effort"] : []),
        ],
        default_parameters: { ...info.defaults, max_tokens: outputLimits(info).defaultTokens },
        top_provider: {
          context_length: info.context_length,
          max_completion_tokens: outputLimits(info).max,
        },
        // Credits are not USD. Do not put them in OpenRouter's monetary pricing fields.
        herkules: {
          schema_version: 1,
          pool:
            info.provider === "openrouter"
              ? "free"
              : info.provider === "deepseek"
                ? "cloud"
                : "local",
          ...(info.pricing ? { pricing: info.pricing } : {}),
          source: info.source,
          quantization: info.quantization,
          tags: info.tags,
          reasoning_efforts: info.reasoning_efforts,
          ...(info.provider && info.provider !== "local"
            ? {}
            : { slots: serving.reduce((n, w) => n + (w.capacity ?? 1), 0) }),
          streaming_required: true,
          endpoints: ["/v1/chat/completions"],
          note:
            info.provider && info.provider !== "local"
              ? info.provider === "openrouter"
                ? "Free hosted provider; shared request limits. No paid fallback."
                : "Hosted provider; uses cloud allowance. No automatic local-to-cloud fallback."
              : "Slot capacity is configured capacity, not current availability. Model swaps discard cached context.",
        },
      };
    }),
  };
}
