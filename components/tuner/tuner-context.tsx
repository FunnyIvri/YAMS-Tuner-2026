"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import { LiveNT, decodeControlWord, isLoopbackHost, targetHost, type ConnectionStatus, type LiveTarget, type RobotState } from "@/lib/nt/live-nt"
import {
  CONTROL_WORD,
  SUBSCRIBE_PREFIXES,
  axisReader,
  detectAxis,
  formatPosition,
  liveTuningCommandTopic,
  yamsTopics,
  type Axis,
  type MechanismKind,
} from "@/lib/yams/topics"
import {
  DEFAULT_FLYWHEEL_MAX_RPM,
  DEFAULT_STALL_CURRENT,
  FLYWHEEL_IDLE_VELOCITY,
  STALL_DEBOUNCE_MS,
  needsRangeVerification,
  overshootTolerance,
} from "@/lib/yams/safety"

const TEAM_KEY = "yams-tuner-team"

export interface VerifiedRange {
  lower: number | null
  upper: number | null
}

export type SessionPurpose = "verify" | "voltage" | "tune"

export type InversionCheck = "pending" | "passed" | "skipped"

/** Zeroes the tuning voltage and hands the motor back to the closed loop. Safe on YAMS versions without it. */
function releaseVoltage(nt: LiveNT, name: string) {
  const t = yamsTopics(name)
  if (nt.isAnnounced(t.tuning.voltageSetpoint)) nt.set(t.tuning.voltageSetpoint, 0)
  if (nt.isAnnounced(t.tuning.voltageEnabled)) nt.set(t.tuning.voltageEnabled, false)
}

export interface StopEvent {
  reason: string
  at: number
  /** Stops the operator asked for are not faults. */
  fault: boolean
  /** Set for stops that the operator may downgrade to a warning. */
  cause?: "overcurrent"
}

interface TunerApi {
  nt: LiveNT
  status: ConnectionStatus
  host: string | null
  team: string
  setTeam: (team: string) => void
  connect: (target: LiveTarget) => Promise<string | null>
  disconnect: () => void

  mechanismName: string | null
  setMechanismName: (name: string | null) => void
  commandName: string | null
  setCommandName: (name: string | null) => void
  kind: MechanismKind
  setKind: (kind: MechanismKind) => void
  continuous: boolean
  setContinuous: (continuous: boolean) => void
  axis: Axis

  verified: VerifiedRange
  setVerifiedBound: (side: "lower" | "upper", value: number | null) => void
  rangeVerified: boolean
  requiresRangeVerification: boolean
  /** Mechanism has a finite range of travel (elevator, arm, non-continuous pivot). */
  positional: boolean
  /** Connected to a simulation on this machine. */
  isSimulation: boolean

  checklistConfirmed: boolean
  setChecklistConfirmed: (v: boolean) => void
  stallCurrent: number
  setStallCurrent: (amps: number) => void
  flywheelMaxRpm: number
  setFlywheelMaxRpm: (rpm: number) => void

  session: SessionPurpose | null
  starting: boolean
  startLiveTuning: (purpose: SessionPurpose) => Promise<string | null>
  stop: (reason?: string, fault?: boolean, cause?: StopEvent["cause"]) => void
  lastStop: StopEvent | null
  clearLastStop: () => void
  /** Simulation only: the mechanism is outside its range, which would be a fault stop on a real robot. */
  rangeWarning: string | null
  /** The stator limit only warns instead of stopping (opted into after an over-current fault). */
  currentAsWarning: boolean
  setCurrentAsWarning: (v: boolean) => void
  currentWarning: string | null
  /** The operator explicitly skipped range-of-motion verification and accepted the risk. */
  rangeSkipped: boolean
  setRangeSkipped: (v: boolean) => void
  /** Voltage-driven motor/encoder/follower inversion check, done once during setup. */
  inversionCheck: InversionCheck
  setInversionCheck: (v: InversionCheck) => void
  /** Setpoint control is allowed: checklist done, range verified (or not required), inversion checked or skipped. */
  tuningUnlocked: boolean
}

const TunerContext = createContext<TunerApi | null>(null)

function readStorage(key: string) {
  try {
    return window.localStorage.getItem(key) ?? ""
  } catch {
    return ""
  }
}

function writeStorage(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Storage can be unavailable in private windows; the team number just isn't remembered.
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function TunerProvider({ children }: { children: ReactNode }) {
  const ntRef = useRef<LiveNT | null>(null)
  if (ntRef.current === null) ntRef.current = new LiveNT()
  const nt = ntRef.current

  const status = useSyncExternalStore(nt.subscribe, nt.getStatus, () => "idle" as ConnectionStatus)
  const host = useSyncExternalStore(nt.subscribe, nt.getHost, () => null)
  const version = useSyncExternalStore(nt.subscribe, nt.getVersion, () => 0)

  const [team, setTeamState] = useState("")
  const [mechanismName, setMechanismNameState] = useState<string | null>(null)
  const [commandName, setCommandName] = useState<string | null>(null)
  const [kind, setKindState] = useState<MechanismKind>("arm")
  const [continuous, setContinuousState] = useState(false)
  const [verified, setVerified] = useState<VerifiedRange>({ lower: null, upper: null })
  const [checklistConfirmed, setChecklistConfirmed] = useState(false)
  const [stallCurrent, setStallCurrent] = useState(DEFAULT_STALL_CURRENT)
  const [flywheelMaxRpm, setFlywheelMaxRpm] = useState(DEFAULT_FLYWHEEL_MAX_RPM)
  const [session, setSession] = useState<SessionPurpose | null>(null)
  const [lastStop, setLastStop] = useState<StopEvent | null>(null)
  const [currentAsWarning, setCurrentAsWarning] = useState(false)
  const [rangeSkipped, setRangeSkipped] = useState(false)
  const [inversionCheck, setInversionCheck] = useState<InversionCheck>("pending")

  useEffect(() => {
    setTeamState(readStorage(TEAM_KEY))
  }, [])

  const axis: Axis = useMemo(
    () => (mechanismName ? detectAxis(nt, mechanismName) : "rotary"),
    // The unit property arrives with the topic announcement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nt, mechanismName, version],
  )

  const isSimulation = !!host && isLoopbackHost(host)
  const positional = needsRangeVerification(kind, continuous)
  const requiresRangeVerification = positional
  const rangeVerified = !requiresRangeVerification || rangeSkipped || (verified.lower !== null && verified.upper !== null)
  const tuningUnlocked =
    status === "connected" && !!mechanismName && !!commandName && rangeVerified && checklistConfirmed && inversionCheck !== "pending"

  // Anything that changes what is being moved invalidates every safety confirmation.
  const resetSafety = useCallback(() => {
    setVerified({ lower: null, upper: null })
    setChecklistConfirmed(false)
    setCurrentAsWarning(false)
    setRangeSkipped(false)
    setInversionCheck("pending")
  }, [])

  const liveValues = { mechanismName, commandName, kind, axis, verified, session, stallCurrent, positional, isSimulation, currentAsWarning }
  const live = useRef(liveValues)
  live.current = liveValues
  const [rangeWarning, setRangeWarning] = useState<string | null>(null)
  const [currentWarning, setCurrentWarning] = useState<string | null>(null)

  // Bumped by every stop so a start that is still in flight aborts instead of finishing.
  const stopGeneration = useRef(0)
  const startingRef = useRef(false)
  const [starting, setStarting] = useState(false)

  const stop = useCallback(
    (reason = "Stopped by operator", fault = false, cause?: StopEvent["cause"]) => {
      const { mechanismName: name, commandName: cmd, kind: k, axis: ax } = live.current
      stopGeneration.current++
      setSession(null)
      setLastStop({ reason, at: Date.now(), fault, cause })
      if (!name) return
      // Open-loop voltage is the most dangerous output, so it is always released first.
      releaseVoltage(nt, name)
      const t = yamsTopics(name)
      const reader = axisReader(nt, name, ax)
      const cancel = () => {
        if (cmd) nt.set(liveTuningCommandTopic(cmd), false)
      }
      if (k === "flywheel") {
        // Command ~0 velocity and let it spin down under closed loop before handing the subsystem back.
        nt.set(t.tuning.setpointVelocity, FLYWHEEL_IDLE_VELOCITY)
        const started = Date.now()
        const poll = setInterval(() => {
          const v = reader.velocity()
          if (v === undefined || Math.abs(v) < 60 || Date.now() - started > 4000 || nt.getStatus() !== "connected") {
            clearInterval(poll)
            cancel()
          }
        }, 50)
        return
      }
      const pos = reader.position()
      nt.set(t.tuning.setpointVelocity, 0)
      if (pos !== undefined) nt.set(t.tuning.setpointPosition, pos)
      setTimeout(cancel, 100)
    },
    [nt],
  )

  const startLiveTuning = useCallback(
    async (purpose: SessionPurpose): Promise<string | null> => {
      const { mechanismName: name, commandName: cmd, kind: k, axis: ax } = live.current
      if (nt.getStatus() !== "connected") return "Not connected to the robot."
      if (!name) return "Choose a mechanism first."
      if (!cmd) return "Choose the subsystem's Live Tuning command first."
      const state = decodeControlWord(nt.get(CONTROL_WORD))
      if (!state?.enabled) return "Enable the robot from the Driver Station first (Teleop or Test)."
      if (state.eStop) return "The robot is E-stopped."
      const t = yamsTopics(name)
      const reader = axisReader(nt, name, ax)
      const commandTopic = liveTuningCommandTopic(cmd)
      const generation = stopGeneration.current
      const cancelled = () => stopGeneration.current !== generation

      // YAMS applies the tunable setpoint every loop as soon as the command runs, and it defaults to 0.
      // Seed it with where the mechanism is right now so starting never moves anything.
      // A voltage left on from an earlier session would be applied as soon as the command runs.
      releaseVoltage(nt, name)
      if (k === "flywheel") {
        nt.set(t.tuning.setpointVelocity, FLYWHEEL_IDLE_VELOCITY)
      } else {
        const pos = reader.position()
        if (pos === undefined) return "No position telemetry. Set the telemetry verbosity to HIGH on the robot."
        nt.set(t.tuning.setpointVelocity, 0)
        nt.set(t.tuning.setpointPosition, pos)
      }
      startingRef.current = true
      setStarting(true)
      try {
        await sleep(150)
        if (cancelled()) return "Start cancelled."
        if (nt.getStatus() !== "connected") return "Lost connection while starting."
        nt.set(commandTopic, true)

        const deadline = Date.now() + 1500
        while (Date.now() < deadline) {
          await sleep(50)
          if (cancelled()) {
            nt.set(commandTopic, false)
            return "Start cancelled."
          }
          if (nt.get<boolean>(commandTopic) === true) {
            setLastStop(null)
            setSession(purpose)
            return null
          }
        }
        nt.set(commandTopic, false)
        return "The Live Tuning command did not start. Make sure the robot is enabled and nothing else is requiring the subsystem."
      } finally {
        startingRef.current = false
        setStarting(false)
      }
    },
    [nt],
  )

  // Safety watchdog: runs while a session we started is active.
  useEffect(() => {
    if (!session) {
      setRangeWarning(null)
      setCurrentWarning(null)
      return
    }
    let overCurrentSince: number | null = null
    let sawRunning = false
    let warning: string | null = null
    let ampWarning: string | null = null
    const showWarning = (next: string | null) => {
      if (next === warning) return
      warning = next
      setRangeWarning(next)
    }
    const showCurrentWarning = (next: string | null) => {
      if (next === ampWarning) return
      ampWarning = next
      setCurrentWarning(next)
    }
    const id = setInterval(() => {
      const cur = live.current
      if (!cur.mechanismName || !cur.commandName) return
      if (nt.getStatus() !== "connected") {
        setSession(null)
        setLastStop({ reason: "Connection to the robot was lost. The robot keeps its last setpoint until disabled.", at: Date.now(), fault: true })
        return
      }
      const state = decodeControlWord(nt.get(CONTROL_WORD))
      if (!state?.enabled) {
        setSession(null)
        setLastStop({ reason: "Robot was disabled. Live Tuning ended.", at: Date.now(), fault: false })
        return
      }
      const running = nt.get<boolean>(liveTuningCommandTopic(cur.commandName))
      if (running === true) sawRunning = true
      else if (sawRunning) {
        setSession(null)
        setLastStop({ reason: "The Live Tuning command ended on the robot.", at: Date.now(), fault: true })
        return
      }
      const reader = axisReader(nt, cur.mechanismName, cur.axis)
      const amps = reader.statorCurrent()
      if (amps !== undefined && Math.abs(amps) > cur.stallCurrent) {
        overCurrentSince ??= Date.now()
        if (Date.now() - overCurrentSince > STALL_DEBOUNCE_MS) {
          if (cur.currentAsWarning) {
            // Fixed text: the live amps would re-render the page every tick.
            showCurrentWarning(`Stator current is above the ${cur.stallCurrent} A limit. Over-current is set to warn only.`)
          } else {
            stop(`Stator current ${Math.abs(amps).toFixed(0)} A exceeded the ${cur.stallCurrent} A limit.`, true, "overcurrent")
            return
          }
        }
      } else {
        overCurrentSince = null
        showCurrentWarning(null)
      }

      if (cur.positional) {
        const pos = reader.position()
        if (pos === undefined) return
        const tol = overshootTolerance(cur.axis)
        // Once a range is verified it bounds travel; otherwise (verifying, or simulation) the robot's soft limits do.
        const useVerified = cur.session !== "verify" && cur.verified.lower !== null && cur.verified.upper !== null
        const lower = useVerified ? cur.verified.lower : reader.lowerLimit()
        const upper = useVerified ? cur.verified.upper : reader.upperLimit()
        const below = lower !== null && lower !== undefined && pos < lower - tol
        const above = upper !== null && upper !== undefined && pos > upper + tol
        if (below || above) {
          // A simulated mechanism cannot break anything, so only warn and keep tuning.
          if (cur.isSimulation) {
            const bound = formatPosition((below ? lower : upper) as number, cur.axis)
            showWarning(
              `Mechanism is ${below ? "below" : "above"} its range of motion (${below ? "lower" : "upper"} limit ${bound}). On a real robot this would stop Live Tuning.`,
            )
          } else stop("Mechanism left its allowed range of motion.", true)
        } else showWarning(null)
      }
    }, 20)
    return () => clearInterval(id)
  }, [session, nt, stop])

  // Leaving the page must not leave anything moving.
  useEffect(() => {
    const onLeave = () => {
      if (live.current.session) stop("Page closed")
    }
    window.addEventListener("pagehide", onLeave)
    return () => window.removeEventListener("pagehide", onLeave)
  }, [stop])

  // Space (and Esc) always stops. Space is reserved as the stop key everywhere on the page, so it is swallowed
  // in the capture phase and can never activate a focused control such as the Start button.
  useEffect(() => {
    const isSpace = (e: KeyboardEvent) => e.code === "Space" || e.key === " "
    const isTextField = (el: EventTarget | null) => {
      if (!(el instanceof HTMLElement)) return false
      if (el.isContentEditable || el instanceof HTMLTextAreaElement) return true
      return el instanceof HTMLInputElement && ["text", "search", "url", "email"].includes(el.type)
    }
    const isActive = () => {
      const cur = live.current
      if (cur.session || startingRef.current) return true
      return !!cur.commandName && nt.get<boolean>(liveTuningCommandTopic(cur.commandName)) === true
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (isSpace(e)) {
        const active = isActive()
        // Typing a space into a text field is only allowed while nothing is running.
        if (!active && isTextField(e.target)) return
        e.preventDefault()
        e.stopPropagation()
        if (active) stop("Stopped with Space")
        return
      }
      if (e.key === "Escape" && isActive()) {
        e.preventDefault()
        stop("Stopped with Esc")
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (isSpace(e) && !isTextField(e.target)) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    window.addEventListener("keydown", onKeyDown, { capture: true })
    window.addEventListener("keyup", onKeyUp, { capture: true })
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true })
      window.removeEventListener("keyup", onKeyUp, { capture: true })
    }
  }, [nt, stop])

  useEffect(() => () => nt.disconnect(), [nt])

  const connect = useCallback(
    async (target: LiveTarget) => {
      const h = targetHost(target)
      if (!h) return target.kind === "robot" ? "Enter a valid team number." : "Enter a host name or IP address."
      if (live.current.session) stop("Reconnecting")
      resetSafety()
      setSession(null)
      await nt.connect(h, SUBSCRIBE_PREFIXES)
      return null
    },
    [nt, resetSafety, stop],
  )

  const disconnect = useCallback(() => {
    if (live.current.session) stop("Disconnected")
    // Give the stop writes a moment to flush before closing the socket.
    setTimeout(() => nt.disconnect(), 200)
    resetSafety()
  }, [nt, resetSafety, stop])

  const setTeam = useCallback((value: string) => {
    setTeamState(value)
    writeStorage(TEAM_KEY, value)
  }, [])

  const setMechanismName = useCallback(
    (name: string | null) => {
      if (live.current.session) stop("Mechanism changed")
      setMechanismNameState(name)
      resetSafety()
    },
    [resetSafety, stop],
  )

  const setKind = useCallback(
    (k: MechanismKind) => {
      if (live.current.session) stop("Mechanism type changed")
      setKindState(k)
      if (k !== "pivot") setContinuousState(false)
      resetSafety()
    },
    [resetSafety, stop],
  )

  const setContinuous = useCallback(
    (c: boolean) => {
      if (live.current.session) stop("Mechanism type changed")
      setContinuousState(c)
      resetSafety()
    },
    [resetSafety, stop],
  )

  const setVerifiedBound = useCallback((side: "lower" | "upper", value: number | null) => {
    setVerified((v) => ({ ...v, [side]: value }))
  }, [])

  const clearLastStop = useCallback(() => setLastStop(null), [])

  const api: TunerApi = {
    nt,
    status,
    host,
    team,
    setTeam,
    connect,
    disconnect,
    mechanismName,
    setMechanismName,
    commandName,
    setCommandName,
    kind,
    setKind,
    continuous,
    setContinuous,
    axis,
    verified,
    setVerifiedBound,
      rangeVerified,
      positional,
      isSimulation,
    requiresRangeVerification,
    checklistConfirmed,
    setChecklistConfirmed,
    stallCurrent,
    setStallCurrent,
    flywheelMaxRpm,
    setFlywheelMaxRpm,
    session,
    starting,
    startLiveTuning,
    stop,
    lastStop,
    clearLastStop,
    rangeWarning,
    currentAsWarning,
    setCurrentAsWarning,
    currentWarning,
    rangeSkipped,
    setRangeSkipped,
    inversionCheck,
    setInversionCheck,
    tuningUnlocked,
  }

  return <TunerContext.Provider value={api}>{children}</TunerContext.Provider>
}

export function useTuner(): TunerApi {
  const api = useContext(TunerContext)
  if (!api) throw new Error("useTuner must be used inside TunerProvider")
  return api
}

/** Re-renders at most once per animation frame whenever any value arrives. */
export function useNtVersion(): number {
  const { nt } = useTuner()
  return useSyncExternalStore(nt.subscribe, nt.getVersion, () => 0)
}

export function useNtValue<T>(topic: string | null): T | undefined {
  const { nt } = useTuner()
  return useSyncExternalStore(
    nt.subscribe,
    () => (topic ? nt.get<T>(topic) : undefined),
    () => undefined,
  )
}

export function useRobotState(): RobotState | null {
  const raw = useNtValue<Uint8Array>(CONTROL_WORD)
  return useMemo(() => decodeControlWord(raw), [raw])
}

/** Position, velocity and limits of the selected mechanism in setpoint units. */
export function useAxisValues() {
  const { nt, mechanismName, axis } = useTuner()
  useNtVersion()
  if (!mechanismName) return { position: undefined, velocity: undefined, lower: undefined, upper: undefined, current: undefined }
  const r = axisReader(nt, mechanismName, axis)
  return {
    position: r.position(),
    velocity: r.velocity(),
    lower: r.lowerLimit(),
    upper: r.upperLimit(),
    current: r.statorCurrent(),
  }
}
