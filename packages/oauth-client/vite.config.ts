import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts", "src/hono.ts", "src/testing.ts"],
    dts: { tsgo: true },
    exports: true,
  },
  test: { include: ["tests/**/*.test.ts"], testTimeout: 20_000 },
});
