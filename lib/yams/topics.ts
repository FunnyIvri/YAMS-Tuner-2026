import { EMPTY, NBSP, num } from "@/lib/format"
import type { LiveNT } from "@/lib/nt/live-nt"

export type MechanismKind = "elevator" | "arm" | "pivot" | "flywheel"
export type Axis = "rotary" | "linear"

export const KIND_LABELS: Record<MechanismKind, string> = {
  elevator: "Elevator",
  arm: "Arm",
  pivot: "Pivot",
  flywheel: "Flywheel",
}

export const CONTROL_WORD = "/DriverStation/ControlWord"
export const SUBSCRIBE_PREFIXES = ["/Mechanisms/", "/Tuning/", CONTROL_WORD]

/**
 * YAMS SmartMotorController telemetry for a mechanism whose telemetry name is `name`.
 * Read-only data is under /Mechanisms/<name>, tunables under /Tuning/<name>.
 */
export function yamsTopics(name: string) {
  const d = `/Mechanisms/${name}`
  const t = `/Tuning/${name}`
  return {
    data: {
      mechanismPosition: `${d}/mechanism/position`, // rotations
      mechanismVelocity: `${d}/mechanism/velocity`, // rotations per second
      measurementPosition: `${d}/measurement/position`, // meters
      measurementVelocity: `${d}/measurement/velocity`, // meters per second
      setpointPosition: `${d}/closedloop/setpoint/position`,
      setpointVelocity: `${d}/closedloop/setpoint/velocity`,
      outputVoltage: `${d}/motor/outputVoltage`,
      statorCurrent: `${d}/current/stator`,
      supplyCurrent: `${d}/current/supply`,
      temperature: `${d}/motor/temperature`,
      atUpperLimit: `${d}/limits/mechanism/upper`,
      atLowerLimit: `${d}/limits/mechanism/lower`,
      armFeedforward: `${d}/control/feedforward/arm`,
      elevatorFeedforward: `${d}/control/feedforward/elevator`,
      velocityControl: `${d}/control/closedloop/velocity`,
      motionProfile: `${d}/control/closedloop/profiled`,
    },
    tuning: {
      setpointPosition: `${t}/closedloop/setpoint/position`, // degrees or meters
      setpointVelocity: `${t}/closedloop/setpoint/velocity`, // RPM or m/s; 0 is ignored by YAMS
      mechanismLowerLimit: `${t}/mechanism/limit/lower`, // degrees
      mechanismUpperLimit: `${t}/mechanism/limit/upper`, // degrees
      measurementLowerLimit: `${t}/measurement/limit/lower`, // meters
      measurementUpperLimit: `${t}/measurement/limit/upper`, // meters
      motorInverted: `${t}/motor/inverted`,
      encoderInverted: `${t}/encoder/inverted`,
      // Drives the motor and its loosely coupled followers open loop while enabled (YAMS #228).
      voltageEnabled: `${t}/voltage/enabled`,
      voltageSetpoint: `${t}/voltage/setpoint`, // volts
    },
    tuningPrefix: `${t}/`,
  }
}

export type YamsTopics = ReturnType<typeof yamsTopics>

/** The Tunable "Live Tuning" command YAMS registers on the subsystem. */
export function liveTuningCommandTopic(subsystem: string) {
  return `/Tuning/${subsystem}/Live Tuning/running`
}

export interface GainDef {
  key: string
  label: string
  path: string
  /** Rejects negative values when true. */
  nonNegative: boolean
  group: "feedback" | "feedforward" | "profile" | "current" | "ramp"
  hint?: string
}

export type GainUnit = {
  label: string
  wireLabel: string
  toWire: (display: number) => number
  fromWire: (wire: number) => number
}

const identity = (v: number) => v
const DEG_PER_SEC_PER_RPM = 6

function sameUnit(label: string): GainUnit {
  return { label, wireLabel: label, toWire: identity, fromWire: identity }
}

function degreesOverRpm(label: string, wireLabel: string): GainUnit {
  return {
    label,
    wireLabel,
    toWire: (deg) => deg / DEG_PER_SEC_PER_RPM,
    fromWire: (rpm) => rpm * DEG_PER_SEC_PER_RPM,
  }
}

/**
 * YAMS reads motion-profile values in m/s and m/s² for linear (elevator) closed loops and
 * in RPM-based units otherwise. Arms and pivots are shown in degrees per second so the
 * numbers relate to the setpoints, then converted back to RPM before publishing.
 */
export function profileUnit(key: string, kind: MechanismKind, axis: Axis): GainUnit | null {
  if (kind === "flywheel") {
    if (key === "maxVelocity") return sameUnit("RPM")
    if (key === "maxAcceleration") return sameUnit("RPM/s")
    if (key === "maxJerk") return sameUnit("RPM/s²")
    return null
  }
  if (axis === "linear") {
    if (key === "maxVelocity") return sameUnit("m/s")
    if (key === "maxAcceleration") return sameUnit("m/s²")
    if (key === "maxJerk") return sameUnit("RPM/s²")
    return null
  }
  if (key === "maxVelocity") return degreesOverRpm("deg/s", "RPM")
  if (key === "maxAcceleration") return degreesOverRpm("deg/s²", "RPM/s")
  if (key === "maxJerk") return degreesOverRpm("deg/s³", "RPM/s²")
  return null
}

export const GAIN_DEFS: GainDef[] = [
  { key: "kP", label: "kP", path: "closedloop/feedback/kP", nonNegative: true, group: "feedback" },
  { key: "kI", label: "kI", path: "closedloop/feedback/kI", nonNegative: true, group: "feedback" },
  { key: "kD", label: "kD", path: "closedloop/feedback/kD", nonNegative: true, group: "feedback" },
  { key: "kS", label: "kS", path: "closedloop/feedforward/kS", nonNegative: true, group: "feedforward", hint: "V" },
  { key: "kV", label: "kV", path: "closedloop/feedforward/kV", nonNegative: true, group: "feedforward" },
  { key: "kA", label: "kA", path: "closedloop/feedforward/kA", nonNegative: true, group: "feedforward" },
  { key: "kG", label: "kG", path: "closedloop/feedforward/kG", nonNegative: false, group: "feedforward", hint: "V" },
  { key: "maxVelocity", label: "Max velocity", path: "closedloop/motionprofile/maxVelocity", nonNegative: true, group: "profile" },
  { key: "maxAcceleration", label: "Max accel", path: "closedloop/motionprofile/maxAcceleration", nonNegative: true, group: "profile" },
  { key: "maxJerk", label: "Max jerk", path: "closedloop/motionprofile/maxJerk", nonNegative: true, group: "profile" },
  { key: "statorLimit", label: "Stator limit", path: "current/limit/stator", nonNegative: true, group: "current", hint: "A" },
  { key: "supplyLimit", label: "Supply limit", path: "current/limit/supply", nonNegative: true, group: "current", hint: "A" },
  { key: "closedRamp", label: "Closed-loop ramp", path: "ramprate/dutycycle/closedloop", nonNegative: true, group: "ramp", hint: "s" },
]

/** Mechanism telemetry names published under /Tuning/ with a tunable setpoint. */
export function discoverMechanisms(nt: LiveNT): string[] {
  const names = new Set<string>()
  const suffix = "/closedloop/setpoint/position"
  for (const topic of nt.topicNames()) {
    if (topic.startsWith("/Tuning/") && topic.endsWith(suffix)) {
      names.add(topic.slice("/Tuning/".length, -suffix.length))
    }
  }
  return Array.from(names).sort()
}

/** Subsystems that registered a YAMS "Live Tuning" command. */
export function discoverCommands(nt: LiveNT): string[] {
  const names = new Set<string>()
  const suffix = "/Live Tuning/running"
  for (const topic of nt.topicNames()) {
    if (topic.startsWith("/Tuning/") && topic.endsWith(suffix)) {
      names.add(topic.slice("/Tuning/".length, -suffix.length))
    }
  }
  return Array.from(names).sort()
}

/** YAMS publishes the tunable setpoint in meters when the closed loop runs on a linear measurement. */
export function detectAxis(nt: LiveNT, name: string): Axis {
  const t = yamsTopics(name)
  const units = nt.getProperties(t.tuning.setpointPosition)?.units
  if (units === "meter") return "linear"
  if (units === "degrees") return "rotary"
  return nt.isAnnounced(t.tuning.measurementLowerLimit) ? "linear" : "rotary"
}

export function guessKind(nt: LiveNT, name: string): MechanismKind {
  const t = yamsTopics(name)
  if (detectAxis(nt, name) === "linear") return "elevator"
  if (nt.get<boolean>(t.data.elevatorFeedforward) === true) return "elevator"
  if (nt.get<boolean>(t.data.armFeedforward) === true) return "arm"
  if (nt.get<boolean>(t.data.velocityControl) === true) return "flywheel"
  if (!nt.isAnnounced(t.tuning.mechanismLowerLimit) && !nt.isAnnounced(t.tuning.mechanismUpperLimit)) return "flywheel"
  return "pivot"
}

/** Unit-aware readers so the rest of the app works in the same units YAMS takes for setpoints. */
export function axisReader(nt: LiveNT, name: string, axis: Axis) {
  const t = yamsTopics(name)
  const softRange = (): [number, number] | undefined => {
    const lo = nt.getNumber(axis === "linear" ? t.tuning.measurementLowerLimit : t.tuning.mechanismLowerLimit)
    const hi = nt.getNumber(axis === "linear" ? t.tuning.measurementUpperLimit : t.tuning.mechanismUpperLimit)
    if (lo === undefined || hi === undefined || !Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return undefined
    return [lo, hi]
  }
  return {
    /** Position in degrees (rotary) or meters (linear). */
    position(): number | undefined {
      if (axis === "linear") return nt.getNumber(t.data.measurementPosition)
      const rot = nt.getNumber(t.data.mechanismPosition)
      return rot === undefined ? undefined : rot * 360
    },
    /** Velocity in RPM (rotary) or m/s (linear), matching the tunable velocity setpoint. */
    velocity(): number | undefined {
      if (axis === "linear") return nt.getNumber(t.data.measurementVelocity)
      const rps = nt.getNumber(t.data.mechanismVelocity)
      return rps === undefined ? undefined : rps * 60
    },
    /** Soft limits count only when both are finite and form a real range; unset limits often publish as 0/0. */
    lowerLimit(): number | undefined {
      return softRange()?.[0]
    },
    upperLimit(): number | undefined {
      return softRange()?.[1]
    },
    lowerLimitTopic: axis === "linear" ? t.tuning.measurementLowerLimit : t.tuning.mechanismLowerLimit,
    upperLimitTopic: axis === "linear" ? t.tuning.measurementUpperLimit : t.tuning.mechanismUpperLimit,
    statorCurrent(): number | undefined {
      return nt.getNumber(t.data.statorCurrent)
    },
  }
}

export function positionUnit(axis: Axis) {
  return axis === "linear" ? "m" : "°"
}

export function velocityUnit(axis: Axis) {
  return axis === "linear" ? "m/s" : "RPM"
}

export function formatPosition(value: number | undefined, axis: Axis) {
  if (value === undefined) return EMPTY
  return axis === "linear" ? `${num(value, 3)}${NBSP}m` : `${num(value, 1)}°`
}

export function formatNumber(value: number | undefined, digits = 2) {
  if (value === undefined) return EMPTY
  return num(value, digits)
}
