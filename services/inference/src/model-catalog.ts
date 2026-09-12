import { z } from "zod";
import { DEFAULT_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS } from "./limits.ts";

export const modelInfoSchema = z.object({
  provider: z.enum(["local", "deepseek"]).optional(),
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
  "deepseek-flash": {
    name: "DeepSeek V4.1 Flash",
    provider: "deepseek",
    description:
      "Hosted DeepSeek model. Uses the separate cloud allowance; text chat through Herkules.",
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
      "Hosted DeepSeek reasoning model. Uses the separate cloud allowance; text chat through Herkules.",
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
    description: "Fast lightweight chat model. One 32K slot; tool calling is not validated.",
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
    description: "Dense general-purpose coding model with embedded MTP. One 128K slot.",
    source: "https://huggingface.co/Qwen/Qwen3.8-27B",
    context_length: 131072,
    quantization: "UD-Q4_K_M",
    tags: ["coding", "thinking", "mtp"],
    reasoning_efforts: ["low", "medium", "xhigh"],
    defaults: { temperature: 1, top_p: 0.95 },
  },
  "qwen3.6-35b-a3b": {
    name: "Qwen3.6 35B A3B",
    description: "MoE coding model. Two 128K slots; no speculative decoding.",
    source: "https://huggingface.co/Qwen/Qwen3.6-35B-A3B",
    context_length: 131072,
    quantization: "UD-IQ4_XS",
    tags: ["coding", "thinking", "moe"],
    reasoning_efforts: [],
    defaults: { temperature: 0.6, top_p: 0.95 },
  },
  "ling-3.0-tiny": {
    name: "Ling 3.0 Tiny",
    description: "Small MoE model for throughput and concurrent agents. Four 128K slots.",
    source: "https://huggingface.co/inclusionAI/Ling-3.0-tiny",
    context_length: 131072,
    quantization: "Q6_K",
    tags: ["thinking", "moe"],
    reasoning_efforts: [],
    defaults: { temperature: 1, top_p: 0.95 },
  },
  "gemma-4-12b": {
    name: "Gemma 4 12B",
    description: "General-purpose model. Two 128K slots; text-only serving.",
    source: "https://huggingface.co/google",
    context_length: 131072,
    quantization: "QAT-Q4_0",
    tags: ["general"],
    reasoning_efforts: [],
    defaults: {},
  },
  "granite-4.2-8b": {
    name: "Granite 4.2 8B",
    description: "Compact general-purpose model. One 128K slot.",
    source: "https://huggingface.co/ibm-granite",
    context_length: 131072,
    quantization: "Q6_K",
    tags: ["general"],
    reasoning_efforts: [],
    defaults: {},
  },
  "mellum2-12b": {
    name: "Mellum2 12B",
    description: "MoE coding model. Two 128K slots.",
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
          pool: info.provider === "deepseek" ? "cloud" : "local",
          ...(info.pricing ? { pricing: info.pricing } : {}),
          source: info.source,
          quantization: info.quantization,
          tags: info.tags,
          reasoning_efforts: info.reasoning_efforts,
          ...(info.provider === "deepseek"
            ? {}
            : { slots: serving.reduce((n, w) => n + (w.capacity ?? 1), 0) }),
          streaming_required: true,
          endpoints: ["/v1/chat/completions"],
          note:
            info.provider === "deepseek"
              ? "Hosted provider; uses cloud allowance. No automatic local-to-cloud fallback."
              : "Slot capacity is configured capacity, not current availability. Model swaps discard cached context.",
        },
      };
    }),
  };
}
