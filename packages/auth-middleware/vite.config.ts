import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts", "src/hono.ts", "src/mcp.ts", "src/testing.ts", "src/userinfo.ts"],
    dts: { tsgo: true },
    exports: true,
  },
  lint: { options: { typeAware: true, typeCheck: true } },
  fmt: {},
});
