import { defineConfig } from "vite-plus";

/** Nothing is built here: the apps' Vite consume `src/` directly. This file only configures `vp check`. */
export default defineConfig({
  lint: { options: { typeAware: true, typeCheck: true } },
  fmt: {},
});
