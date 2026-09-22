<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { playgroundUrl, rustExample } from "../../../../src/playground";
import type { EditorView } from "@codemirror/view";
const code = ref(rustExample);
const editorElement = ref<HTMLDivElement>();
const ready = ref(false);
const error = ref("");
const url = computed(() => playgroundUrl(code.value));
let view: EditorView | undefined;
let disposed = false;
function reset() {
  if (view) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: rustExample } });
  else code.value = rustExample;
}
onMounted(async () => {
  try {
    const [{ EditorView: View, basicSetup }, { rust }, { oneDark }] = await Promise.all([
      import("codemirror"),
      import("@codemirror/lang-rust"),
      import("@codemirror/theme-one-dark"),
    ]);
    if (disposed || !editorElement.value) return;
    view = new View({
      doc: code.value,
      parent: editorElement.value,
      extensions: [
        basicSetup,
        rust(),
        oneDark,
        View.lineWrapping,
        View.contentAttributes.of({ "aria-label": "Rust 源代码编辑器" }),
        View.updateListener.of((update) => {
          if (update.docChanged) code.value = update.state.doc.toString();
        }),
        View.theme({
          "&": { fontSize: "14px", background: "#171e1c", color: "#e2e8e6" },
          ".cm-gutters": {
            background: "#202825",
            color: "#9aaca5",
            border: "none",
          },
          ".cm-scroller": { fontFamily: "var(--vp-font-family-mono)" },
          ".cm-content": { caretColor: "#e2e8e6" },
          ".cm-activeLine": { background: "#18a58112" },
        }),
      ],
    });
    ready.value = true;
  } catch {
    error.value = "编辑器未能加载。你仍可编辑下方代码并在 Playground 中运行。";
  }
});
onBeforeUnmount(() => {
  disposed = true;
  view?.destroy();
});
</script>
<template>
  <section class="lab" aria-label="Rust 控制器实验">
    <div class="lab-toolbar">
      <span class="lab-caption">实验 02 / controller.rs</span
      ><button class="lab-button" @click="reset">恢复示例</button>
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
    <textarea
      v-if="!ready"
      v-model="code"
      class="rust-fallback"
      aria-label="Rust 源代码"
      spellcheck="false"
    />
    <div ref="editorElement" class="rust-editor"></div>
    <div class="lab-toolbar lab-actions">
      <span class="lab-note"
        >在新标签页打开官方 Rust Playground，然后点击 Run 或 Test。代码会随链接发送。</span
      >
      <a class="lab-button primary" :href="url" target="_blank" rel="noopener noreferrer"
        >在 Playground 中运行 ↗</a
      >
    </div>
  </section>
</template>
