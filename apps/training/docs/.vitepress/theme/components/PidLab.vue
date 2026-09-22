<script setup lang="ts">
import { onMounted, onBeforeUnmount, reactive, ref, watch } from "vue";
import { defaults, presets, type Sample } from "../../../../src/simulation";
import GimbalView from "./GimbalView.vue";
import type uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

const playing = ref(true);
const current = ref<Sample>({
  time: 0,
  yaw: 0,
  pitch: 0,
  pitchTarget: defaults.pitch,
  yawTarget: defaults.yaw,
  output: 0,
});
function togglePlayback() {
  playing.value = !playing.value;
  worker?.postMessage({ type: "running", running: playing.value });
}
const parameters = reactive({ ...defaults });
const error = ref("");
const pending = ref(true);
const chartElement = ref<HTMLDivElement>();
const controls = [
  { key: "kp", label: "比例 Kp", max: 40, min: 0, step: 0.5 },
  { key: "ki", label: "积分 Ki", max: 20, min: 0, step: 0.5 },
  { key: "kd", label: "微分 Kd", max: 15, min: 0, step: 0.5 },
  { key: "limit", label: "力矩限幅 / N·m", max: 30, min: 1, step: 1 },
] as const;
let worker: Worker | undefined;
let chart: uPlot | undefined;
let observer: ResizeObserver | undefined;
let disposed = false;
const reset = () => worker?.postMessage({ type: "reset" });
const request = () => worker?.postMessage({ type: "parameters", parameters: { ...parameters } });
watch(parameters, request);
onMounted(async () => {
  try {
    const { default: UPlot } = await import("uplot");
    if (disposed || !chartElement.value) return;
    const element = chartElement.value;
    chart = new UPlot(
      {
        width: Math.max(240, element.clientWidth),
        height: 320,
        cursor: { drag: { x: false, y: false } },
        scales: { x: { time: false }, output: { auto: true } },
        axes: [
          { stroke: "#82928e", label: "时间 / s", grid: { stroke: "#82928e22" } },
          { stroke: "#82928e", grid: { stroke: "#82928e22" } },
          { scale: "output", side: 1, stroke: "#b77b32", grid: { show: false } },
        ],
        series: [
          { label: "时间" },
          { label: "俯仰目标 / °", stroke: "#82928e", dash: [6, 5], width: 1.5 },
          { label: "俯仰 / °", stroke: "#18a581", width: 2.5 },
          { label: "偏航目标 / °", stroke: "#7d91ca", dash: [6, 5], width: 1 },
          { label: "偏航 / °", stroke: "#7d91ca", width: 2 },
          { label: "俯仰力矩 / N·m（右轴）", scale: "output", stroke: "#b77b32", width: 1.5 },
        ],
      },
      [[], [], [], [], [], []],
      element,
    );
    observer = new ResizeObserver(() =>
      chart?.setSize({ width: Math.max(240, element.clientWidth), height: 320 }),
    );
    observer.observe(element);
    worker = new Worker(new URL("../../../../src/simulation.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (
      event: MessageEvent<{ history?: Sample[]; current?: Sample; error?: string }>,
    ) => {
      pending.value = false;
      error.value = event.data.error ?? "";
      if (event.data.current) current.value = event.data.current;
      if (event.data.history) {
        const rows = event.data.history;
        chart?.setData([
          rows.map((v) => v.time),
          rows.map((v) => v.pitchTarget),
          rows.map((v) => v.pitch),
          rows.map((v) => v.yawTarget),
          rows.map((v) => v.yaw),
          rows.map((v) => v.output),
        ]);
        const end = Math.max(12, current.value.time);
        chart?.setScale("x", { min: Math.max(0, end - 12), max: end });
      }
    };
    worker.onerror = () => {
      error.value = "实验加载失败，请刷新页面重试。";
      pending.value = false;
    };
    request();
    worker.postMessage({ type: "running", running: playing.value });
  } catch {
    error.value = "实验加载失败，请刷新页面重试。";
    pending.value = false;
  }
});
onBeforeUnmount(() => {
  disposed = true;
  worker?.terminate();
  observer?.disconnect();
  chart?.destroy();
});
</script>

<template>
  <section class="lab" aria-label="PID 交互实验" :aria-busy="pending">
    <div class="lab-toolbar">
      <span class="lab-caption">实验 01 / 实时控制</span>
      <button class="lab-button" @click="Object.assign(parameters, defaults)">恢复默认参数</button>
    </div>
    <div class="lab-presets" aria-label="参数预设">
      <button class="lab-button" @click="Object.assign(parameters, presets.gentle)">
        仅比例 + 阻尼
      </button>
      <button class="lab-button" @click="Object.assign(parameters, presets.oscillating)">
        观察振荡
      </button>
      <button class="lab-button" @click="Object.assign(parameters, presets.damped)">
        加入微分
      </button>
    </div>
    <div class="lab-controls">
      <label v-for="control in controls" :key="control.key" class="lab-control">
        <span
          >{{ control.label }} <output>{{ parameters[control.key].toFixed(1) }}</output></span
        >
        <input
          v-model.number="parameters[control.key]"
          type="range"
          :min="control.min"
          :max="control.max"
          :step="control.step"
        />
      </label>
      <label class="lab-checkbox"
        ><input v-model="parameters.antiWindup" type="checkbox" /> 抗积分饱和</label
      >
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
    <div class="gimbal-panel">
      <GimbalView
        :yaw="current.yaw"
        :pitch="current.pitch"
        :target-yaw="parameters.yaw"
        :target-pitch="parameters.pitch"
      />
      <div class="gimbal-controls">
        <p><strong>双轴云台 / 3D 姿态</strong></p>
        <label class="lab-control"
          >偏航目标 {{ parameters.yaw }}°<input
            v-model.number="parameters.yaw"
            type="range"
            min="-90"
            max="90"
            step="5"
        /></label>
        <label class="lab-control"
          >俯仰目标 {{ parameters.pitch }}°<input
            v-model.number="parameters.pitch"
            type="range"
            min="-60"
            max="60"
            step="5"
        /></label>
        <div class="lab-presets">
          <button class="lab-button" :aria-pressed="playing" @click="togglePlayback">
            {{ playing ? "暂停" : "继续" }}
          </button>
          <button class="lab-button" @click="reset">重置状态与曲线</button>
        </div>
        <p class="lab-note">
          {{ playing ? "实时运行" : "已暂停" }} · {{ current.time.toFixed(1) }} s
        </p>
      </div>
    </div>
    <p class="lab-note">
      俯仰轴承受重力，偏航轴绕竖直方向旋转。两轴分别计算
      PID，共用上方增益。调整参数或目标会立即生效，保留当前姿态、速度与积分状态。
    </p>
    <div
      ref="chartElement"
      class="lab-chart"
      role="img"
      aria-label="最近 12 秒的目标、角度和控制力矩曲线。下方提供当前读数。"
    ></div>
    <dl class="lab-metrics">
      <div>
        <dt>当前俯仰误差 / °</dt>
        <dd>{{ (current.pitchTarget - current.pitch).toFixed(2) }}</dd>
      </div>
      <div>
        <dt>当前偏航误差 / °</dt>
        <dd>{{ (current.yawTarget - current.yaw).toFixed(2) }}</dd>
      </div>
      <div>
        <dt>俯仰力矩 / N·m</dt>
        <dd>{{ current.output.toFixed(2) }}</dd>
      </div>
    </dl>
    <p class="lab-note">
      重力从起点持续作用。绿色为俯仰，蓝色为偏航，虚线为各轴目标；橙色为俯仰电机力矩（右轴）。曲线保留最近
      12 秒，仿真持续运行；后台节流时放慢仿真，不跳过运动。
    </p>
  </section>
</template>
