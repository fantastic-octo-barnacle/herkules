import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import PidLab from "./components/PidLab.vue";
import RustLab from "./components/RustLab.vue";
import "./style.css";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("PidLab", PidLab);
    app.component("RustLab", RustLab);
  },
} satisfies Theme;
