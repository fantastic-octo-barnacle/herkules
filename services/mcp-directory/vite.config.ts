import { defineConfig } from "vite-plus";

export default defineConfig({
  // A service, not a library: one entry, no dts, bundled for the container image.
  pack: {
    entry: ["src/main.ts"],
    platform: "node",
  },
  test: {
    // In-process: the middleware's test issuer, or the real auth service on PGlite. No network.
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
  },
  lint: { options: { typeAware: true, typeCheck: true } },
  fmt: {},
});
