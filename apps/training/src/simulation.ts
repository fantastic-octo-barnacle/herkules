/** Educational second-order plant. Fixed integration step, independent of rendering. */
export interface PidParameters {
  kp: number;
  ki: number;
  kd: number;
  limit: number;
  yaw: number;
  pitch: number;
  antiWindup: boolean;
}
export interface Simulation {
  time: number[];
  target: number[];
  position: number[];
  output: number[];
  yaw: number[];
  yawTarget: number[];
  overshoot: number;
  finalError: number;
  settlingTime: number | null;
}
export const defaults: PidParameters = {
  kp: 12,
  ki: 4,
  kd: 5,
  limit: 20,
  yaw: 60,
  pitch: 30,
  antiWindup: true,
};
export const presets: Record<string, Pick<PidParameters, "kp" | "ki" | "kd">> = {
  gentle: { kp: 4, ki: 0, kd: 2 },
  oscillating: { kp: 30, ki: 8, kd: 0 },
  damped: { kp: 12, ki: 4, kd: 5 },
};
const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));

export function validateParameters(params: PidParameters): void {
  for (const key of ["kp", "ki", "kd", "limit", "yaw", "pitch"] as const) {
    if (!Number.isFinite(params[key])) throw new Error(`Invalid ${key}`);
  }
  if (
    params.kp < 0 ||
    params.kp > 40 ||
    params.ki < 0 ||
    params.ki > 20 ||
    params.kd < 0 ||
    params.kd > 15 ||
    params.limit < 1 ||
    params.limit > 30 ||
    Math.abs(params.yaw) > 90 ||
    Math.abs(params.pitch) > 60
  )
    throw new Error("Parameters outside lab bounds");
}

export const STEP = 0.005;
const degrees = 180 / Math.PI;
export interface AxisState {
  position: number;
  velocity: number;
  integral: number;
  output: number;
}
export interface GimbalState {
  time: number;
  pitch: AxisState;
  yaw: AxisState;
}
export function createState(): GimbalState {
  const axis = (): AxisState => ({ position: 0, velocity: 0, integral: 0, output: 0 });
  return { time: 0, pitch: axis(), yaw: axis() };
}
export function stepSimulation(state: GimbalState, params: PidParameters): void {
  for (const name of ["pitch", "yaw"] as const) {
    const axis = state[name];
    const error = params[name] / degrees - axis.position;
    const candidate = axis.integral + error * STEP;
    const raw = params.kp * error + params.ki * candidate - params.kd * axis.velocity;
    if (!params.antiWindup || Math.abs(raw) <= params.limit || error * raw < 0)
      axis.integral = candidate;
    axis.output = clamp(
      params.kp * error + params.ki * axis.integral - params.kd * axis.velocity,
      params.limit,
    );
    const gravity = name === "pitch" ? 2.943 * Math.cos(axis.position) : 0;
    axis.velocity += (axis.output - 1.2 * axis.velocity - gravity) * STEP;
    axis.position += axis.velocity * STEP;
  }
  state.time += STEP;
}
export interface Sample {
  time: number;
  pitch: number;
  yaw: number;
  pitchTarget: number;
  yawTarget: number;
  output: number;
}
export function sampleState(state: GimbalState, params: PidParameters): Sample {
  return {
    time: state.time,
    pitch: state.pitch.position * degrees,
    yaw: state.yaw.position * degrees,
    pitchTarget: params.pitch,
    yawTarget: params.yaw,
    output: state.pitch.output,
  };
}
// Finite fixture for deterministic regression tests; the live worker has no duration limit.
export function simulate(params: PidParameters): Simulation {
  validateParameters(params);
  const state = createState();
  const result: Simulation = {
    time: [],
    target: [],
    position: [],
    output: [],
    yaw: [],
    yawTarget: [],
    overshoot: 0,
    finalError: 0,
    settlingTime: null,
  };
  let lastOutside = 0;
  for (let step = 0; step <= 2400; step++) {
    const sample = sampleState(state, params);
    const error = params.pitch - sample.pitch;
    result.overshoot = Math.max(
      result.overshoot,
      params.pitch === 0
        ? Math.abs(sample.pitch)
        : Math.sign(params.pitch) * (sample.pitch - params.pitch),
    );
    if (Math.abs(error) > 1) lastOutside = step;
    if (step % 4 === 0) {
      result.time.push(step * STEP);
      result.target.push(params.pitch);
      result.position.push(sample.pitch);
      result.yaw.push(sample.yaw);
      result.yawTarget.push(params.yaw);
      result.output.push(sample.output);
    }
    result.finalError = error;
    if (step < 2400) stepSimulation(state, params);
  }
  result.settlingTime = lastOutside < 2300 ? (lastOutside + 1) * STEP : null;
  return result;
}
