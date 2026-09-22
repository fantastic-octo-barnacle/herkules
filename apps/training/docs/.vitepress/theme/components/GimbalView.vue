<script setup lang="ts">
import { computed } from "vue";
const props = defineProps<{ yaw: number; pitch: number; targetYaw: number; targetPitch: number }>();
type Point = [number, number, number];
type Face = { points: Point[]; color: string };
const radians = (angle: number) => (angle * Math.PI) / 180;
function rotate([x, y, z]: Point, yaw: number, pitch = 0): Point {
  const p = radians(pitch),
    a = radians(yaw);
  const py = y * Math.cos(p) + z * Math.sin(p);
  const pz = -y * Math.sin(p) + z * Math.cos(p);
  return [x * Math.cos(a) + pz * Math.sin(a), py, -x * Math.sin(a) + pz * Math.cos(a)];
}
// Orthographic camera looking down toward the rotating assembly.
function camera([x, y, z]: Point): Point {
  const side = x * 0.8 - z * 0.6;
  const depth = x * 0.6 + z * 0.8;
  return [side, y * 0.88 - depth * 0.475, y * 0.475 + depth * 0.88];
}
function project(point: Point): string {
  const [x, y] = camera(point);
  return `${250 + x * 78},${258 - y * 78}`;
}
const yawAngle = computed(() => props.yaw);
const pitchAngle = computed(() => props.pitch);
function transform(point: Point, yaw: number, pitch = 0, height = 0): Point {
  const p = rotate(point, 0, pitch);
  p[1] += height;
  return rotate(p, yaw);
}
function box(min: Point, max: Point, colors: string[]): Face[] {
  const [a, b, c] = min,
    [x, y, z] = max;
  const vertices: Point[] = [
    [a, b, c],
    [x, b, c],
    [x, y, c],
    [a, y, c],
    [a, b, z],
    [x, b, z],
    [x, y, z],
    [a, y, z],
  ];
  return [
    [0, 1, 2, 3],
    [4, 7, 6, 5],
    [0, 4, 5, 1],
    [3, 2, 6, 7],
    [0, 3, 7, 4],
    [1, 5, 6, 2],
  ].map((indices, i) => ({
    points: indices.map((index) => vertices[index]!),
    color: colors[i % colors.length]!,
  }));
}
const faces = computed(() => {
  const blue = ["#4869a3", "#678bca", "#354d78", "#a3bff0", "#587db7", "#82a4da"];
  const green = ["#26765e", "#409e7d", "#215b4b", "#77d4ab", "#348e6e", "#56b992"];
  const result: Face[] = [];
  const add = (min: Point, max: Point, colors: string[], pitch = 0, height = 0) =>
    result.push(
      ...box(min, max, colors).map((face) => ({
        ...face,
        points: face.points.map((p) => transform(p, props.yaw, pitch, height)),
      })),
    );
  // Vertical yaw post with a pitch arm hinged at its top.
  add([-0.07, 0, -0.07], [0.07, 1.45, 0.07], blue);
  add([-0.07, -0.07, 0], [0.07, 0.07, 1.6], green, props.pitch, 1.45);
  return result
    .map((face) => ({
      ...face,
      depth: face.points.reduce((sum, p) => sum + camera(p)[2], 0) / face.points.length,
    }))
    .sort((a, b) => a.depth - b.depth);
});
const target = computed(() => [
  transform([0, 0, 1.35], props.targetYaw, props.targetPitch, 1.45),
  transform([0, 0, 1.8], props.targetYaw, props.targetPitch, 1.45),
]);
const gravityPoint = computed(() => {
  const point = transform([0, 0, 0.8], props.yaw, props.pitch, 1.45);
  const [x, y] = camera(point);
  return { x: 250 + x * 78, y: 258 - y * 78 };
});
</script>

<template>
  <svg
    class="gimbal-view"
    viewBox="0 0 500 390"
    role="img"
    :aria-label="`双轴云台：偏航 ${yawAngle.toFixed(1)} 度，俯仰 ${pitchAngle.toFixed(1)} 度`"
  >
    <title>两根杆：蓝色竖杆表示偏航，绿色杆表示俯仰，红色箭头表示重力</title>
    <g fill="none" stroke="currentColor" opacity=".08">
      <polyline
        v-for="offset in [-2, -1, 0, 1, 2]"
        :key="`x${offset}`"
        :points="[project([offset, -0.02, -2]), project([offset, -0.02, 2])].join(' ')"
      />
      <polyline
        v-for="offset in [-2, -1, 0, 1, 2]"
        :key="`z${offset}`"
        :points="[project([-2, -0.02, offset]), project([2, -0.02, offset])].join(' ')"
      />
    </g>
    <g stroke="#20392e" stroke-width=".6" stroke-linejoin="round">
      <polygon
        v-for="(face, index) in faces"
        :key="index"
        :points="face.points.map(project).join(' ')"
        :fill="face.color"
      />
    </g>
    <g fill="none" stroke="#d3a757" stroke-width="1.5" opacity=".9">
      <polyline :points="target.map(project).join(' ')" stroke-dasharray="4 5" />
      <circle
        :cx="Number(project(target[1]!).split(',')[0])"
        :cy="Number(project(target[1]!).split(',')[1])"
        r="6"
      />
    </g>
    <g stroke="#e07765" fill="#e07765" stroke-width="2">
      <line
        :x1="gravityPoint.x"
        :y1="gravityPoint.y"
        :x2="gravityPoint.x"
        :y2="gravityPoint.y + 45"
      />
      <path
        :d="`M ${gravityPoint.x - 4} ${gravityPoint.y + 38} L ${gravityPoint.x} ${gravityPoint.y + 45} L ${gravityPoint.x + 4} ${gravityPoint.y + 38}`"
        fill="none"
      />
      <text :x="gravityPoint.x + 8" :y="gravityPoint.y + 35" stroke="none" font-size="13">mg</text>
    </g>
    <text x="22" y="30" fill="currentColor" font-size="13" letter-spacing="1">
      YAW {{ yawAngle.toFixed(1) }}° · PITCH {{ pitchAngle.toFixed(1) }}°
    </text>
    <text x="22" y="370" fill="currentColor" font-size="12" opacity=".65">
      蓝色：偏航 · 绿色：俯仰 · 红色：重力
    </text>
  </svg>
</template>
