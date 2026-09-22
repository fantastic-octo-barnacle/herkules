---
name: herkules-pid-tuning
description: Tune the connected Herkules browser PID gimbal through its local MCP bridge, inspecting live response and changing gains or targets without resetting motion. Use for the training simulation, not hardware motor calibration.
---

Use the `herkules-pid-tuning` MCP tools. If unavailable, explain that the client must launch `node /absolute/path/to/herkules/apps/training/src/agent/main.ts` as a stdio MCP server (Node 24). The setup guide is in `../../docs/guide/agent-tuning.md` in the repository.

Call `connect_lab` and let the user pair the returned local URL in the lab's Agent panel. Call `read_lab` before modifying anything. The snapshot contains current parameters, supported bounds, running state, angles and up to 12 seconds of measured history. Disconnected or stale state is an error, not an empty experiment.

Tune toward the user's stated objective. Preserve their target angles, torque limit and anti-windup preference unless changing those is part of the task. Use partial `set_parameters` patches. Parameter changes preserve position, velocity, integral memory and history; lowering Ki does not clear accumulated error. Both axes share gains. Pitch has gravity torque `-2.943*cos(pitchRadians)`; yaw does not. Angles in tools are degrees; torque is N·m; PID internally uses radians.

Observe enough new simulated time after each change to assess the result. History timestamps are simulation time and may advance slowly in a background tab. Compare error, peak deviation after an identified target change, oscillation and saturation from actual samples. Do not infer improvement from gains alone or compare intervals with different targets without explaining the difference. Stop once the objective is met or after five parameter trials, report measured evidence, and ask for direction if it remains unmet.

Use `set_running` for an intentional pause/resume. Never call `reset_lab` unless the user requested a fresh run or reset. A write timeout/disconnect has an unknown outcome: reconnect and read state before retrying. Do not claim a change applied without a successful acknowledged result. This bridge controls only the paired educational browser simulation, not physical hardware.
