<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
const props = defineProps<{ snapshot: unknown }>();
const emit = defineEmits<{ command: [id: string, command: unknown] }>();
const url = ref("");
const status = ref("未连接");
const connected = ref(false);
let socket: WebSocket | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
function disconnect() {
  clearInterval(timer);
  socket?.close();
  socket = undefined;
  connected.value = false;
  status.value = "未连接";
}
function connect() {
  disconnect();
  try {
    const endpoint = new URL(url.value);
    if (
      endpoint.protocol !== "ws:" ||
      endpoint.hostname !== "127.0.0.1" ||
      endpoint.pathname !== "/lab" ||
      !/^[a-f0-9]{48}$/.test(endpoint.searchParams.get("token") ?? "")
    )
      throw new Error("请使用 connect_lab 返回的本地配对地址。");
    const ws = new WebSocket(endpoint);
    socket = ws;
    status.value = "连接中…";
    ws.onopen = () => {
      if (socket !== ws) return;
      connected.value = true;
      status.value = "Agent 已连接，可读取与调整此实验";
      const publish = () => {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: "snapshot", snapshot: props.snapshot }));
      };
      publish();
      timer = setInterval(publish, 250);
    };
    ws.onmessage = (event) => {
      if (socket !== ws) return;
      try {
        const message = JSON.parse(String(event.data)) as {
          type?: string;
          id?: string;
          command?: unknown;
        };
        if (message.type === "command" && typeof message.id === "string")
          emit("command", message.id, message.command);
      } catch {
        status.value = "收到无效消息";
      }
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      clearInterval(timer);
      connected.value = false;
      status.value = "连接已关闭";
    };
    ws.onerror = () => {
      if (socket === ws)
        status.value =
          "连接失败；请确认本地 bridge 正在运行。线上页面若阻止本地连接，请使用本地预览。";
    };
  } catch (error) {
    status.value = error instanceof Error ? error.message : "连接失败";
  }
}
function reply(id: string, error?: string) {
  if (socket?.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify({ type: "reply", id, error, snapshot: props.snapshot }));
}
defineExpose({ reply });
onBeforeUnmount(disconnect);
</script>
<template>
  <details class="agent-panel">
    <summary>Agent 调参 · 本地 MCP</summary>
    <p>
      在 MCP 客户端启动 training agent bridge，调用 connect_lab，将返回地址粘贴到这里。连接后 Agent
      可读取曲线、修改参数、暂停或重置当前实验。
    </p>
    <label class="lab-control"
      >本地配对地址<input
        v-model="url"
        type="password"
        autocomplete="off"
        placeholder="ws://127.0.0.1:3014/lab?token=…"
        :disabled="connected"
    /></label>
    <div class="lab-presets">
      <button class="lab-button" :disabled="connected" @click="connect">连接 Agent</button
      ><button class="lab-button" :disabled="!connected" @click="disconnect">断开连接</button>
    </div>
    <p role="status">{{ status }}</p>
    <a href="/guide/agent-tuning">配置 MCP 与调参 Skill →</a>
  </details>
</template>
