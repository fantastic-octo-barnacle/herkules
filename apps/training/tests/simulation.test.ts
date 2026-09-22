import { describe, expect, it } from "vite-plus/test";
import { defaults, presets, simulate, createState, stepSimulation } from "../src/simulation";
import { playgroundUrl } from "../src/playground";

describe("PID lab", () => {
  it("is deterministic and respects the actuator limit", () => {
    const parameters = { ...defaults, limit: 2 };
    const result = simulate(parameters);
    expect(result).toEqual(simulate(parameters));
    expect(result.time).toHaveLength(601);
    expect(result.time.at(-1)).toBe(12);
    expect(result.output.every((v) => Math.abs(v) <= 2)).toBe(true);
    expect(result.position.every(Number.isFinite)).toBe(true);
  });
  it("falls under gravity without pitch control while yaw stays still", () => {
    const result = simulate({ ...defaults, kp: 0, ki: 0, kd: 0 });
    expect(result.position[1]).toBeLessThan(0);
    expect(result.yaw.every((v) => v === 0)).toBe(true);
    expect(result.settlingTime).toBeNull();
  });
  it("derivative damping reduces overshoot", () => {
    const oscillating = simulate({ ...defaults, ...presets.oscillating });
    const damped = simulate(defaults);
    expect(damped.overshoot).toBeLessThan(oscillating.overshoot);
    expect(Math.abs(damped.finalError)).toBeLessThan(1);
  });
  it("integral control reduces the gravity-induced pitch error", () => {
    const proportional = simulate({ ...defaults, ki: 0 });
    expect(Math.abs(proportional.finalError)).toBeGreaterThan(5);
    expect(Math.abs(simulate(defaults).finalError)).toBeLessThan(Math.abs(proportional.finalError));
  });
  it("target angles drive independent axes", () => {
    const baseline = simulate(defaults);
    const changed = simulate({ ...defaults, yaw: -30 });
    expect(changed.position).toEqual(baseline.position);
    expect(changed.yaw.at(-1)).toBeLessThan(-29);
    const horizontal = simulate({ ...defaults, pitch: 0 });
    expect(horizontal.position[1]).toBeLessThan(0);
    expect(horizontal.output.at(-1)).toBeGreaterThan(2);
  });
  it("rejects nonfinite or unbounded inputs", () => {
    expect(() => simulate({ ...defaults, kp: NaN })).toThrow();
    expect(() => simulate({ ...defaults, ki: 1000 })).toThrow();
  });
});
it("encodes source without allowing it to change the playground destination", () => {
  const code = 'println!("你好 & # ? +");';
  const url = new URL(playgroundUrl(code));
  expect(url.origin).toBe("https://play.rust-lang.org");
  expect(url.searchParams.get("code")).toBe(code);
  expect(url.searchParams.get("edition")).toBe("2024");
});

it("continues from existing motion and integral state when tuning changes", () => {
  const state = createState();
  for (let i = 0; i < 400; i++) stepSimulation(state, defaults);
  const before = structuredClone(state);
  stepSimulation(state, { ...defaults, pitch: -30, yaw: -60, kp: 6 });
  expect(state.time).toBeCloseTo(before.time + 0.005);
  expect(Math.abs(state.pitch.position - before.pitch.position)).toBeLessThan(0.01);
  expect(Math.abs(state.yaw.position - before.yaw.position)).toBeLessThan(0.01);
  expect(Math.abs(state.pitch.integral - before.pitch.integral)).toBeLessThan(0.02);
  expect(state.pitch.integral).not.toBe(0);
});
it("runs beyond the history window without a duration cutoff", () => {
  const state = createState();
  for (let i = 0; i < 12000; i++) stepSimulation(state, defaults);
  expect(state.time).toBeCloseTo(60);
  expect(Number.isFinite(state.pitch.position)).toBe(true);
  expect((state.pitch.position * 180) / Math.PI).toBeCloseTo(defaults.pitch, 1);
});

it("keeps the expanded gain and torque envelope finite", () => {
  for (const pitch of [-180, 180]) {
    const parameters = { ...defaults, kp: 400, ki: 200, kd: 100, limit: 300, yaw: 360, pitch };
    const result = simulate(parameters);
    expect(result.position.every(Number.isFinite)).toBe(true);
    expect(result.yaw.every(Number.isFinite)).toBe(true);
    expect(result.output.every((value) => Math.abs(value) <= 300)).toBe(true);
  }
});
