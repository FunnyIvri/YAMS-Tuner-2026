// A simulated YAMS robot that runs in the page, for trying the tuner without a robot or a simulation.
// DemoNt4Client stands in for FRC Web Components' Nt4Client, so LiveNT and every panel work unchanged.
// Each mechanism runs on YAMG's simulation (see mechanism-sim.ts).

import type { Nt4Topic } from "@frc-web-components/fwc/source-providers/nt4"
import type { RobotMode } from "@/lib/nt/live-nt"
import { MechanismSim, type MechanismSimOptions } from "@/lib/demo/mechanism-sim"

/** The robot loop period, in seconds. */
const LOOP_S = 0.02
const DEG = Math.PI / 180
/** RPM to rad/s. */
const RPM = (2 * Math.PI) / 60

type Kind = MechanismSimOptions["kind"]

/** Gains and limits as they are published under /Tuning/<name>/, in the units each mechanism's comment gives. */
type WireGains = Record<string, number>

interface MechDef {
  name: string
  command: string
  kind: Kind
  sim: MechanismSimOptions
  /** Soft limits in the setpoint units: meters, or degrees. */
  softLimits?: [number, number]
  profiled: boolean
  gains: WireGains
}

const DEFS: MechDef[] = [
  {
    // kP in V/m, kV in V/(m/s), kA in V/(m/s²), max velocity in m/s and acceleration in m/s².
    // kG is too low on purpose (about 0.46 V holds the carriage), so the elevator sags until it is tuned.
    name: "Elevator/ElevatorMotor",
    command: "Elevator",
    kind: "elevator",
    sim: { kind: "elevator", gearing: 12, mass: 7, drumRadius: (22 * 0.25 * 0.0254) / (2 * Math.PI), minPosition: 0, maxPosition: 1, startingPosition: 0.2 },
    softLimits: [0, 0.95],
    profiled: true,
    gains: { kP: 30, kI: 0, kD: 0, kS: 0, kV: 0, kA: 0, kG: 0.1, maxVelocity: 1, maxAcceleration: 2, statorLimit: 40, supplyLimit: 60, closedRamp: 0 },
  },
  {
    // kP in V per rotation, kV in V/(rot/s), max velocity in RPM and acceleration in RPM/s.
    // kG is too low on purpose (about 0.37 V holds it level).
    name: "Arm/ArmMotor",
    command: "Arm",
    kind: "arm",
    sim: { kind: "arm", gearing: 60, mass: 2.5, length: 0.5, minPosition: -20 * DEG, maxPosition: 110 * DEG, startingPosition: 0 },
    softLimits: [-10, 100],
    profiled: true,
    gains: { kP: 25, kI: 0, kD: 0, kS: 0, kV: 0, kA: 0, kG: 0.2, maxVelocity: 30, maxAcceleration: 60, statorLimit: 40, supplyLimit: 60, closedRamp: 0 },
  },
  {
    // No motion profile, so a big setpoint step asks for confirmation. kP in V per rotation.
    name: "Turret/TurretMotor",
    command: "Turret",
    kind: "pivot",
    sim: { kind: "pivot", gearing: 40, moi: 0.15, minPosition: -190 * DEG, maxPosition: 190 * DEG, startingPosition: 0 },
    softLimits: [-170, 170],
    profiled: false,
    gains: { kP: 40, kI: 0, kD: 0.5, kS: 0, kV: 0, kA: 0, statorLimit: 40, supplyLimit: 60, closedRamp: 0 },
  },
  {
    // kP and kV in V/(rot/s). kV is 0 on purpose (about 0.12 holds a speed), so kP alone never reaches the setpoint.
    name: "Shooter/ShooterMotor",
    command: "Shooter",
    kind: "flywheel",
    sim: { kind: "flywheel", gearing: 1, motorCount: 2, moi: 0.004 },
    profiled: false,
    gains: { kP: 0.05, kI: 0, kD: 0, kS: 0, kV: 0, kA: 0, statorLimit: 60, supplyLimit: 60, closedRamp: 0 },
  },
]

const GAIN_PATHS: Record<string, string> = {
  kP: "closedloop/feedback/kP",
  kI: "closedloop/feedback/kI",
  kD: "closedloop/feedback/kD",
  kS: "closedloop/feedforward/kS",
  kV: "closedloop/feedforward/kV",
  kA: "closedloop/feedforward/kA",
  kG: "closedloop/feedforward/kG",
  maxVelocity: "closedloop/motionprofile/maxVelocity",
  maxAcceleration: "closedloop/motionprofile/maxAcceleration",
  statorLimit: "current/limit/stator",
  supplyLimit: "current/limit/supply",
  closedRamp: "ramprate/dutycycle/closedloop",
}

export interface DemoFaults {
  /** The elevator motor turns the wrong way for a positive voltage. */
  elevatorBackwards: boolean
  /** Something blocks the arm at 45°. */
  armBlocked: boolean
}

const NO_FAULTS: DemoFaults = { elevatorBackwards: false, armBlocked: false }

/** One YAMS mechanism with its SmartMotorController's live tuning state. Setpoints are in meters, degrees or RPM. */
class Mechanism {
  readonly def: MechDef
  readonly sim: MechanismSim
  readonly linear: boolean
  gains: WireGains
  setpointPos: number
  setpointVel = 0
  voltageEnabled = false
  voltageSetpoint = 0
  motorInverted = false
  encoderInverted = false
  soft: [number, number] | undefined
  running = false
  /** What the motor controller outputs, before any wiring fault. */
  volts = 0
  stator = 0
  supply = 0
  temp = 25
  private lastOut = 0

  constructor(def: MechDef) {
    this.def = def
    this.sim = new MechanismSim(def.sim)
    this.linear = def.kind === "elevator"
    this.gains = { ...def.gains }
    this.soft = def.softLimits ? [...def.softLimits] : undefined
    this.setpointPos = this.position()
    // The gains are per meter for an elevator, and per rotation (or rotation per second) otherwise.
    const perSimUnit = this.linear ? 1 : 1 / (2 * Math.PI)
    this.sim.pidUnitsPerSimUnit = perSimUnit
    this.sim.feedforwardUnitsPerSimUnit = perSimUnit
  }

  /** Sim units (meters or radians) to setpoint units (meters or degrees), and back. */
  private toUnits(v: number) {
    return this.linear ? v : v / DEG
  }

  private fromUnits(v: number) {
    return this.linear ? v : v * DEG
  }

  private measuredSim() {
    return this.encoderInverted ? -this.sim.position : this.sim.position
  }

  private measuredSimVelocity() {
    return this.encoderInverted ? -this.sim.velocity : this.sim.velocity
  }

  /** Measured position in meters or degrees. */
  position() {
    return this.toUnits(this.measuredSim())
  }

  /** Measured velocity in m/s, deg/s, or for a flywheel rot/s. */
  velocity() {
    return this.def.kind === "flywheel" ? this.measuredSimVelocity() / (2 * Math.PI) : this.toUnits(this.measuredSimVelocity())
  }

  start() {
    this.running = true
    this.sim.restart()
    this.sim.setpoint = { position: this.measuredSim(), velocity: this.measuredSimVelocity() }
  }

  stop() {
    this.running = false
    this.voltageEnabled = false
    this.voltageSetpoint = 0
  }

  private applyGains() {
    const g = this.gains
    this.sim.gains = { kP: g.kP ?? 0, kI: g.kI ?? 0, kD: g.kD ?? 0, kS: g.kS ?? 0, kV: g.kV ?? 0, kA: g.kA ?? 0, kG: g.kG ?? 0 }
    // Elevator profiles are in m/s; the others in RPM.
    const toSim = this.linear ? 1 : RPM
    this.sim.maxVelocity = this.def.profiled ? (g.maxVelocity ?? 0) * toSim : 0
    this.sim.maxAcceleration = this.def.profiled ? (g.maxAcceleration ?? 0) * toSim : 0
    this.sim.statorCurrentLimit = g.statorLimit > 0 ? g.statorLimit : undefined
    this.sim.supplyCurrentLimit = g.supplyLimit > 0 ? g.supplyLimit : undefined
  }

  private controller(enabled: boolean, dt: number): number {
    if (!enabled || !this.running) {
      this.sim.restart()
      return 0
    }
    if (this.voltageEnabled) return Math.max(-12, Math.min(12, this.voltageSetpoint))
    if (this.def.kind === "flywheel") {
      // The tuner's idle setpoint is a tiny velocity, since YAMS ignores exactly 0.
      const goal = Math.abs(this.setpointVel) < 0.01 ? 0 : this.setpointVel * RPM
      return this.sim.velocityControl(goal, dt, this.measuredSimVelocity())
    }
    let goal = this.setpointPos
    if (this.soft) goal = Math.max(this.soft[0], Math.min(this.soft[1], goal))
    return this.sim.positionControl(this.fromUnits(goal), dt, this.measuredSim())
  }

  step(enabled: boolean, dt: number, faults: DemoFaults) {
    this.applyGains()
    if (this.def.kind !== "flywheel" && !(enabled && this.running)) {
      // Nothing drives it, so the motor is in brake mode and the gearbox holds it where it is. Every mechanism
      // starts inside its range of motion and stays there until it is driven.
      this.sim.restart()
      this.sim.velocity = 0
      this.lastOut = 0
      this.volts = 0
      this.stator = 0
      this.supply = 0
      this.temp += -(this.temp - 25) * 0.01 * dt
      return
    }
    let out = this.controller(enabled, dt)
    const ramp = this.gains.closedRamp ?? 0
    if (ramp > 0 && !this.voltageEnabled && this.running) {
      const maxStep = (12 / ramp) * dt
      out = this.lastOut + Math.max(-maxStep, Math.min(maxStep, out - this.lastOut))
    }
    this.lastOut = out
    // Which way the motor really turns for a positive output.
    const backwards = this.def.kind === "elevator" && faults.elevatorBackwards
    const sign = this.motorInverted !== backwards ? -1 : 1
    let maxPosition = this.sim.maxPosition
    if (this.def.kind === "arm" && faults.armBlocked && this.sim.position <= 45.5 * DEG) maxPosition = 45 * DEG
    this.sim.step(out * sign, dt, maxPosition)
    this.volts = this.sim.voltage * sign
    this.stator = (this.sim.current / this.sim.motor.count) * sign
    this.supply = Math.abs(this.sim.supplyCurrent)
    const perMotor = Math.abs(this.sim.current) / this.sim.motor.count
    this.temp += (perMotor * perMotor * 0.066 * 0.004 - (this.temp - 25) * 0.01) * dt
  }
}

type AnnounceFn = (topic: Nt4Topic) => void
type DataFn = (topic: Nt4Topic, timestampUs: number, value: unknown) => void

/** The simulated robot: its mechanisms, Driver Station state and fault injection. */
export class DemoRobot {
  mechanisms = DEFS.map((d) => new Mechanism(d))
  enabled = false
  mode: RobotMode = "teleoperated"
  faults: DemoFaults = { ...NO_FAULTS }
  private listeners = new Set<() => void>()
  private version = 0

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getVersion = () => this.version

  changed() {
    this.version++
    this.listeners.forEach((l) => l())
  }

  setEnabled(enabled: boolean) {
    if (enabled === this.enabled) return
    this.enabled = enabled
    // Commands that do not run while disabled end when the robot is disabled.
    if (!enabled) this.mechanisms.forEach((m) => m.stop())
    this.changed()
  }

  setMode(mode: RobotMode) {
    if (mode === this.mode) return
    this.mode = mode
    // The Driver Station disables the robot when the mode changes.
    this.enabled = false
    this.mechanisms.forEach((m) => m.stop())
    this.changed()
  }

  setFault(key: keyof DemoFaults, value: boolean) {
    this.faults = { ...this.faults, [key]: value }
    this.changed()
  }

  /** Put every mechanism back where it started, with its original gains. */
  reset() {
    this.mechanisms = DEFS.map((d) => new Mechanism(d))
    this.faults = { ...NO_FAULTS }
    this.enabled = false
    this.changed()
  }

  controlWord(): Uint8Array {
    const word = new Uint8Array(8)
    const modeBits = { unknown: 0, autonomous: 1, teleoperated: 2, utility: 3 }[this.mode]
    word[7] = modeBits | (this.enabled ? 0b100 : 0) | 0b100000
    return word
  }

  step(dt: number) {
    for (const m of this.mechanisms) m.step(this.enabled, dt, this.faults)
  }
}

/** A topic the demo robot publishes: its NT type and properties, and how to read it and apply a write. */
interface TopicDef {
  type: string
  properties?: Record<string, unknown>
  read: () => unknown
  write?: (value: unknown) => void
  /** Published every loop. Tunables are only sent when the robot changes them. */
  data?: boolean
}

function topicsFor(robot: DemoRobot, index: number): Map<string, TopicDef> {
  const m = () => robot.mechanisms[index]
  const def = DEFS[index]
  const d = `/Mechanisms/${def.name}`
  const t = `/Tuning/${def.name}`
  const linear = def.kind === "elevator"
  const flywheel = def.kind === "flywheel"
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined)
  const topics = new Map<string, TopicDef>()
  const data = (name: string, read: () => unknown, type = "double", properties?: Record<string, unknown>) =>
    topics.set(`${d}/${name}`, { type, read, data: true, properties })
  const tunable = (name: string, read: () => unknown, write: (v: unknown) => void, type = "double", properties?: Record<string, unknown>) =>
    topics.set(`${t}/${name}`, { type, read, write, properties })
  const setNumber = (apply: (n: number) => void) => (v: unknown) => {
    const n = num(v)
    if (n !== undefined) apply(n)
  }

  // Mechanism rotations and rotations per second.
  const circumference = 2 * Math.PI * (def.sim.drumRadius ?? 1)
  data("mechanism/position", () => (linear ? m().position() / circumference : flywheel ? m().sim.position / (2 * Math.PI) : m().position() / 360))
  data("mechanism/velocity", () => (linear ? m().velocity() / circumference : flywheel ? m().velocity() : m().velocity() / 360))
  if (linear) {
    data("measurement/position", () => m().position(), "double", { units: "meter" })
    data("measurement/velocity", () => m().velocity(), "double", { units: "meter per second" })
  }
  data("closedloop/setpoint/position", () => (flywheel ? 0 : m().setpointPos))
  data("closedloop/setpoint/velocity", () => (flywheel ? m().setpointVel : 0))
  data("motor/outputVoltage", () => m().volts)
  data("current/stator", () => m().stator)
  data("current/supply", () => m().supply)
  data("motor/temperature", () => m().temp)
  if (def.softLimits) {
    data("limits/mechanism/lower", () => !!m().soft && m().position() <= (m().soft as [number, number])[0], "boolean")
    data("limits/mechanism/upper", () => !!m().soft && m().position() >= (m().soft as [number, number])[1], "boolean")
  }
  data("control/feedforward/arm", () => def.kind === "arm", "boolean")
  data("control/feedforward/elevator", () => linear, "boolean")
  data("control/closedloop/velocity", () => flywheel, "boolean")
  data("control/closedloop/profiled", () => def.profiled, "boolean")

  tunable("closedloop/setpoint/position", () => m().setpointPos, setNumber((n) => (m().setpointPos = n)), "double", {
    units: linear ? "meter" : "degrees",
  })
  tunable("closedloop/setpoint/velocity", () => m().setpointVel, setNumber((n) => (m().setpointVel = n)))
  if (def.softLimits) {
    const prefix = linear ? "measurement/limit" : "mechanism/limit"
    tunable(`${prefix}/lower`, () => m().soft?.[0], setNumber((n) => m().soft && (m().soft![0] = n)))
    tunable(`${prefix}/upper`, () => m().soft?.[1], setNumber((n) => m().soft && (m().soft![1] = n)))
  }
  tunable("motor/inverted", () => m().motorInverted, (v) => (m().motorInverted = v === true), "boolean")
  tunable("encoder/inverted", () => m().encoderInverted, (v) => (m().encoderInverted = v === true), "boolean")
  tunable("voltage/enabled", () => m().voltageEnabled, (v) => (m().voltageEnabled = v === true), "boolean")
  tunable("voltage/setpoint", () => m().voltageSetpoint, setNumber((n) => (m().voltageSetpoint = n)))
  for (const key of Object.keys(def.gains)) {
    if (!def.profiled && (key === "maxVelocity" || key === "maxAcceleration")) continue
    tunable(GAIN_PATHS[key], () => m().gains[key], setNumber((n) => (m().gains[key] = n)))
  }
  return topics
}

const runningTopic = (def: MechDef) => `/Tuning/${def.command}/Live Tuning/running`

/**
 * Stands in for FRC Web Components' Nt4Client, talking to a DemoRobot instead of a NetworkTables server.
 * Only the parts LiveNT uses are implemented.
 */
export class DemoNt4Client {
  private topics = new Map<string, TopicDef>()
  private nt4Topics = new Map<string, Nt4Topic>()
  private timer: ReturnType<typeof setInterval> | null = null
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private lastStep = 0
  private leftover = 0
  private connected = false
  private unsubscribeRobot: (() => void) | null = null
  private lastControlWord = -1
  private runningSent = new Map<string, boolean>()

  constructor(
    readonly robot: DemoRobot,
    private onAnnounce: AnnounceFn,
    private onData: DataFn,
    private onConnect: () => void,
  ) {
    DEFS.forEach((_, i) => topicsFor(robot, i).forEach((v, k) => this.topics.set(k, v)))
    DEFS.forEach((def, i) => {
      const name = runningTopic(def)
      this.topics.set(name, {
        type: "boolean",
        read: () => robot.mechanisms[i].running,
        write: (v) => {
          const mech = robot.mechanisms[i]
          if (v === true && !mech.running) {
            // A command only starts while the robot is enabled; otherwise the scheduler sets it back.
            if (robot.enabled) mech.start()
            else setTimeout(() => this.send(name), 40)
          } else if (v !== true && mech.running) mech.stop()
        },
      })
    })
    this.topics.set("/DriverStation/ControlWord", { type: "struct:ControlWord", read: () => robot.controlWord(), data: true })
  }

  private nowUs() {
    return Math.round(performance.now() * 1000)
  }

  private topic(name: string): Nt4Topic {
    let topic = this.nt4Topics.get(name)
    if (!topic) {
      const def = this.topics.get(name)
      topic = { uid: this.nt4Topics.size + 1, name, type: def?.type ?? "double", properties: def?.properties ?? {} }
      this.nt4Topics.set(name, topic)
    }
    return topic
  }

  private send(name: string) {
    const def = this.topics.get(name)
    if (!def || !this.connected) return
    this.onData(this.topic(name), this.nowUs(), def.read())
  }

  connect() {
    // A short delay so "Connecting" shows, as it does with a real robot.
    this.connectTimer = setTimeout(() => {
      this.connected = true
      for (const name of this.topics.keys()) this.onAnnounce(this.topic(name))
      for (const name of this.topics.keys()) this.send(name)
      this.onConnect()
      this.lastStep = performance.now()
      this.timer = setInterval(() => this.tick(), LOOP_S * 1000)
      this.unsubscribeRobot = this.robot.subscribe(() => this.publishRobotChanges())
    }, 400)
  }

  disconnect() {
    if (this.connectTimer) clearTimeout(this.connectTimer)
    if (this.timer) clearInterval(this.timer)
    this.unsubscribeRobot?.()
    this.timer = null
    if (this.connected) {
      this.connected = false
      // The robot loses its Driver Station when the tuner goes away.
      this.robot.setEnabled(false)
    }
  }

  /** Values the robot changed on its own, such as a command ending or the robot being disabled. */
  private publishRobotChanges() {
    for (const def of DEFS) {
      const name = runningTopic(def)
      const running = this.topics.get(name)?.read() === true
      if (this.runningSent.get(name) !== running) {
        this.runningSent.set(name, running)
        this.send(name)
      }
    }
    const word = this.robot.controlWord()[7]
    if (word !== this.lastControlWord) {
      this.lastControlWord = word
      this.send("/DriverStation/ControlWord")
    }
  }

  private tick() {
    const now = performance.now()
    // Run whole robot loops for the time that passed. Background tabs fire timers late, so catch up, but
    // never more than a second at once.
    this.leftover = Math.min(1, this.leftover + (now - this.lastStep) / 1000)
    this.lastStep = now
    while (this.leftover >= LOOP_S) {
      this.robot.step(LOOP_S)
      this.leftover -= LOOP_S
    }
    for (const [name, def] of this.topics) if (def.data) this.send(name)
    this.publishRobotChanges()
  }

  subscribePeriodic(): number {
    return 1
  }

  subscribeAll(): number {
    return 1
  }

  publishNewTopic(): void {}

  addSample(topic: string, value: unknown): void {
    this.addTimestampedSample(topic, this.nowUs(), value)
  }

  addTimestampedSample(topic: string, _timestamp: number, value: unknown): void {
    if (!this.connected) return
    this.topics.get(topic)?.write?.(value)
    this.publishRobotChanges()
  }

  getServerTime_us(): number | null {
    return this.nowUs()
  }
}
