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
