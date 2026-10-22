import type { Axis, MechanismKind } from "@/lib/yams/topics"

export interface JogParams {
  /** How fast the setpoint creeps while a jog button is held, per second. */
  rate: number
  maxRate: number
  /** The setpoint is never allowed further than this ahead of the measured position. */
  maxLead: number
  /** Within this of a soft limit counts as reaching it. */
  reachTolerance: number
  /** Movement the wrong way by more than this aborts as an inversion. */
  directionThreshold: number
  /** With the lead saturated for this long and no movement, the jog aborts as stuck. */
  stuckTimeoutMs: number
}

export function jogParams(axis: Axis): JogParams {
  return axis === "linear"
    ? { rate: 0.05, maxRate: 0.15, maxLead: 0.015, reachTolerance: 0.005, directionThreshold: 0.005, stuckTimeoutMs: 2500 }
    : { rate: 10, maxRate: 30, maxLead: 4, reachTolerance: 1.5, directionThreshold: 1.5, stuckTimeoutMs: 2500 }
}

/** Position overshoot past the verified range that stops Live Tuning. */
export function overshootTolerance(axis: Axis) {
  return axis === "linear" ? 0.02 : 4
}

/** Without a motion profile, a single setpoint change larger than this needs confirmation. */
export function defaultMaxStep(axis: Axis) {
  return axis === "linear" ? 0.1 : 20
}

export const DEFAULT_STALL_CURRENT = 40
export const STALL_DEBOUNCE_MS = 250
/** A nonzero, negligible velocity setpoint: YAMS ignores exactly 0 and would fall back to position hold. */
export const FLYWHEEL_IDLE_VELOCITY = 1e-6
export interface FlywheelRange {
  min: number
  max: number
}

/** A flywheel's safety default: velocity setpoints are clamped to ±4000 RPM until the slider's range is changed. */
export const DEFAULT_FLYWHEEL_MAX_RPM = 4000
export const DEFAULT_FLYWHEEL_RANGE: FlywheelRange = { min: -DEFAULT_FLYWHEEL_MAX_RPM, max: DEFAULT_FLYWHEEL_MAX_RPM }

export function needsRangeVerification(kind: MechanismKind, continuous: boolean) {
  if (kind === "flywheel") return false
  if (kind === "pivot" && continuous) return false
  return true
}

export const PRE_MOTION_CHECKLIST: Record<"positional" | "continuous" | "flywheel", string[]> = {
  positional: [
    "Everyone is clear of the mechanism's full path of travel, including pinch points.",
    "Nothing (tools, game pieces, wiring, bumpers) is inside the range of motion.",
    "Someone is at the Driver Station with a hand over Enter (disable) and Space (E-stop).",
    "The mechanism can be stopped by disabling: no stored energy (springs, surgical tubing, pressurized pneumatics) will move it unsafely.",
  ],
  continuous: [
    "The pivot can rotate a full turn in both directions without wrapping or pinching wiring.",
    "Everyone is clear of the pivot's swept area.",
    "Someone is at the Driver Station with a hand over Enter (disable) and Space (E-stop).",
  ],
  flywheel: [
    "All guards and covers are installed; no game pieces are loaded.",
    "Hands, hair and loose clothing are away from the wheels and nobody stands in the exit path.",
    "Someone is at the Driver Station with a hand over Enter (disable) and Space (E-stop).",
  ],
}
