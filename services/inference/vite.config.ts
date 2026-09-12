import { defineConfig } from "vite-plus";
export default defineConfig({
  pack: { entry: ["src/main.ts", "src/worker.ts"], platform: "node" },
  test: { include: ["tests/**/*.test.ts"] },
});
