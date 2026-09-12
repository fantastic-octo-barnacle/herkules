import { expect, test, vi } from "vite-plus/test";
import { catalogSchema, enrichModels, modelCatalog } from "../src/model-catalog.ts";
import { NewAPI } from "../src/new-api.ts";
import type { Config } from "../src/config.ts";

test("metadata preserves the authorized list and exposes only serving capabilities", () => {
  const result = enrichModels(
    {
      object: "list",
      data: [{ id: "qwen3.8-27b", object: "model", owned_by: "org" }, { id: "unknown" }],
    },
    modelCatalog,
    [{ model: "qwen3.8-27b", capacity: 1 }],
  ) as { data: Record<string, unknown>[] };
  expect(result.data).toHaveLength(2);
  expect(result.data[0]).toMatchObject({
    id: "qwen3.8-27b",
    object: "model",
    owned_by: "org",
    context_length: 131072,
    architecture: { input_modalities: ["text"] },
    default_parameters: { temperature: 1 },
    herkules: { slots: 1, streaming_required: true },
  });
  expect(result.data[0]).not.toHaveProperty("pricing");
  expect(result.data[1]).toEqual({ id: "unknown" });
  expect(enrichModels({ data: [] }, modelCatalog, [{ model: "qwen3.8-27b" }])).toEqual({
    data: [],
  });
});
test("catalog rejects impossible limits", () => {
  expect(catalogSchema.safeParse(modelCatalog).success).toBe(true);
  expect(
    catalogSchema.safeParse({ bad: { ...modelCatalog["qwen3.8-27b"], context_length: -1 } })
      .success,
  ).toBe(false);
});
test("New API seeding preserves operator records and skips unserved models", async () => {
  const api = new NewAPI("http://new-api", "unused");
  const call = vi
    .spyOn(api, "call")
    .mockResolvedValueOnce({ items: [{ model_name: "qwen3.8-27b" }], total: 1 })
    .mockResolvedValue(undefined);
  await api.seedModelMetadata({
    workers: [{ model: "qwen3.8-27b" }, { model: "ling-3.0-tiny" }],
    modelCatalog,
  } as Config);
  expect(call).toHaveBeenCalledTimes(2);
  expect(call).toHaveBeenLastCalledWith(
    "/api/models/",
    "POST",
    expect.objectContaining({ model_name: "ling-3.0-tiny", sync_official: 0, status: 1 }),
  );
});

test("DeepSeek publishes cloud prices and gateway limits without claiming GPU slots", () => {
  const result = enrichModels({ data: [{ id: "deepseek-flash" }] }, modelCatalog, [
    { model: "deepseek-flash" },
  ]) as { data: Record<string, unknown>[] };
  expect(result.data[0]).toMatchObject({
    context_length: 1000000,
    top_provider: { max_completion_tokens: 65536 },
    herkules: {
      pool: "cloud",
      pricing: {
        input: 0.3,
        cached_input: 0.006,
        output: 1.2,
        currency: "USD",
        per_tokens: 1000000,
      },
    },
  });
  expect(result.data[0].herkules).not.toHaveProperty("slots");
});

test("cloud provisioning fails closed when backend pool isolation is absent", async () => {
  const api = new NewAPI("http://new-api", "unused");
  vi.spyOn(api, "login").mockResolvedValue(undefined);
  const call = vi
    .spyOn(api, "call")
    .mockResolvedValueOnce({ status: true })
    .mockResolvedValueOnce({});
  await expect(api.bootstrap({ AI_PLANS_ENABLED: "true" } as Config)).rejects.toThrow(
    "pool isolation",
  );
  expect(call).toHaveBeenCalledTimes(2);
  expect(call).toHaveBeenLastCalledWith("/api/status");
});

test("free model descriptions and prices match the enabled allowlist", async () => {
  const { freeModels } = await import("../src/openrouter.ts");
  expect(freeModels).not.toContain("thinkingmachines/inkling:free");
  expect([...freeModels].sort()).toEqual(
    [
      "google/gemma-4-26b-a4b-it:free",
      "google/gemma-4-31b-it:free",
      "poolside/laguna-s-2.1:free",
      "nvidia/nemotron-3-super-120b-a12b:free",
    ].sort(),
  );
  for (const model of freeModels) {
    const result = enrichModels({ data: [{ id: model }] }, modelCatalog, [{ model }]) as {
      data: { description: string; herkules: Record<string, unknown> }[];
    };
    expect(result.data[0].description.length).toBeGreaterThan(40);
    expect(result.data[0].herkules).toMatchObject({
      pool: "free",
      pricing: { input: 0, output: 0 },
    });
    expect(result.data[0].herkules).not.toHaveProperty("slots");
  }
});

test("existing portal descriptions refresh without changing visibility or operator fields", async () => {
  const api = new NewAPI("http://new-api", "unused");
  const existing = {
    id: 7,
    model_name: "qwen3.8-27b",
    description: "Old description",
    status: 0,
    icon: "custom",
    tags: "operator-tags",
    endpoints: "{}",
    sync_official: 0,
    name_rule: 0,
  };
  const call = vi
    .spyOn(api, "call")
    .mockResolvedValueOnce({ items: [existing], total: 1 })
    .mockResolvedValue(undefined);
  await api.seedModelMetadata({
    workers: [{ model: existing.model_name }],
    modelCatalog,
  } as Config);
  expect(call).toHaveBeenLastCalledWith("/api/models/", "PUT", {
    ...existing,
    description: modelCatalog[existing.model_name].description,
  });
});

test("DeepSeek bootstrap fills missing rates and preserves operator overrides across restarts", async () => {
  const api = new NewAPI("http://new-api", "unused");
  vi.spyOn(api, "login").mockResolvedValue(undefined);
  vi.spyOn(api, "seedModelMetadata").mockResolvedValue(undefined);
  const options = new Map([
    ["ModelRatio", JSON.stringify({ "deepseek-flash": 0.7, custom: 9 })],
    ["CompletionRatio", JSON.stringify({ "deepseek-flash": 5 })],
    ["CacheRatio", JSON.stringify({ "deepseek-flash": 0 })],
  ]);
  vi.spyOn(api, "call").mockImplementation(async (path, method, body) => {
    if (path === "/api/setup") return { status: true };
    if (path === "/api/status")
      return { herkules_pools: { enabled: true, deepseek_flash: true, deepseek_pro: true } };
    if (path === "/api/option/") {
      if (method === "PUT") {
        const { key, value } = body as { key: string; value: string };
        options.set(key, value);
        return;
      }
      return [...options].map(([key, value]) => ({ key, value }));
    }
    if (path === "/api/custom-oauth-provider/") return [];
    if (path.startsWith("/api/channel/?")) return { items: [] };
    return;
  });
  const config = {
    workers: [],
    AI_PLANS_ENABLED: "true",
    deepseekKey: "fixture",
  } as unknown as Config;
  await api.bootstrap(config);
  await api.bootstrap(config);
  expect(JSON.parse(options.get("ModelRatio")!)).toMatchObject({
    "deepseek-flash": 0.7,
    "deepseek-v4-pro": 1.32,
    custom: 9,
  });
  expect(JSON.parse(options.get("CompletionRatio")!)).toMatchObject({
    "deepseek-flash": 5,
    "deepseek-v4-pro": 3,
  });
  expect(JSON.parse(options.get("CacheRatio")!)).toMatchObject({
    "deepseek-flash": 0,
    "deepseek-v4-pro": 1 / 30,
  });
});

test("OpenRouter channel enforces free pricing and privacy after New API request conversion", async () => {
  const api = new NewAPI("http://new-api", "unused");
  vi.spyOn(api, "login").mockResolvedValue(undefined);
  vi.spyOn(api, "seedModelMetadata").mockResolvedValue(undefined);
  const call = vi.spyOn(api, "call").mockImplementation(async (path) => {
    if (path === "/api/setup") return { status: true };
    if (path === "/api/option/" || path === "/api/custom-oauth-provider/") return [];
    if (path.startsWith("/api/channel/?")) return { items: [] };
    return;
  });
  await api.bootstrap({ workers: [], openrouterKey: "fixture" } as unknown as Config);
  const bodies = call.mock.calls
    .filter(([path, method]) => path === "/api/channel/" && method === "POST")
    .map(([, , body]) => body as { channel: { name: string; param_override: string } });
  const channel = bodies.find((b) => b.channel.name === "herkules-openrouter-free")!.channel;
  expect(JSON.parse(channel.param_override)).toEqual({
    provider: {
      max_price: { prompt: 0, completion: 0 },
      allow_fallbacks: false,
      data_collection: "deny",
    },
  });
});
