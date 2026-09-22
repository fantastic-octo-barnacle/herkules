/** Educational second-order plant. Fixed integration step, independent of rendering. */
export interface PidParameters {
  kp: number;
  ki: number;
  kd: number;
  limit: number;
  disturbance: number;
  antiWindup: boolean;
}
export interface Simulation {
  time: number[];
  target: number[];
  position: number[];
  output: number[];
  overshoot: number;
  finalError: number;
  settlingTime: number | null;
}
export const defaults: PidParameters = {
  kp: 12,
  ki: 4,
  kd: 5,
  limit: 20,
  disturbance: 0,
  antiWindup: true,
};
export const presets: Record<string, Pick<PidParameters, "kp" | "ki" | "kd">> = {
  gentle: { kp: 4, ki: 0, kd: 2 },
  oscillating: { kp: 30, ki: 8, kd: 0 },
  damped: { kp: 12, ki: 4, kd: 5 },
};
const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));

export function simulate(params: PidParameters): Simulation {
  for (const key of ["kp", "ki", "kd", "limit", "disturbance"] as const) {
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
    Math.abs(params.disturbance) > 5
  )
    throw new Error("Parameters outside lab bounds");
  const dt = 0.005;
  const result: Simulation = {
    time: [],
    target: [],
    position: [],
    output: [],
    overshoot: 0,
    finalError: 1,
    settlingTime: null,
  };
  let position = 0;
  let velocity = 0;
  let integral = 0;
  let peak = 0;
  let lastOutside = 0;
  for (let step = 0; step <= 2400; step++) {
    const time = step * dt;
    const error = 1 - position;
    const candidate = integral + error * dt;
    // Derivative on measurement avoids a setpoint derivative kick.
    const raw = params.kp * error + params.ki * candidate - params.kd * velocity;
    // Conditional integration: permit unwinding, reject further saturation.
    if (!params.antiWindup || Math.abs(raw) <= params.limit || error * raw < 0)
      integral = candidate;
    const output = clamp(
      params.kp * error + params.ki * integral - params.kd * velocity,
      params.limit,
    );
    peak = Math.max(peak, position);
    if (Math.abs(error) > 0.02) lastOutside = step;
    if (step % 4 === 0) {
      result.time.push(time);
      result.target.push(1);
      result.position.push(position);
      result.output.push(output);
    }
    result.finalError = error;
    if (step < 2400) {
      // m = 1, viscous damping = 1.2, stiffness = 2; load step at t = 6 s.
      const acceleration =
        output - 1.2 * velocity - 2 * position + (time >= 6 ? params.disturbance : 0);
      velocity += acceleration * dt;
      position += velocity * dt;
    }
  }
  result.overshoot = Math.max(0, (peak - 1) * 100);
  // Require at least 0.5 s continuously inside the 2% band before reporting settling.
  result.settlingTime = lastOutside < 2300 ? (lastOutside + 1) * dt : null;
  return result;
}
