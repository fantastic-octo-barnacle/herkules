import { defineConfig } from "vitepress";

export default defineConfig({
  lang: "zh-CN",
  title: "Herkules Training",
  description: "从实验理解控制，从代码理解机器人。Herkules 交互式课程与实验。",
  cleanUrls: true,
  outDir: "../dist",
  cacheDir: "../node_modules/.cache/training",
  sitemap: { hostname: "https://training.herkules.dev" },
  head: [["meta", { name: "theme-color", content: "#147d64" }]],
  themeConfig: {
    siteTitle: "Herkules / Training",
    nav: [
      { text: "课程", link: "/guide/getting-started" },
      { text: "实验", link: "/labs/pid" },
      { text: "Herkules", link: "https://herkules.dev" },
    ],
    sidebar: [
      { text: "从这里开始", items: [{ text: "课程与实验", link: "/guide/getting-started" }] },
      {
        text: "交互实验",
        items: [
          { text: "01 · PID 调参", link: "/labs/pid" },
          { text: "02 · Rust 控制器", link: "/labs/rust" },
          { text: "Agent 调参", link: "/guide/agent-tuning" },
        ],
      },
    ],
    search: { provider: "local" },
    outline: { label: "本页内容", level: [2, 3] },
    docFooter: { prev: "上一课", next: "下一课" },
    sidebarMenuLabel: "课程目录",
    returnToTopLabel: "回到顶部",
    darkModeSwitchLabel: "切换主题",
    footer: { message: "Herkules · 在实验中理解机器人" },
  },
});
