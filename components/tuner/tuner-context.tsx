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
  DEFAULT_FLYWHEEL_RANGE,
  type FlywheelRange,
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

/** verify: range of motion. voltage: the inversion check. jog: driving with voltage once setup is done. tune: Live Tuning. */
export type SessionPurpose = "verify" | "voltage" | "jog" | "tune"

export type InversionCheck = "pending" | "passed" | "skipped"

/** Zeroes the tuning voltage and hands the motor back to the closed loop. Safe on YAMS versions without it. */
function releaseVoltage(nt: LiveNT, name: string) {
  const t = yamsTopics(name)
  if (nt.isAnnounced(t.tuning.voltageSetpoint)) nt.set(t.tuning.voltageSetpoint, 0)
  if (nt.isAnnounced(t.tuning.voltageEnabled)) nt.set(t.tuning.voltageEnabled, false)
}

/**
 * What holds the mechanism between drives during range-of-motion verification: 0 V, so the closed loop never runs, or
 * the closed loop, which is only safe once its gains are tuned.
 */
export type VerifyHold = "zeroVolts" | "closedLoop"

/** Applies 0 V in voltage mode: the motor is driven by nothing, as if disabled, and the closed loop does not run. */
function holdAtZeroVolts(nt: LiveNT, name: string) {
  const t = yamsTopics(name)
  if (nt.isAnnounced(t.tuning.voltageSetpoint)) nt.set(t.tuning.voltageSetpoint, 0)
  if (nt.isAnnounced(t.tuning.voltageEnabled)) nt.set(t.tuning.voltageEnabled, true)
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
  /** The range the range step found, before any change from the Settings card's Tuner tab. */
  foundRange: VerifiedRange
  /** Changes the allowed range from the Settings card's Tuner tab, keeping what the range step found. */
  overrideVerifiedBound: (side: "lower" | "upper", value: number) => void
  rangeVerified: boolean
  requiresRangeVerification: boolean
  /** Mechanism has a finite range of travel (elevator, arm, non-continuous pivot). */
  positional: boolean
  /** Connected to a simulation on this machine. */
  isSimulation: boolean

  /** Continue was pressed on the mechanism step. */
  mechanismConfirmed: boolean
  setMechanismConfirmed: (v: boolean) => void
  checklistConfirmed: boolean
  setChecklistConfirmed: (v: boolean) => void
  stallCurrent: number
  setStallCurrent: (amps: number) => void
  /** A flywheel's slider range in RPM. Velocity setpoints are clamped to it. Starts at the safety default. */
  flywheelRange: FlywheelRange
  setFlywheelRange: (range: FlywheelRange) => void

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
  /** What holds the mechanism between drives while verifying the range of motion. */
  verifyHold: VerifyHold
  setVerifyHold: (v: VerifyHold) => void
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
  const [foundRange, setFoundRange] = useState<VerifiedRange>({ lower: null, upper: null })
  const [mechanismConfirmed, setMechanismConfirmed] = useState(false)
  const [checklistConfirmed, setChecklistConfirmed] = useState(false)
  const [stallCurrent, setStallCurrent] = useState(DEFAULT_STALL_CURRENT)
  const [flywheelRange, setFlywheelRange] = useState<FlywheelRange>(DEFAULT_FLYWHEEL_RANGE)
  const [session, setSession] = useState<SessionPurpose | null>(null)
  const [lastStop, setLastStop] = useState<StopEvent | null>(null)
  const [currentAsWarning, setCurrentAsWarning] = useState(false)
  const [rangeSkipped, setRangeSkipped] = useState(false)
  // The range is usually verified before the gains are tuned, and an untuned closed loop can oscillate or run away.
  const [verifyHold, setVerifyHold] = useState<VerifyHold>("zeroVolts")
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
    status === "connected" && !!mechanismName && !!commandName && mechanismConfirmed && rangeVerified && checklistConfirmed && inversionCheck !== "pending"

  // Anything that changes what is being moved invalidates every safety confirmation.
  const resetSafety = useCallback(() => {
    setVerified({ lower: null, upper: null })
    setFoundRange({ lower: null, upper: null })
    setMechanismConfirmed(false)
    setChecklistConfirmed(false)
    setCurrentAsWarning(false)
    setRangeSkipped(false)
    setInversionCheck("pending")
  }, [])

  const liveValues = {
    mechanismName,
    commandName,
    kind,
    axis,
    verified,
    session,
    stallCurrent,
    positional,
    isSimulation,
    currentAsWarning,
    verifyHold,
  }
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
      const { mechanismName: name, commandName: cmd, kind: k, axis: ax, session: was, verifyHold: hold } = live.current
      stopGeneration.current++
      setSession(null)
      setLastStop({ reason, at: Date.now(), fault, cause })
      if (!name) return
      if (((was === "verify" && hold === "zeroVolts") || was === "voltage" || was === "jog") && k !== "flywheel") {
        // Checking inversions, driving with voltage, or verifying at 0 V: the closed loop may be untuned, so stay at 0 V until the command
        // has ended.
        holdAtZeroVolts(nt, name)
        if (cmd) nt.set(liveTuningCommandTopic(cmd), false)
        setTimeout(() => releaseVoltage(nt, name), 100)
        return
      }
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
      if (nt.getStatus() !== "connected") return "Connect to the robot first."
      if (!name) return "Choose a mechanism first."
      if (!cmd) return "Choose the subsystem’s Live Tuning command first."
      const state = decodeControlWord(nt.get(CONTROL_WORD))
      if (!state?.enabled) return "Enable the robot from the Driver Station first (Teleop or Test)."
      if (state.eStop) return "The robot is E-stopped. Restart the robot to clear the E-stop, then start again."
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
        // Checking inversions, or verifying at 0 V: voltage mode is on before the command starts, so the closed loop,
        // which may be untuned, never runs.
        if (purpose === "voltage" || purpose === "jog" || (purpose === "verify" && live.current.verifyHold === "zeroVolts")) holdAtZeroVolts(nt, name)
      }
      startingRef.current = true
      setStarting(true)
      try {
        await sleep(150)
        if (cancelled()) return "Start cancelled. Press Start again when you’re ready."
        if (nt.getStatus() !== "connected") return "Lost connection while starting. Reconnect, then start again."
        nt.set(commandTopic, true)

        const deadline = Date.now() + 1500
        while (Date.now() < deadline) {
          await sleep(50)
          if (cancelled()) {
            nt.set(commandTopic, false)
            return "Start cancelled. Press Start again when you’re ready."
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

  /**
   * A session that starts with the mechanism outside its range, say an arm that sagged below it while disabled, is
   * allowed to bring it back: it may move back toward the range, never further out. Back inside, the usual rule applies.
   * "unchecked" until the session's first position check.
   */
  const escape = useRef<"unchecked" | null | { side: "below" | "above"; worst: number }>("unchecked")

  // Safety watchdog: runs while a session we started is active.
  useEffect(() => {
    if (!session) {
      escape.current = "unchecked"
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
        setLastStop({ reason: "Connection to the robot was lost, and it keeps its last setpoint until disabled. Disable it from the Driver Station, then reconnect.", at: Date.now(), fault: true })
        return
      }
      const state = decodeControlWord(nt.get(CONTROL_WORD))
      if (!state?.enabled) {
        setSession(null)
        setLastStop({ reason: "Robot was disabled, so everything stopped. Enable it, then start again.", at: Date.now(), fault: false })
        return
      }
      const running = nt.get<boolean>(liveTuningCommandTopic(cur.commandName))
      if (running === true) sawRunning = true
      else if (sawRunning) {
        setSession(null)
        setLastStop({ reason: "The Live Tuning command ended on the robot, so everything stopped. Another command may have taken the subsystem. Start again.", at: Date.now(), fault: true })
        return
      }
      const reader = axisReader(nt, cur.mechanismName, cur.axis)
      const amps = reader.statorCurrent()
      if (amps !== undefined && Math.abs(amps) > cur.stallCurrent) {
        overCurrentSince ??= Date.now()
        if (Date.now() - overCurrentSince > STALL_DEBOUNCE_MS) {
          if (cur.currentAsWarning) {
            // Fixed text: the live amps would re-render the page every tick.
            showCurrentWarning(`Stator current is above the ${cur.stallCurrent} A current trip. Over-current is set to warn only.`)
          } else {
            stop(`Stator current ${Math.abs(amps).toFixed(0)} A exceeded the ${cur.stallCurrent} A current trip.`, true, "overcurrent")
            return
          }
        }
      } else {
        overCurrentSince = null
        showCurrentWarning(null)
      }

      // Verifying the range may go outside it: finding where the mechanism really ends is the point.
      if (cur.positional && cur.session !== "verify") {
        const pos = reader.position()
        if (pos === undefined) return
        const tol = overshootTolerance(cur.axis)
        // Once a range is verified it bounds travel; otherwise the robot's soft limits do.
        const useVerified = cur.verified.lower !== null && cur.verified.upper !== null
        const lower = useVerified ? cur.verified.lower : reader.lowerLimit()
        const upper = useVerified ? cur.verified.upper : reader.upperLimit()
        const below = lower !== null && lower !== undefined && pos < lower - tol
        const above = upper !== null && upper !== undefined && pos > upper + tol
        const range = useVerified ? "verified range" : "soft limits"
        if (escape.current === "unchecked") escape.current = below ? { side: "below", worst: pos } : above ? { side: "above", worst: pos } : null
        const e = escape.current
        if (e) {
          const outside = e.side === "below" ? below : above
          if (!outside) {
            // Back inside: from here on, leaving the range stops as usual.
            escape.current = null
          } else {
            const bound = formatPosition((e.side === "below" ? lower : upper) as number, cur.axis)
            const end = `${e.side === "below" ? "lower" : "upper"} end ${bound}`
            const further = e.side === "below" ? pos < e.worst - tol : pos > e.worst + tol
            if (further && !cur.isSimulation) {
              stop(
                `Stopped: the mechanism moved further ${e.side} the ${range} (${end}) instead of back toward it. Send a setpoint inside the range, or drive it back on the Voltage tab.`,
                true,
              )
              return
            }
            // The closest it has come back: sagging back out past that, beyond the tolerance, counts as moving further.
            e.worst = e.side === "below" ? Math.max(e.worst, pos) : Math.min(e.worst, pos)
            showWarning(
              `The mechanism is ${e.side} the ${range} (${end}). Bring it back inside: send a setpoint inside the range, or drive it back on the Voltage tab. Moving it further out stops.`,
            )
            return
          }
        }
        if (below || above) {
          const bound = formatPosition((below ? lower : upper) as number, cur.axis)
          const where = `${below ? "below" : "above"} the ${range} (${below ? "lower" : "upper"} end ${bound})`
          // A simulated mechanism cannot break anything, so only warn and keep tuning.
          if (cur.isSimulation) showWarning(`The mechanism is ${where}. On a real robot this would stop it.`)
          else
            stop(
              `Stopped: the mechanism went ${where}. Start again to bring it back: a setpoint inside the range, or driving back on the Voltage tab, is allowed. Or change the range on the Settings card’s Tuner tab.`,
              true,
            )
        } else showWarning(null)
      } else showWarning(null)
    }, 20)
    return () => clearInterval(id)
  }, [session, nt, stop])

  // Leaving the page must not leave anything moving.
  useEffect(() => {
    const onLeave = () => {
      const { session, commandName, mechanismName } = live.current
      if (!session) return
      stop("Page closed")
      // A closing page never runs stop's timers, so end Live Tuning and voltage mode now, before the page goes: stop
      // has already set the setpoint to where the mechanism is.
      if (commandName) nt.set(liveTuningCommandTopic(commandName), false)
      if (mechanismName) releaseVoltage(nt, mechanismName)
    }
    window.addEventListener("pagehide", onLeave)
    return () => window.removeEventListener("pagehide", onLeave)
  }, [stop, nt])

  // Space (and Esc) always stops. While anything runs, Space is the stop key everywhere on the page: it is swallowed in
  // the capture phase and can never activate a focused control such as the Start button. While nothing runs it still
  // ticks checkboxes and flips switches.
  useEffect(() => {
    const isSpace = (e: KeyboardEvent) => e.code === "Space" || e.key === " "
    const isTextField = (el: EventTarget | null) => {
      if (!(el instanceof HTMLElement)) return false
      if (el.isContentEditable || el instanceof HTMLTextAreaElement) return true
      return el instanceof HTMLInputElement && ["text", "search", "url", "email"].includes(el.type)
    }
    // When nothing is running, Space ticks checkboxes and flips switches as usual, so the page works from the keyboard.
    const isToggle = (el: EventTarget | null) =>
      el instanceof HTMLElement &&
      el.matches('input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="switch"], [role="radio"]')
    const isCheckbox = (el: EventTarget | null) =>
      el instanceof HTMLElement && el.matches('input[type="checkbox"], [role="checkbox"]')
    const isActive = () => {
      const cur = live.current
      if (cur.session || startingRef.current) return true
      return !!cur.commandName && nt.get<boolean>(liveTuningCommandTopic(cur.commandName)) === true
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (isSpace(e)) {
        const active = isActive()
        // Typing a space into a text field, or ticking a box with it, is only allowed while nothing is running.
        if (!active && (isTextField(e.target) || isToggle(e.target))) return
        e.preventDefault()
        e.stopPropagation()
        if (active) stop("Stopped with Space")
        return
      }
      // While something runs Space is taken, so Enter ticks a checkbox too.
      if (e.key === "Enter" && !e.repeat && isCheckbox(e.target)) {
        e.preventDefault()
        ;(e.target as HTMLElement).click()
        return
      }
      if (e.key === "Escape" && isActive()) {
        e.preventDefault()
        stop("Stopped with Esc")
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (isSpace(e) && !isTextField(e.target) && !(isToggle(e.target) && !isActive())) {
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
    setFoundRange((v) => ({ ...v, [side]: value }))
  }, [])
  const overrideVerifiedBound = useCallback((side: "lower" | "upper", value: number) => {
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
    foundRange,
    overrideVerifiedBound,
      rangeVerified,
      positional,
      isSimulation,
    requiresRangeVerification,
    mechanismConfirmed,
    setMechanismConfirmed,
    checklistConfirmed,
    setChecklistConfirmed,
    stallCurrent,
    setStallCurrent,
    flywheelRange,
    setFlywheelRange,
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
    verifyHold,
    setVerifyHold,
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
