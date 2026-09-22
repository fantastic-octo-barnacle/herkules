<script setup lang="ts">
import { onMounted, onBeforeUnmount, reactive, ref, watch } from "vue";
import { defaults, presets, type Simulation } from "../../../../src/simulation";
import type uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

const parameters = reactive({ ...defaults });
const result = ref<Simulation>();
const error = ref("");
const pending = ref(true);
const chartElement = ref<HTMLDivElement>();
const controls = [
  { key: "kp", label: "比例 Kp", max: 40, min: 0, step: 0.5 },
  { key: "ki", label: "积分 Ki", max: 20, min: 0, step: 0.5 },
  { key: "kd", label: "微分 Kd", max: 15, min: 0, step: 0.5 },
  { key: "limit", label: "输出限幅", max: 30, min: 1, step: 1 },
  { key: "disturbance", label: "6 秒时加入负载", max: 5, min: -5, step: 0.5 },
] as const;
let worker: Worker | undefined;
let chart: uPlot | undefined;
let observer: ResizeObserver | undefined;
let requestId = 0;
let disposed = false;
const reset = () => Object.assign(parameters, defaults);
const request = () => {
  if (!worker) return;
  pending.value = true;
  worker.postMessage({ id: ++requestId, parameters: { ...parameters } });
};
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
        scales: { x: { time: false }, output: { auto: true } },
        axes: [
          { stroke: "#82928e", label: "时间 / s", grid: { stroke: "#82928e22" } },
          { stroke: "#82928e", grid: { stroke: "#82928e22" } },
          { scale: "output", side: 1, stroke: "#b77b32", grid: { show: false } },
        ],
        series: [
          { label: "时间" },
          { label: "目标", stroke: "#82928e", dash: [6, 5], width: 1.5 },
          { label: "位置", stroke: "#18a581", width: 2.5 },
          { label: "输出（右轴）", scale: "output", stroke: "#b77b32", width: 1.5 },
        ],
      },
      [[], [], [], []],
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
      event: MessageEvent<{ id: number; result?: Simulation; error?: string }>,
    ) => {
      if (event.data.id !== requestId) return;
      pending.value = false;
      error.value = event.data.error ?? "";
      if (event.data.result) {
        const data = event.data.result;
        result.value = data;
        chart?.setData([data.time, data.target, data.position, data.output]);
      }
    };
    worker.onerror = () => {
      error.value = "实验加载失败，请刷新页面重试。";
      pending.value = false;
    };
    request();
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
      <span class="lab-caption">实验 01 / 阶跃响应</span>
      <button class="lab-button" @click="reset">重置参数</button>
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
    <div
      ref="chartElement"
      class="lab-chart"
      role="img"
      aria-label="0 到 12 秒的目标、位置和控制输出曲线。下方提供数值摘要。"
    ></div>
    <dl v-if="result" class="lab-metrics" aria-live="polite">
      <div>
        <dt>超调量</dt>
        <dd>{{ result.overshoot.toFixed(1) }}<small> %</small></dd>
      </div>
      <div>
        <dt>12 秒时误差</dt>
        <dd>{{ result.finalError.toFixed(3) }}</dd>
      </div>
      <div>
        <dt>进入 ±2% 区间</dt>
        <dd>
          {{ result.settlingTime === null ? "尚未稳定" : `${result.settlingTime.toFixed(2)} s` }}
        </dd>
      </div>
    </dl>
    <p class="lab-note">
      目标位置为 1。曲线显示完整 12 秒实验；调整参数会重新计算，不依赖页面帧率。橙色输出使用右轴。
    </p>
  </section>
</template>
