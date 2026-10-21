// The physics and closed loop of YAMG's simulation (lib/simulation/controls-base-sim.ts, arm-sim.ts,
// elevator-sim.ts and flywheel-sim.ts), without the canvas, so the demo robot can step it.

import { TrapezoidProfile, type ProfileState } from "@/lib/demo/trapezoid-profile"

/** The battery's voltage with no load. */
const NOMINAL_VOLTAGE = 12
/** The battery's internal resistance, in ohms. */
const BATTERY_RESISTANCE = 0.015
/** How often a motor controller applies its current limits, in seconds. */
const CURRENT_LIMIT_PERIOD = 0.001
const G = 9.81

/** A NEO, from YAMG's hardware config (ReCalc's motor data). */
const NEO = { kv: 493.5, kt: 0.0181, resistance: 0.066, freeCurrent: 1.782 }

export type SimKind = "elevator" | "arm" | "pivot" | "flywheel"

export interface MechanismSimOptions {
  kind: SimKind
  gearing: number
  motorCount?: number
  /** Elevator: carriage mass in kg. Arm: arm mass in kg. */
  mass?: number
  /** Elevator drum radius in meters. */
  drumRadius?: number
  /** Arm length in meters. */
  length?: number
  /** Moment of inertia in kg·m², for a pivot or a flywheel (an arm defaults to a rod's). */
  moi?: number
  /** Hard stops, in meters or radians. */
  minPosition?: number
  maxPosition?: number
  startingPosition?: number
}

export interface Gains {
  kP: number
  kI: number
  kD: number
  kS: number
  kV: number
  kA: number
  kG: number
}

/**
 * One mechanism: its motors, its load and the closed loop that drives it. Positions are in meters for an
 * elevator and radians otherwise; velocities per second.
 */
export class MechanismSim {
  readonly kind: SimKind
  readonly motor: { kv: number; kt: number; R: number; count: number; freeCurrent: number; stallCurrent: number }
  readonly mass: number
  readonly drumRadius: number
  readonly length: number
  readonly moi: number
  minPosition: number
  maxPosition: number

  position: number
  velocity = 0
  voltage = 0
  /** Stator current of all the motors together, in amps. */
  current = 0
  supplyCurrent = 0
  batteryVoltage = NOMINAL_VOLTAGE

  gains: Gains = { kP: 0, kI: 0, kD: 0, kS: 0, kV: 0, kA: 0, kG: 0 }
  /** How many of the gains' units one meter or radian is, such as 1 / 2π for per rotation. */
  pidUnitsPerSimUnit = 1
  feedforwardUnitsPerSimUnit = 1
  /** Profile constraints in meters or radians per second, and per second squared. Both 0 turn it off. */
  maxVelocity = 0
  maxAcceleration = 0
  statorCurrentLimit: number | undefined
  supplyCurrentLimit: number | undefined

  /** Where the profile is now: the position and velocity the closed loop follows. */
  setpoint: ProfileState
  private integral = 0
  private prevError = 0

  constructor(options: MechanismSimOptions) {
    this.kind = options.kind
    const gearing = options.gearing
    const count = options.motorCount ?? 1
    this.motor = {
      kv: NEO.kv / gearing,
      // Motors side by side share the current, so kt stays per motor and the resistance is split.
      kt: NEO.kt * gearing,
      R: NEO.resistance / count,
      count,
      freeCurrent: NEO.freeCurrent,
      stallCurrent: NOMINAL_VOLTAGE / NEO.resistance,
    }
    this.mass = options.mass ?? 5
    this.drumRadius = options.drumRadius ?? 0.0254
    this.length = options.length ?? 1
    this.moi =
      options.moi ?? (this.kind === "elevator" ? this.mass * this.drumRadius * this.drumRadius : (this.mass * this.length * this.length) / 3)
    this.minPosition = options.minPosition ?? -Infinity
    this.maxPosition = options.maxPosition ?? Infinity
    this.position = options.startingPosition ?? 0
    this.setpoint = { position: this.position, velocity: 0 }
  }

  /** Start the profile from where the mechanism is now, and clear the PID's memory. */
  restart(): void {
    this.setpoint = { position: this.position, velocity: this.velocity }
    this.integral = 0
    this.prevError = 0
  }

  /** The feedforward to go from one setpoint velocity to the next over a loop, as WPILib's calculate(current, next). */
  private feedforward(position: number, velocity: number, nextVelocity: number, dt: number): number {
    const g = this.gains
    const gravity = this.kind === "arm" ? g.kG * Math.cos(position) : this.kind === "elevator" ? g.kG : 0
    const staticComponent = g.kS * Math.sign(velocity)
    const kV = g.kV * this.feedforwardUnitsPerSimUnit
    const kA = g.kA * this.feedforwardUnitsPerSimUnit
    let motion: number
    if (kA === 0) motion = kV * nextVelocity
    else if (kV === 0) motion = (kA * (nextVelocity - velocity)) / dt
    else {
      const decay = Math.exp((-kV / kA) * dt)
      motion = (kV * (nextVelocity - decay * velocity)) / (1 - decay)
    }
    return staticComponent + motion + gravity
  }

  private pid(error: number, dt: number): number {
    const g = this.gains
    const scaled = error * this.pidUnitsPerSimUnit
    this.integral += scaled * dt
    const derivative = (scaled - this.prevError) / dt
    this.prevError = scaled
    return g.kP * scaled + g.kI * this.integral + g.kD * derivative
  }

  /** The voltage to follow a profile toward a position goal for one loop. */
  positionControl(goal: number, dt: number, measured = this.position): number {
    let next: ProfileState
    if (this.maxVelocity === 0 && this.maxAcceleration === 0) next = { position: goal, velocity: 0 }
    else if (this.maxVelocity <= 0 || this.maxAcceleration <= 0) next = { position: this.setpoint.position, velocity: 0 }
    else next = new TrapezoidProfile(this.maxVelocity, this.maxAcceleration).calculate(dt, this.setpoint, { position: goal, velocity: 0 })
    const ff = this.feedforward(this.setpoint.position, this.setpoint.velocity, next.velocity, dt)
    this.setpoint = next
    return ff + this.pid(next.position - measured, dt)
  }

  /** The voltage to hold a velocity for one loop. */
  velocityControl(goal: number, dt: number, measured = this.velocity): number {
    this.setpoint = { position: this.position, velocity: goal }
    return this.pid(goal - measured, dt) + this.feedforward(this.position, goal, goal, dt)
  }

  /** The voltage the motor controllers let through: each motor within its stator and supply limits. */
  private limitVoltage(voltage: number, backEmf: number): number {
    const R = this.motor.R
    let limited = voltage
    if (this.statorCurrentLimit !== undefined) {
      const maxCurrent = this.statorCurrentLimit * this.motor.count
      limited = Math.max(backEmf - maxCurrent * R, Math.min(backEmf + maxCurrent * R, limited))
    }
    if (this.supplyCurrentLimit !== undefined && this.batteryVoltage > 0) {
      const direction = Math.sign(limited) || 1
      const maxSupply = this.supplyCurrentLimit * this.motor.count
      const emf = backEmf * direction
      const maxVoltage = (emf + Math.sqrt(emf * emf + 4 * maxSupply * R * this.batteryVoltage)) / 2
      limited = direction * Math.min(limited * direction, maxVoltage)
    }
    return limited
  }

  /**
   * Step the motor one loop with a load torque held for the loop. Velocities are in rad/s at the mechanism.
   * This solves the motor's speed exactly, where explicit Euler goes unstable for a high gearing on a small inertia.
   */
  private stepMotor(commanded: number, velocity: number, inertia: number, loadTorque: number, dt: number) {
    const kt = this.motor.kt
    const R = this.motor.R
    const voltsPerRadPerSec = 60 / (2 * Math.PI) / this.motor.kv
    const freeSpeed = NOMINAL_VOLTAGE / voltsPerRadPerSec
    const friction = (kt * this.motor.freeCurrent * this.motor.count) / freeSpeed
    const damping = (kt * voltsPerRadPerSec) / R + friction
    const rate = damping / inertia
    const substeps = Math.max(1, Math.round(dt / CURRENT_LIMIT_PERIOD))
    const h = dt / substeps
    const decay = Math.exp(-rate * h)
    let next = velocity
    let distance = 0
    for (let i = 0; i < substeps; i++) {
      this.voltage = this.limitVoltage(Math.max(-this.batteryVoltage, Math.min(this.batteryVoltage, commanded)), voltsPerRadPerSec * next)
      const settled = ((kt * this.voltage) / R - loadTorque) / damping
      distance += settled * h + ((next - settled) * (1 - decay)) / rate
      next = settled + (next - settled) * decay
      this.current = (this.voltage - voltsPerRadPerSec * next) / R
      this.supplyCurrent = this.batteryVoltage > 0 ? (this.current * this.voltage) / this.batteryVoltage : 0
      this.batteryVoltage = Math.max(0, NOMINAL_VOLTAGE - BATTERY_RESISTANCE * this.supplyCurrent)
    }
    return { velocity: next, distance }
  }

  /** Apply a voltage for one loop. `maxPosition` may be lowered for one step by an obstacle. */
  step(voltage: number, dt: number, maxPosition = this.maxPosition): void {
    if (this.kind === "elevator") {
      const r = this.drumRadius
      const step = this.stepMotor(voltage, this.velocity / r, this.mass * r * r, this.mass * G * r, dt)
      this.velocity = step.velocity * r
      this.position += step.distance * r
    } else {
      const gravity = this.kind === "arm" ? this.mass * G * (this.length / 2) * Math.cos(this.position) : 0
      const step = this.stepMotor(voltage, this.velocity, this.moi, gravity, dt)
      this.velocity = step.velocity
      this.position += step.distance
    }
    let stopped = false
    if (this.position < this.minPosition) {
      this.position = this.minPosition
      stopped = this.velocity < 0
      this.velocity = Math.max(0, this.velocity)
    }
    if (this.position > maxPosition) {
      this.position = maxPosition
      stopped = stopped || this.velocity > 0
      this.velocity = Math.min(0, this.velocity)
    }
    if (stopped) {
      // Against a hard stop the motor is not turning, so it has no back-EMF: the current is the voltage over
      // the resistance, not what the speed it never reached would give.
      this.current = this.voltage / this.motor.R
      this.supplyCurrent = this.batteryVoltage > 0 ? (this.current * this.voltage) / this.batteryVoltage : 0
    }
  }
}
