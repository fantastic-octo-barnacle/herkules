import { describe, expect, it } from "vite-plus/test";
import { defaults, presets, simulate } from "../src/simulation";
import { playgroundUrl } from "../src/playground";

describe("PID lab", () => {
  it("is deterministic and respects the actuator limit", () => {
    const parameters = { ...defaults, limit: 2, disturbance: -3 };
    const result = simulate(parameters);
    expect(result).toEqual(simulate(parameters));
    expect(result.time).toHaveLength(601);
    expect(result.time.at(-1)).toBe(12);
    expect(result.output.every((v) => Math.abs(v) <= 2)).toBe(true);
    expect(result.position.every(Number.isFinite)).toBe(true);
  });
  it("cannot move an undisturbed plant without control effort", () => {
    const result = simulate({ ...defaults, kp: 0, ki: 0, kd: 0 });
    expect(result.position.every((v) => v === 0)).toBe(true);
    expect(result.settlingTime).toBeNull();
  });
  it("derivative damping reduces overshoot", () => {
    const oscillating = simulate({ ...defaults, ...presets.oscillating });
    const damped = simulate(defaults);
    expect(damped.overshoot).toBeLessThan(oscillating.overshoot);
    expect(Math.abs(damped.finalError)).toBeLessThan(0.02);
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
