"use client"

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { ChevronLeft, ChevronRight, Flag, Play } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useAxisValues, useNtValue, useTuner } from "@/components/tuner/tuner-context"
import { Kbd, Notice } from "@/components/tuner/panel"
import { TravelGauge } from "@/components/tuner/travel-gauge"
import { Hint } from "@/components/tuner/hint"
import { EditableBound } from "@/components/tuner/setpoint-panel"
import { axisReader, formatPosition, positionUnit, yamsTopics } from "@/lib/yams/topics"
import { jogParams, overshootTolerance, STALL_DEBOUNCE_MS } from "@/lib/yams/safety"
import { PAD_TYPES, readSticks, STICK_DEADBAND, type PadType, type Stick } from "@/lib/gamepad"

type Dir = -1 | 1
type Mode = "find" | "define"
type Side = "lower" | "upper"
/** What releasing a drive button does: cut the voltage to 0 at once, or ramp it down to 0. */
type Release = "cut" | "ramp"
/** What drives the mechanism: holding the on-screen buttons, or a game controller's stick. */
type DriveInput = "buttons" | "controller"

const DEFAULT_DRIVE_VOLTS = 1
const MIN_DRIVE_VOLTS = 0.25
const DEFAULT_MAX_DRIVE_VOLTS = 3
/** Battery voltage: nothing above this can be applied anyway. */
const HARD_LIMIT_VOLTS = 12
/** Voltage ramps from 0 to the drive voltage over this long, so a press never slams the mechanism. */
const RAMP_MS = 400
/** Within this many reach tolerances of a defined end, the drive voltage is halved to limit overshoot. */
const SLOW_ZONE_TOLERANCES = 8
/** How fast the voltage ramps down to 0 after a drive button is released, in ramp mode, in volts per second. */
const DEFAULT_RAMP_DOWN_VOLTS_PER_SECOND = 4
const MIN_RAMP_DOWN_VOLTS_PER_SECOND = 0.01
/** Lowering the ramp rate while the mechanism still goes up: below this, in volts per second, the ramp ends. */
const RAMP_RATE_CUTOFF = 0.0001
/** How often the drive and the ramp down send a voltage. */
const LOOP_MS = 20
/** Holding with the closed loop: moving this far from the hold position at any time means it is running away. */
const RUNAWAY_TOLERANCE = { linear: 0.1, rotary: 30 }
/** Holding with the closed loop: still this far off after HOLD_SETTLE_MS means the gains are not holding it. */
const HOLD_SETTLE_MS = 1000
/** The gravity hold voltage stays within this, in volts: it only has to balance the mechanism's weight. */
const MAX_GRAVITY_VOLTS = 3
/** One press of − or + on the gravity hold voltage. */
const GRAVITY_STEP_VOLTS = 0.02
/** Driving with a stick, below this fraction of the drive voltage a mechanism may just not move: no hard stop then. */
const STALL_CHECK_MIN_STICK = 0.9

const sideOf = (dir: Dir): Side => (dir > 0 ? "upper" : "lower")
const formatVolts = (v: number) => `${v.toFixed(2)} V`

export function VerificationBody({ skipControl }: { skipControl: ReactNode }) {
  const {
    nt,
    mechanismName,
    axis,
    kind,
    session,
    starting,
    startLiveTuning,
    stop,
    verified,
    setVerifiedBound,
    rangeVerified,
    lastStop,
    stallCurrent,
    currentAsWarning,
    verifyHold,
    setVerifyHold,
  } = useTuner()
  // Gravity pulls an elevator or an arm down when nothing drives it; a pivot or a turret it does not.
  const gravityLoaded = kind === "elevator" || kind === "arm"
  const { position, lower: softLower, upper: softUpper } = useAxisValues()
  const params = jogParams(axis)
  const unit = positionUnit(axis)
  const decimals = axis === "linear" ? 3 : 1
  const [negLabel, posLabel] = kind === "elevator" ? ["down", "up"] : ["reverse", "forward"]

  const topics = mechanismName ? yamsTopics(mechanismName) : null
  // Subscribing re-renders when the topic is announced by a YAMS version that supports it.
  useNtValue<boolean>(topics?.tuning.voltageEnabled ?? null)
  const supported = !!topics && nt.isAnnounced(topics.tuning.voltageEnabled) && nt.isAnnounced(topics.tuning.voltageSetpoint)

  const [mode, setMode] = useState<Mode>("find")
  const [driveVolts, setDriveVolts] = useState(DEFAULT_DRIVE_VOLTS)
  const [maxDriveVolts, setMaxDriveVolts] = useState(DEFAULT_MAX_DRIVE_VOLTS)
  const [minDriveVolts, setMinDriveVolts] = useState(MIN_DRIVE_VOLTS)
  const [appliedVolts, setAppliedVolts] = useState(0)
  // An arm swings under gravity when the voltage is cut, so it ramps down by default.
  const [release, setRelease] = useState<Release>(kind === "arm" ? "ramp" : "cut")
  useEffect(() => setRelease(kind === "arm" ? "ramp" : "cut"), [kind])
  const [rampDownRate, setRampDownRate] = useState(DEFAULT_RAMP_DOWN_VOLTS_PER_SECOND)
  const [rampDownText, setRampDownText] = useState(String(DEFAULT_RAMP_DOWN_VOLTS_PER_SECOND))
  /** The voltage is ramping down to 0 after a release. */
  const [rampingDown, setRampingDown] = useState(false)
  /** The ramp's rate right now, lowered while the mechanism keeps going up after a release. */
  const [rampRateNow, setRampRateNow] = useState(DEFAULT_RAMP_DOWN_VOLTS_PER_SECOND)
  /**
   * Holding with voltage: the voltage that balances the mechanism's weight, sent between drives instead of 0 V. For an
   * arm it is the voltage that holds it level, scaled by the cosine of its angle, like kG.
   */
  const [gravityVolts, setGravityVolts] = useState(0)
  const [driveInput, setDriveInput] = useState<DriveInput>("buttons")
  /** The controller the browser reports, both sticks and which one is driving, for the preview. */
  const [pad, setPad] = useState<{
    id: string
    type: string
    standard: boolean
    left: number
    right: number
    stick: Stick | null
    value: number
  } | null>(null)
  // Which controller it is and whether up reads as down, remembered in this browser.
  const [padType, setPadType] = useState<PadType>("auto")
  const [invertPad, setInvertPad] = useState(false)
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("yams-tuner.padType") as PadType | null
      if (saved && PAD_TYPES.some((t) => t.value === saved)) setPadType(saved)
      setInvertPad(window.localStorage.getItem("yams-tuner.padInvert") === "true")
    } catch {
      // Storage can be unavailable; the defaults apply.
    }
  }, [])
  const padSettings = useRef({ type: padType, invert: invertPad })
  padSettings.current = { type: padType, invert: invertPad }
  const choosePad = (type: PadType, invert: boolean) => {
    setPadType(type)
    setInvertPad(invert)
    try {
      window.localStorage.setItem("yams-tuner.padType", type)
      window.localStorage.setItem("yams-tuner.padInvert", String(invert))
    } catch {
      // Not remembered, but still used.
    }
  }
  /** Driving with a stick: how far it is pushed, 0 to 1, which scales the drive voltage. */
  const stickScale = useRef(1)
  const [gravityText, setGravityText] = useState("0")
  const setGravity = (v: number) => {
    const next = Math.max(-MAX_GRAVITY_VOLTS, Math.min(MAX_GRAVITY_VOLTS, Math.round(v * 1000) / 1000))
    setGravityVolts(next)
    setGravityText(String(next))
  }
  // The gravity hold voltage is kG. It starts at 0 V rather than the robot's kG, which may be untuned: an untuned kG
  // would push the mechanism every time a drive button is released. Use robot kG applies it on purpose.
  const kGTopic = topics ? `${topics.tuningPrefix}closedloop/feedforward/kG` : null
  const kSTopic = topics ? `${topics.tuningPrefix}closedloop/feedforward/kS` : null
  const robotKG = useNtValue<number>(kGTopic)
  const robotKS = useNtValue<number>(kSTopic)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<{ tone: "warn" | "info"; text: string } | null>(null)
  const [driving, setDriving] = useState<Dir | null>(null)
  const [definedLower, setDefinedLower] = useState(() => (softLower !== undefined ? softLower.toFixed(decimals) : ""))
  const [definedUpper, setDefinedUpper] = useState(() => (softUpper !== undefined ? softUpper.toFixed(decimals) : ""))

  const timer = useRef<number | null>(null)
  /** The voltage last sent while driving, which a ramp down starts from. */
  const sentVolts = useRef(0)
  const lastDrive = useRef<{ dir: Dir; endedAt: number | null } | null>(null)
  const sessionRef = useRef(session)
  sessionRef.current = session
  const verifiedRef = useRef(verified)
  verifiedRef.current = verified
  const verifyHoldRef = useRef(verifyHold)
  verifyHoldRef.current = verifyHold
  const gravityRef = useRef(0)
  gravityRef.current = verifyHold === "zeroVolts" && gravityLoaded ? gravityVolts : 0
  const kindRef = useRef(kind)
  kindRef.current = kind
  /** Holding with the closed loop: where it should hold, and since when. */
  const holdAt = useRef<{ position: number; since: number } | null>(null)

  const verifying = session === "verify"
  const fmt = (v: number) => formatPosition(v, axis)

  /** Records one end of travel. Returns an error message if it would invert the range. */
  const markValue = useCallback(
    (side: Side, value: number): string | null => {
      const other = side === "lower" ? verifiedRef.current.upper : verifiedRef.current.lower
      if (other !== null && (side === "lower" ? value >= other : value <= other)) {
        const msg = `The ${side} end (${formatPosition(value, axis)}) must be ${side === "lower" ? "below" : "above"} the ${side === "lower" ? "upper" : "lower"} end (${formatPosition(other, axis)}).`
        setError(msg)
        return msg
      }
      setError(null)
      setVerifiedBound(side, value)
      return null
    },
    [axis, setVerifiedBound],
  )

  /** An end found by a fault or a hard stop while driving toward it. */
  const autoMark = useCallback(
    (dir: Dir, value: number, cause: string) => {
      const side = sideOf(dir)
      if (markValue(side, value) === null) {
        setNote({
          tone: "warn",
          text: `${cause} while driving ${dir > 0 ? "toward the upper end" : "toward the lower end"}. Marked the ${side} end at ${formatPosition(value, axis)}. Re-mark it if this was not the real end of travel.`,
        })
      }
    },
    [axis, markValue],
  )

  /**
   * The voltage that holds the mechanism against gravity at a position, when holding with voltage: the gravity hold
   * voltage for an elevator, scaled by the cosine of the angle for an arm (0 degrees is level). 0 otherwise.
   */
  const holdVoltsAt = useCallback((pos: number | undefined) => {
    const g = gravityRef.current
    if (g === 0 || pos === undefined) return 0
    const v = kindRef.current === "arm" ? g * Math.cos((pos * Math.PI) / 180) : g
    // To the millivolt: an arm hanging near straight down needs only a little.
    return Math.round(v * 1000) / 1000
  }, [])

  /** Cuts the voltage. With hold, the closed loop takes over at the current position. */
  const endDrive = useCallback(
    (hold = true) => {
      if (timer.current !== null) {
        clearInterval(timer.current)
        timer.current = null
      }
      if (lastDrive.current && lastDrive.current.endedAt === null) lastDrive.current.endedAt = Date.now()
      sentVolts.current = 0
      setDriving(null)
      setRampingDown(false)
      setAppliedVolts(0)
      holdAt.current = null
      if (!mechanismName) return
      const t = yamsTopics(mechanismName)
      if (hold && sessionRef.current === "verify" && verifyHoldRef.current === "zeroVolts") {
        // Holding with voltage: stay in voltage mode, so the closed loop, which may be untuned, never takes over, at
        // the gravity hold voltage (0 V unless one is set).
        const v = holdVoltsAt(axisReader(nt, mechanismName, axis).position())
        if (nt.isAnnounced(t.tuning.voltageSetpoint)) nt.set(t.tuning.voltageSetpoint, v)
        if (nt.isAnnounced(t.tuning.voltageEnabled)) nt.set(t.tuning.voltageEnabled, true)
        return
      }
      // Seed the hold position before releasing voltage so the closed loop never jumps to a stale target.
      if (hold && sessionRef.current === "verify") {
        const pos = axisReader(nt, mechanismName, axis).position()
        if (pos !== undefined) {
          nt.set(t.tuning.setpointPosition, pos)
          holdAt.current = { position: pos, since: performance.now() }
        }
      }
      if (nt.isAnnounced(t.tuning.voltageSetpoint)) nt.set(t.tuning.voltageSetpoint, 0)
      if (nt.isAnnounced(t.tuning.voltageEnabled)) nt.set(t.tuning.voltageEnabled, false)
    },
    [nt, mechanismName, axis, holdVoltsAt],
  )

  // An over-current fault that ends the session mid-drive means the mechanism hit something: that is the end of travel.
  // Declared before the effect below so it runs while the drive record is still intact.
  useEffect(() => {
    if (!lastStop || lastStop.cause !== "overcurrent" || !mechanismName) return
    const drive = lastDrive.current
    lastDrive.current = null
    if (!drive || (drive.endedAt !== null && lastStop.at - drive.endedAt > 300)) return
    const pos = axisReader(nt, mechanismName, axis).position()
    if (pos !== undefined) autoMark(drive.dir, pos, "Stator current fault")
  }, [lastStop, nt, mechanismName, axis, autoMark])

  useEffect(() => {
    if (!verifying && timer.current !== null) endDrive(false)
  }, [verifying, endDrive])
  useEffect(() => () => endDrive(false), [endDrive])

  // Holding with voltage and a gravity hold voltage: keep sending it between drives, since an arm's changes with its
  // angle and the voltage can be adjusted while verifying.
  useEffect(() => {
    if (!verifying || verifyHold !== "zeroVolts" || !gravityLoaded || !mechanismName) return
    const reader = axisReader(nt, mechanismName, axis)
    const t = yamsTopics(mechanismName)
    let last: number | null = null
    const id = window.setInterval(() => {
      if (timer.current !== null || sessionRef.current !== "verify") {
        last = null
        return
      }
      const v = holdVoltsAt(reader.position())
      if (v === last) return
      last = v
      nt.set(t.tuning.voltageSetpoint, v)
      nt.set(t.tuning.voltageEnabled, true)
    }, LOOP_MS)
    return () => clearInterval(id)
  }, [verifying, verifyHold, gravityLoaded, mechanismName, nt, axis, holdVoltsAt])

  // Holding with the closed loop: it holds where verification started, and wherever each drive stops. If it runs away
  // from there, or has not settled close to it after a second, its gains are not holding the mechanism: cut to 0 V
  // and stop.
  useEffect(() => {
    if (!verifying || verifyHold !== "closedLoop" || !mechanismName) return
    const reader = axisReader(nt, mechanismName, axis)
    const start = reader.position()
    if (start !== undefined && timer.current === null) holdAt.current = { position: start, since: performance.now() }
    const runaway = axis === "linear" ? RUNAWAY_TOLERANCE.linear : RUNAWAY_TOLERANCE.rotary
    const settled = overshootTolerance(axis)
    const id = window.setInterval(() => {
      const hold = holdAt.current
      if (!hold || timer.current !== null || sessionRef.current !== "verify") return
      const pos = reader.position()
      if (pos === undefined) return
      const off = Math.abs(pos - hold.position)
      const unsettled = performance.now() - hold.since > HOLD_SETTLE_MS && off > settled
      if (off <= runaway && !unsettled) return
      holdAt.current = null
      const t = yamsTopics(mechanismName)
      nt.set(t.tuning.voltageSetpoint, 0)
      nt.set(t.tuning.voltageEnabled, true)
      stop(
        `The closed loop moved the mechanism ${formatPosition(off, axis)} from where it should hold${
          unsettled && off <= runaway ? " and did not settle" : ""
        }. Its gains are probably not tuned yet: verify the range holding at 0 V instead.`,
        true,
      )
    }, LOOP_MS)
    return () => clearInterval(id)
  }, [verifying, verifyHold, mechanismName, nt, axis, stop])

  /** Drives toward an end with voltage. With a target it stops there and marks it; without one it runs until released. */
  const beginDrive = (dir: Dir, target?: number, byStick = false) => {
    if (!verifying || !mechanismName || !supported) return
    endDrive(false)
    holdAt.current = null
    const reader = axisReader(nt, mechanismName, axis)
    const t = yamsTopics(mechanismName)
    const startPos = reader.position()
    if (startPos === undefined) return
    setNote(null)
    setError(null)
    if (target !== undefined && (target - startPos) * dir <= params.reachTolerance) {
      if (Math.abs(startPos - target) <= params.reachTolerance) {
        if (markValue(sideOf(dir), target) === null) setNote({ tone: "info", text: `Already at the ${sideOf(dir)} end. Marked ${fmt(target)}.` })
      } else {
        setNote({ tone: "warn", text: `The mechanism is already past ${fmt(target)}. Drive the other way first.` })
      }
      return
    }

    nt.set(t.tuning.setpointPosition, startPos)
    nt.set(t.tuning.voltageSetpoint, holdVoltsAt(startPos))
    nt.set(t.tuning.voltageEnabled, true)
    lastDrive.current = { dir, endedAt: null }
    setDriving(dir)

    const startedAt = performance.now()
    const volts = driveVolts
    let sent = 0
    let progressPos = startPos
    let stuckSince: number | null = null
    let overCurrentSince: number | null = null

    timer.current = window.setInterval(() => {
      if (sessionRef.current !== "verify") {
        endDrive(false)
        return
      }
      const now = performance.now()
      const pos = reader.position()
      if (pos === undefined) {
        endDrive()
        return
      }
      if ((pos - startPos) * dir < -params.directionThreshold) {
        endDrive(false)
        lastDrive.current = null
        stop(
          `Mechanism moved opposite to the commanded voltage. Either gravity is stronger than ${formatVolts(volts)} (raise the drive voltage slightly) or the motor/encoder inversion is wrong. Re-run the inversion check if unsure.`,
          true,
        )
        return
      }
      if (target !== undefined && (target - pos) * dir <= params.reachTolerance) {
        endDrive()
        if (markValue(sideOf(dir), target) === null) {
          setNote({ tone: "info", text: `Reached the defined ${sideOf(dir)} end at ${fmt(target)} and marked it.` })
        }
        return
      }
      // When over-current only warns, the session keeps running, so the drive itself treats it as the end of travel.
      const amps = reader.statorCurrent()
      if (currentAsWarning && amps !== undefined && Math.abs(amps) > stallCurrent) {
        overCurrentSince ??= now
        if (now - overCurrentSince > STALL_DEBOUNCE_MS) {
          endDrive()
          autoMark(dir, pos, `Stator current above ${stallCurrent} A`)
          return
        }
      } else overCurrentSince = null

      // The robot won't drive past its own soft limit, so reaching one is that end of travel: mark it there.
      const softLimit = dir > 0 ? reader.upperLimit() : reader.lowerLimit()
      if (softLimit !== undefined && (softLimit - pos) * dir <= params.reachTolerance) {
        endDrive()
        if (markValue(sideOf(dir), softLimit) === null) {
          setNote({
            tone: "info",
            text:
              target !== undefined
                ? `Stopped at the robot's ${sideOf(dir)} soft limit (${fmt(softLimit)}) before reaching the defined end, and marked it as the ${sideOf(dir)} end.`
                : `Reached the robot's ${sideOf(dir)} soft limit and marked it as the ${sideOf(dir)} end (${fmt(softLimit)}).`,
          })
        }
        return
      }

      const ramp = Math.min(1, (now - startedAt) / RAMP_MS)
      const nearTarget = target !== undefined && Math.abs(target - pos) <= params.reachTolerance * SLOW_ZONE_TOLERANCES
      // On top of the gravity hold voltage, so driving up and down feel the same and a press never jumps.
      const scale = byStick ? stickScale.current : 1
      const out = Math.round((holdVoltsAt(pos) + dir * volts * scale * ramp * (nearTarget ? 0.5 : 1)) * 1000) / 1000
      if (out !== sent) {
        sent = out
        sentVolts.current = out
        nt.set(t.tuning.voltageSetpoint, out)
        setAppliedVolts(out)
      }

      if (Math.abs(pos - progressPos) > params.directionThreshold || scale < STALL_CHECK_MIN_STICK) {
        progressPos = pos
        stuckSince = null
      } else if (ramp >= 1) {
        stuckSince ??= now
        if (now - stuckSince > params.stuckTimeoutMs) {
          endDrive()
          autoMark(
            dir,
            pos,
            target !== undefined
              ? `Stopped short of the defined end (${fmt(target)}) with no movement`
              : `No movement at ${formatVolts(volts)}, likely a hard stop`,
          )
        }
      }
    }, LOOP_MS)
  }

  /**
   * Releasing a drive button. In ramp mode the voltage steps down from wherever it is to 0 at the ramp rate, sent from
   * this page, before the closed loop takes over and holds the position; otherwise it is cut at once. Every other stop
   * (a fault, the wrong direction, an end or soft limit reached, a stall, marking) still cuts at once.
   */
  const releaseDrive = () => {
    if (timer.current === null) return
    const start = sentVolts.current
    if (release === "cut" || !mechanismName) {
      endDrive()
      return
    }
    const reader = axisReader(nt, mechanismName, axis)
    // An arm below 0 degrees does not ramp: the voltage goes straight to the hold voltage, so it is not carried further back.
    const belowZero = (pos: number | undefined) => kind === "arm" && pos !== undefined && pos < 0
    if (start === holdVoltsAt(reader.position()) || belowZero(reader.position())) {
      endDrive()
      return
    }
    clearInterval(timer.current)
    timer.current = null
    holdAt.current = null
    const t = yamsTopics(mechanismName)
    // While it is still going up, the rate drops by its last digit every loop. Rather than reach 0 it goes a digit
    // further (0.1 to 0.09), so the ramp always finishes. Only for this ramp: the next release starts from the entered rate.
    let decimals = leastDigitDecimals(rampDownRate)
    let rate = rampDownRate
    let lastPos = reader.position()
    let out = start
    setDriving(null)
    setRampingDown(true)
    setRampRateNow(rate)
    timer.current = window.setInterval(() => {
      if (sessionRef.current !== "verify") {
        endDrive(false)
        return
      }
      const pos = reader.position()
      if (belowZero(pos)) {
        endDrive()
        return
      }
      if (pos !== undefined && lastPos !== undefined && pos > lastPos) {
        if (rate <= 10 ** -decimals) decimals++
        rate = Number((rate - 10 ** -decimals).toFixed(decimals))
        if (rate < RAMP_RATE_CUTOFF) {
          // Too slow to finish: go straight to the hold voltage (0 V unless one is set).
          endDrive()
          return
        }
        setRampRateNow(rate)
      }
      lastPos = pos
      const step = (rate * LOOP_MS) / 1000
      // Down to the gravity hold voltage, which is 0 V unless one is set.
      const goal = holdVoltsAt(pos)
      // Not rounded as it goes: a slow ramp's step can be far below a millivolt.
      out = Math.abs(out - goal) <= step ? goal : out - Math.sign(out - goal) * step
      if (out === goal) {
        endDrive()
        return
      }
      const sent = Math.round(out * 1e6) / 1e6
      sentVolts.current = sent
      nt.set(t.tuning.voltageSetpoint, sent)
      setAppliedVolts(sent)
    }, LOOP_MS)
  }

  /**
   * Marks an end where the mechanism is now. It works while a drive button is held, so on a touch screen one finger
   * can drive toward an end while another marks it. Marking stops the drive there.
   */
  const markHere = (side: Side) => {
    const now = mechanismName ? axisReader(nt, mechanismName, axis).position() : undefined
    const value = now ?? position
    if (value === undefined) return
    if (timer.current !== null) endDrive()
    markValue(side, value)
  }
  // A tap is handled on touch down, since a second finger's tap may never become a click while the first is held.
  const markedOnPointer = useRef(0)
  const markProps = (side: Side) => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType === "mouse") return
      markedOnPointer.current = Date.now()
      markHere(side)
    },
    onClick: () => {
      if (Date.now() - markedOnPointer.current < 1000) return
      markHere(side)
    },
  })

  // On a desktop, W marks the upper end and Q the lower one while a drive button is held, like tapping Mark.
  // Driving with a game controller: whichever stick leaves the deadband first drives, until it is back in it. Its
  // vertical travel scales the drive voltage, up toward the upper end. Centering it releases the drive, like letting go
  // of a button. After a drive stops by itself (an end, a soft limit, a stall, a fault), the stick has to be centered
  // before it drives again.
  const beginDriveRef = useRef(beginDrive)
  beginDriveRef.current = beginDrive
  const releaseDriveRef = useRef(releaseDrive)
  releaseDriveRef.current = releaseDrive
  const definedRef = useRef<{ mode: Mode; lower: number; upper: number; ok: boolean }>({ mode, lower: NaN, upper: NaN, ok: false })
  useEffect(() => {
    if (driveInput !== "controller") {
      setPad(null)
      return
    }
    let active: Stick | null = null
    let drivingDir: Dir | null = null
    let waitForCenter = false
    let shown = ""
    const id = window.setInterval(() => {
      const sticks = readSticks(padSettings.current.type, padSettings.current.invert)
      let value = 0
      if (sticks) {
        if (active && sticks[active] === 0) active = null
        if (!active) active = sticks.left !== 0 ? "left" : sticks.right !== 0 ? "right" : null
        value = active ? sticks[active] : 0
      } else active = null
      const key = sticks ? `${sticks.id}|${sticks.type}|${active}|${sticks.left.toFixed(2)}|${sticks.right.toFixed(2)}` : ""
      if (key !== shown) {
        shown = key
        setPad(sticks ? { id: sticks.id, type: sticks.type, standard: sticks.standard, left: sticks.left, right: sticks.right, stick: active, value } : null)
      }
      const canDrive = sessionRef.current === "verify" && !document.hidden
      if (value === 0 || !canDrive) {
        waitForCenter = false
        if (drivingDir !== null) {
          drivingDir = null
          if (timer.current !== null) releaseDriveRef.current()
        }
        return
      }
      stickScale.current = Math.abs(value)
      const dir: Dir = value > 0 ? 1 : -1
      // A drive the stick started that has ended by itself: wait for the stick to come back to center.
      if (drivingDir !== null && timer.current === null) {
        drivingDir = null
        waitForCenter = true
      }
      if (waitForCenter || drivingDir === dir) return
      const d = definedRef.current
      if (d.mode === "define" && !d.ok) return
      drivingDir = dir
      beginDriveRef.current(dir, d.mode === "define" ? (dir > 0 ? d.upper : d.lower) : undefined, true)
      if (timer.current === null) {
        // It did not start (already at that end, or past it).
        drivingDir = null
        waitForCenter = true
      }
    }, LOOP_MS)
    return () => {
      clearInterval(id)
      if (drivingDir !== null && timer.current !== null) releaseDriveRef.current()
    }
  }, [driveInput])

  const markHereRef = useRef(markHere)
  markHereRef.current = markHere
  useEffect(() => {
    if (driving === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
      const el = e.target as HTMLElement | null
      if (el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))) return
      const key = e.key.toLowerCase()
      if (key !== "w" && key !== "q") return
      e.preventDefault()
      markHereRef.current(key === "w" ? "upper" : "lower")
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [driving])

  /** Switching to the define tab starts from whatever range has already been found. */
  const selectMode = (next: Mode) => {
    if (next === "define") {
      if (verified.lower !== null) setDefinedLower(verified.lower.toFixed(decimals))
      if (verified.upper !== null) setDefinedUpper(verified.upper.toFixed(decimals))
    }
    setMode(next)
  }

  /**
   * Applies typed ends without driving, but only where they narrow a range the mechanism has
   * already reached. Widening an end goes past tested travel, so that end must be driven to.
   */
  const applyDefined = () => {
    if (definedError || definedMatchesVerified || driving !== null) return
    if (verified.lower === null && verified.upper === null) return
    setError(null)
    const applied: string[] = []
    const needsDrive: string[] = []
    if (verified.lower !== null && lowerValue >= verified.lower) {
      if (lowerValue !== verified.lower) applied.push(`lower ${fmt(lowerValue)}`)
      setVerifiedBound("lower", lowerValue)
    } else needsDrive.push("lower")
    if (verified.upper !== null && upperValue <= verified.upper) {
      if (upperValue !== verified.upper) applied.push(`upper ${fmt(upperValue)}`)
      setVerifiedBound("upper", upperValue)
    } else needsDrive.push("upper")

    if (needsDrive.length === 0) {
      setNote({
        tone: "info",
        text: applied.length ? `Applied ${applied.join(" and ")}. It is inside travel already reached, so no drive test is needed.` : "Range unchanged.",
      })
    } else {
      setNote({
        tone: "warn",
        text: `${applied.length ? `Applied ${applied.join(" and ")}. ` : ""}The ${needsDrive.join(" and ")} end${needsDrive.length > 1 ? "s go" : " goes"} past travel that has been reached, so ${needsDrive.length > 1 ? "they" : "it"} must be tested: start verification and hold the drive button${needsDrive.length > 1 ? "s" : ""} below.`,
      })
    }
  }


  const blurOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing || e.keyCode === 229) return
    e.currentTarget.blur()
  }

  const begin = async () => {
    setError(null)
    setNote(null)
    setError(await startLiveTuning("verify"))
  }

  const holdProps = (dir: Dir, onStart: () => void) => ({
    disabled: !verifying || !supported,
    onPointerDown: (e: React.PointerEvent) => {
      e.currentTarget.setPointerCapture(e.pointerId)
      onStart()
    },
    onPointerUp: () => releaseDrive(),
    onPointerCancel: () => releaseDrive(),
    onLostPointerCapture: () => releaseDrive(),
    // Pressing the other drive button moves focus off this one. Only this button's own drive stops then, not the new one.
    onBlur: () => {
      if (lastDrive.current?.dir === dir && lastDrive.current.endedAt === null && driving === dir) releaseDrive()
    },
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  })

  const lowerValue = Number.parseFloat(definedLower)
  const upperValue = Number.parseFloat(definedUpper)
  const definedError =
    definedLower.trim() === "" || definedUpper.trim() === "" || !Number.isFinite(lowerValue) || !Number.isFinite(upperValue)
      ? "Enter both ends."
      : lowerValue >= upperValue
        ? "The lower end must be below the upper end."
        : null
  const definedMatchesVerified = !definedError && verified.lower === lowerValue && verified.upper === upperValue
  definedRef.current = { mode, lower: lowerValue, upper: upperValue, ok: definedError === null }
  const outsideSoft =
    !definedError &&
    ((softLower !== undefined && lowerValue < softLower) || (softUpper !== undefined && upperValue > softUpper))

  const holdClass =
    "flex min-h-14 touch-none select-none items-center justify-center gap-2 rounded-md border border-border bg-background px-3 text-center font-medium disabled:opacity-50 data-[active=true]:border-foreground data-[active=true]:bg-hazard data-[active=true]:text-hazard-foreground"

  // Each part of the page, so the order can change while verifying: on a phone the drive buttons then sit right under
  // the gauge, with the settings and their help below.
  const rangeSetup = (
    <>
      <div role="radiogroup" aria-label="How to set the range" className="grid grid-cols-2 gap-1 rounded-md border border-border p-1">
        {(
          [
            ["find", "Find ends by driving"],
            ["define", "Enter range and test it"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={mode === value}
            disabled={driving !== null}
            onClick={() => selectMode(value)}
            className="rounded px-3 py-2 text-sm font-medium text-muted-foreground aria-checked:bg-secondary aria-checked:text-foreground"
          >
            {label}
          </button>
        ))}
      </div>

      {mode === "define" && (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">{`Lower end (${unit})`}</span>
              <Input
                inputMode="decimal"
                className="font-mono"
                value={definedLower}
                disabled={driving !== null}
                onChange={(e) => setDefinedLower(e.target.value)}
                onBlur={applyDefined}
                onKeyDown={blurOnEnter}
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">{`Upper end (${unit})`}</span>
              <Input
                inputMode="decimal"
                className="font-mono"
                value={definedUpper}
                disabled={driving !== null}
                onChange={(e) => setDefinedUpper(e.target.value)}
                onBlur={applyDefined}
                onKeyDown={blurOnEnter}
              />
            </label>
          </div>
          <Hint summary="How entering a range works" className={verifying ? "hidden" : undefined}>
            {verified.lower !== null || verified.upper !== null
              ? "Starts from the range already found. Edits apply when you click away or press Enter. Narrowing an end applies right away; widening one past reached travel means driving the mechanism there to test it."
              : "Each end only counts once the mechanism has actually been driven there."}{" "}
            Voltage is halved close to each end to limit overshoot. If it stalls or faults on the way, the point where it stopped is marked
            instead.
          </Hint>
          {definedError && (definedLower !== "" || definedUpper !== "") && <Notice tone="warn">{definedError}</Notice>}
          {outsideSoft && <Notice tone="warn">Part of this range is outside the robot&apos;s soft limits. Driving stops at the soft limit.</Notice>}
        </div>
      )}
    </>
  )
  const holdSetup = (
      <div className="flex flex-col gap-1.5">
        <span className="text-xs uppercase tracking-wide text-muted-foreground" id="hold-label">
          Between drives, hold the mechanism with
        </span>
        <div role="radiogroup" aria-labelledby="hold-label" className="grid grid-cols-2 gap-1 rounded-md border border-border p-1">
          {(
            [
              ["zeroVolts", "Voltage, no closed loop (safe before tuning)"],
              ["closedLoop", "Closed loop (tuned gains)"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={verifyHold === value}
              disabled={verifying || starting}
              onClick={() => setVerifyHold(value)}
              className="rounded px-3 py-2 text-sm font-medium text-muted-foreground aria-checked:bg-secondary aria-checked:text-foreground"
            >
              {label}
            </button>
          ))}
        </div>
        <Hint summary="What each hold does" className={verifying ? "hidden" : undefined}>
          {verifyHold === "zeroVolts"
            ? gravityLoaded
              ? "The closed loop never runs: between drives the motor gets the gravity hold voltage below, 0 V unless you set one. Use this until the gains are tuned, since an untuned closed loop can oscillate or run away."
              : "The closed loop never runs: between drives the motor gets 0 V, as if disabled. Use this until the gains are tuned, since an untuned closed loop can oscillate or run away."
            : "The closed loop holds the mechanism where each drive stops. If it moves away from there or does not settle within a second, verification cuts to 0 V and stops. Only use this once the gains hold the mechanism."}
        </Hint>
        {verifyHold === "zeroVolts" && gravityLoaded && (
          <div className="flex flex-col gap-1.5 rounded-md border border-border p-3">
            <span className="text-xs uppercase tracking-wide text-muted-foreground" id="gravity-label">
              Gravity hold voltage
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                aria-label="Lower the gravity hold voltage"
                disabled={driving !== null || rampingDown}
                onClick={() => setGravity(gravityVolts - GRAVITY_STEP_VOLTS)}
              >
                −
              </Button>
              <Input
                inputMode="decimal"
                aria-labelledby="gravity-label"
                className="h-8 w-24 font-mono"
                value={gravityText}
                disabled={driving !== null || rampingDown}
                onChange={(e) => setGravityText(e.target.value)}
                onBlur={() => {
                  const v = Number.parseFloat(gravityText)
                  if (!Number.isFinite(v)) setGravityText(String(gravityVolts))
                  else if (v !== gravityVolts) setGravity(v)
                }}
                onKeyDown={blurOnEnter}
              />
              <span className="text-sm text-muted-foreground">V</span>
              <Button
                variant="outline"
                size="sm"
                aria-label="Raise the gravity hold voltage"
                disabled={driving !== null || rampingDown}
                onClick={() => setGravity(gravityVolts + GRAVITY_STEP_VOLTS)}
              >
                +
              </Button>
              {typeof robotKG === "number" && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={driving !== null || rampingDown || gravityVolts === Math.round(robotKG * 1000) / 1000}
                    onClick={() => setGravity(robotKG)}
                  >
                    {`Use robot kG (${formatVolts(robotKG)})`}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!kGTopic || gravityVolts === Math.round(robotKG * 1000) / 1000}
                    onClick={() => kGTopic && nt.set(kGTopic, gravityVolts)}
                  >
                    Set kG to this
                  </Button>
                </>
              )}
            </div>
            <Hint summary="How to find the gravity hold voltage" className={verifying ? "hidden" : undefined}>
              {kind === "arm"
                ? "The voltage that holds the arm level, like kG: it is scaled by the cosine of the angle (0° is level), so the arm stays put wherever you let go. Start verification, then raise it a little at a time until the arm stops sagging between drives, and lower it if the arm creeps up. Drives add to it, and a ramped release ramps down to it."
                : "The voltage that holds the elevator up, like kG. Start verification, then raise it a little at a time until the elevator stops sagging between drives, and lower it if the elevator creeps up. Drives add to it, and a ramped release ramps down to it."}
              {` It is kG: it starts at 0 V, Use robot kG starts from the robot's, and once it holds, Set kG to this sends it to the robot.`}
              {typeof robotKS === "number" && robotKS > 0
                ? ` Static friction (kS, ${formatVolts(robotKS)} here) means anything from kG − kS to kG + kS holds it still, so the hold you find is kG within kS: where it starts creeping down and where it starts creeping up are kG − kS and kG + kS.`
                : " Static friction (kS) means a band of voltages around kG holds it still: kG is the middle of that band, and kS is half its width."}
              {` Up to ${MAX_GRAVITY_VOLTS} V. Stopping verification still ends at 0 V.`}
            </Hint>
          </div>
        )}
      </div>
  )
  const driveInputSetup = (
      <div className="flex flex-col gap-1.5">
        <span className="text-xs uppercase tracking-wide text-muted-foreground" id="drive-input-label">
          Drive with
        </span>
        <div role="radiogroup" aria-labelledby="drive-input-label" className="grid grid-cols-2 gap-1 rounded-md border border-border p-1">
          {(
            [
              ["buttons", "Hold buttons"],
              ["controller", "Game controller"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={driveInput === value}
              disabled={driving !== null || rampingDown}
              onClick={() => setDriveInput(value)}
              className="rounded px-3 py-1.5 text-sm font-medium text-muted-foreground aria-checked:bg-secondary aria-checked:text-foreground"
            >
              {label}
            </button>
          ))}
        </div>
        {driveInput === "controller" && (
          <div className="flex flex-col gap-2 rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm">
                <span className="text-xs uppercase tracking-wide text-muted-foreground">Controller</span>
                <select
                  className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                  value={padType}
                  disabled={driving !== null}
                  onChange={(e) => choosePad(e.target.value as PadType, invertPad)}
                >
                  {PAD_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-foreground"
                  checked={invertPad}
                  disabled={driving !== null}
                  onChange={(e) => choosePad(padType, e.target.checked)}
                />
                Invert up and down
              </label>
            </div>
            <StickPreview pad={pad} />
            <p className="text-xs leading-relaxed text-muted-foreground" data-pad="status">
              {pad
                ? `${pad.id}, read as ${PAD_TYPES.find((t) => t.value === pad.type)?.label ?? pad.type}${pad.standard ? " (standard layout)" : ""}. ${pad.stick ? (verifying ? `The ${pad.stick} stick is driving at ${Math.round(Math.abs(pad.value) * 100)}% of the drive voltage.` : `The ${pad.stick} stick is pushed ${pad.value > 0 ? "up" : "down"} ${Math.round(Math.abs(pad.value) * 100)}%. It drives once verification starts.`) : "Push either stick up or down to drive."}`
                : "No controller found. Plug one in and press any of its buttons."}
            </p>
            <Hint summary="How driving with a controller works" className={verifying ? "hidden" : undefined}>
              {`Before driving, push each stick up: its bar must go up. If it goes down, as some Xbox controllers read, tick Invert up and down. Either stick drives, whichever moves first, up toward the upper end. Its travel past a ${Math.round(STICK_DEADBAND * 100)}% deadband scales the drive voltage, and centering it releases, like letting go of a button. After a drive stops by itself, center the stick before driving again. The buttons still work.`}
            </Hint>
          </div>
        )}
      </div>
  )
  const driveSettings = (
      <div className="flex flex-col gap-1.5 text-sm">
        <span className="flex justify-between text-xs uppercase tracking-wide text-muted-foreground">
          <label htmlFor="drive-volts">Drive voltage (magnitude)</label>
          <span className="font-mono normal-case tabular">
            {driving !== null
              ? `Applying ${formatVolts(appliedVolts)}`
              : rampingDown
                ? `Ramping down ${formatVolts(appliedVolts)} at ${rampRateNow} V/s`
                : formatVolts(driveVolts)}
          </span>
        </span>
        <input
          id="drive-volts"
          type="range"
          className="accent-foreground"
          min={minDriveVolts}
          max={maxDriveVolts}
          step={0.05}
          value={Math.min(maxDriveVolts, Math.max(minDriveVolts, driveVolts))}
          disabled={driving !== null}
          onChange={(e) => setDriveVolts(Number(e.target.value))}
        />
        <div className="flex items-center justify-between font-mono text-xs text-muted-foreground tabular">
          <EditableBound
            label="Minimum drive voltage"
            value={minDriveVolts}
            digits={2}
            step={0.05}
            format={formatVolts}
            onSubmit={(v) => {
              const next = Math.max(MIN_DRIVE_VOLTS, v)
              if (next >= maxDriveVolts) return `Minimum must be below ${formatVolts(maxDriveVolts)}.`
              setMinDriveVolts(next)
              if (driveVolts < next) setDriveVolts(next)
              return next !== v ? `Raised to ${formatVolts(next)}; drive voltage cannot go lower.` : null
            }}
          />
          <EditableBound
            label="Maximum drive voltage"
            value={maxDriveVolts}
            digits={2}
            step={0.1}
            format={formatVolts}
            align="end"
            onSubmit={(v) => {
              const next = Math.min(HARD_LIMIT_VOLTS, v)
              if (next <= minDriveVolts) return `Maximum must be above ${formatVolts(minDriveVolts)}.`
              setMaxDriveVolts(next)
              if (driveVolts > next) setDriveVolts(next)
              return next !== v ? `Limited to ${formatVolts(next)}.` : null
            }}
          />
        </div>
      </div>
  )
  // How a drive ends, chosen before verifying starts and still changeable while verifying.
  const releaseSetup = (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs uppercase tracking-wide text-muted-foreground" id="release-label">
        When a drive button is released
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-labelledby="release-label" className="grid grid-cols-2 gap-1 rounded-md border border-border p-1">
          {(
            [
              ["cut", "Cut to 0 V"],
              ["ramp", "Ramp to 0 V"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={release === value}
              disabled={driving !== null || rampingDown}
              onClick={() => setRelease(value)}
              className="rounded px-3 py-1.5 text-sm font-medium text-muted-foreground aria-checked:bg-secondary aria-checked:text-foreground"
            >
              {label}
            </button>
          ))}
        </div>
        {release === "ramp" && (
          <label className="flex items-center gap-2 text-sm">
            <Input
              inputMode="decimal"
              aria-label="Ramp down rate in volts per second"
              className="h-8 w-20 font-mono"
              value={rampDownText}
              disabled={driving !== null || rampingDown}
              onChange={(e) => setRampDownText(e.target.value)}
              onBlur={() => {
                const v = Number.parseFloat(rampDownText)
                const next = Number.isFinite(v) ? Math.max(MIN_RAMP_DOWN_VOLTS_PER_SECOND, v) : rampDownRate
                setRampDownRate(next)
                setRampDownText(String(next))
              }}
              onKeyDown={blurOnEnter}
            />
            <span className="text-muted-foreground">V/s</span>
          </label>
        )}
      </div>
      {release === "ramp" && (
        <Hint summary="How the ramp works" className={verifying ? "hidden" : undefined}>
          {`Releasing a drive button lowers the voltage to 0 at ${rampDownRate} V/s, so from ${formatVolts(driveVolts)} it takes ${formatDuration(driveVolts / rampDownRate)}, then holds the position. The mechanism keeps moving while it ramps down. While it is still going up, the rate drops by its last digit every ${LOOP_MS} ms (${10 ** -leastDigitDecimals(rampDownRate)} V/s here), and rather than reach 0 it goes a digit further, so 0.1 becomes 0.09. Below ${RAMP_RATE_CUTOFF} V/s the ramp ends and the voltage goes straight to ${gravityLoaded && gravityVolts !== 0 ? "the gravity hold voltage" : "0 V"}.${kind === "arm" ? ` Below 0° the arm does not ramp: the voltage goes straight to ${gravityVolts !== 0 ? "the gravity hold voltage" : "0 V"}, so it is not carried further back.` : ""} Faults, ends, soft limits, stalls and marking still cut the voltage at once.`}
        </Hint>
      )}
    </div>
  )
  const notices = (
    <>
      {note && <Notice tone={note.tone === "warn" ? "warn" : undefined}>{note.text}</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}
      {!verifying && (verified.lower === null) !== (verified.upper === null) && (
        <Notice>{`One end is marked (${fmt((verified.lower ?? verified.upper) as number)}). Start verification again to find the other end.`}</Notice>
      )}
      {rangeVerified && !verifying && verified.lower !== null && verified.upper !== null && (
        <Notice>{`Verified range ${fmt(verified.lower)} to ${fmt(verified.upper)}. Live Tuning stops if the mechanism leaves it.`}</Notice>
      )}
    </>
  )

  return (
    <>
      <TravelGauge
        axis={axis}
        position={position}
        softLower={softLower}
        softUpper={softUpper}
        verifiedLower={verified.lower}
        verifiedUpper={verified.upper}
      />

      {!supported && (
        <Notice tone="warn">
          This robot does not publish voltage/enabled and voltage/setpoint, which range verification uses to drive the mechanism. Update YAMS to a
          version with voltage live tuning, or skip this step.
        </Notice>
      )}

      {verifying ? (
        <>
          <div className="flex flex-col gap-3">
            {mode === "find" ? (
              <div className="grid grid-cols-2 gap-2">
                <button type="button" {...holdProps(-1, () => beginDrive(-1))} className={holdClass} data-active={driving === -1}>
                  <ChevronLeft className="size-5" aria-hidden />
                  {`Hold: drive ${negLabel} (−${formatVolts(driveVolts)})`}
                </button>
                <button type="button" {...holdProps(1, () => beginDrive(1))} className={holdClass} data-active={driving === 1}>
                  {`Hold: drive ${posLabel} (+${formatVolts(driveVolts)})`}
                  <ChevronRight className="size-5" aria-hidden />
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  {...holdProps(-1, () => beginDrive(-1, lowerValue))}
                  disabled={!verifying || !supported || definedError !== null}
                  className={holdClass}
                  data-active={driving === -1}
                >
                  <ChevronLeft className="size-5" aria-hidden />
                  {definedError ? "Hold: drive to lower end" : `Hold: drive to ${fmt(lowerValue)}`}
                  <span className="font-mono text-xs opacity-70 tabular">{`−${formatVolts(driveVolts)}`}</span>
                </button>
                <button
                  type="button"
                  {...holdProps(1, () => beginDrive(1, upperValue))}
                  disabled={!verifying || !supported || definedError !== null}
                  className={holdClass}
                  data-active={driving === 1}
                >
                  <span className="font-mono text-xs opacity-70 tabular">{`+${formatVolts(driveVolts)}`}</span>
                  {definedError ? "Hold: drive to upper end" : `Hold: drive to ${fmt(upperValue)}`}
                  <ChevronRight className="size-5" aria-hidden />
                </button>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" className="h-auto min-h-9 whitespace-normal py-2" {...markProps("lower")} disabled={position === undefined}>
                <Flag data-icon="inline-start" />
                {verified.lower === null ? "Mark lower end here" : `Lower: ${fmt(verified.lower)}`}
              </Button>
              <Button variant="outline" className="h-auto min-h-9 whitespace-normal py-2" {...markProps("upper")} disabled={position === undefined}>
                <Flag data-icon="inline-start" />
                {verified.upper === null ? "Mark upper end here" : `Upper: ${fmt(verified.upper)}`}
              </Button>
            </div>
            <p className="hidden text-xs leading-relaxed text-muted-foreground pointer-fine:block">
              While holding a drive button, press <Kbd>W</Kbd> to mark the upper end here or <Kbd>Q</Kbd> to mark the lower end.
            </p>
            <Button
              onClick={() => stop("Range of motion verified")}
              disabled={verified.lower === null || verified.upper === null || driving !== null || rampingDown}
            >
              Finish verification
            </Button>
            {!rangeVerified && <div className="flex justify-end">{skipControl}</div>}
          </div>
          {notices}
          {driveSettings}
          {releaseSetup}
          {rangeSetup}
          {holdSetup}
          {driveInputSetup}
        </>
      ) : (
        <>
          {rangeSetup}
          {holdSetup}
          {driveInputSetup}
          {releaseSetup}
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={begin} disabled={starting}>
              <Play data-icon="inline-start" />
              {rangeVerified ? "Re-verify range" : "Start verification"}
            </Button>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {verifyHold === "zeroVolts"
                ? gravityLoaded && gravityVolts !== 0
                  ? "Applies the gravity hold voltage to start with. More voltage is only applied while you hold a drive button."
                  : "Applies 0 V to start with. Voltage is only applied while you hold a drive button."
                : "Holds the mechanism where it is with the closed loop. Voltage is only applied while you hold a drive button."}
            </p>
            {!rangeVerified && skipControl}
          </div>
          <Hint summary="Which way the drive buttons push">
            Driving down applies negative voltage and driving up positive, so a correctly inverted mechanism moves down on negative volts. Use
            the least voltage that moves the mechanism. Elevators and arms may need more to drive against gravity than with it.
          </Hint>
          {notices}
        </>
      )}
    </>
  )
}

/** Both sticks' vertical travel as bars, up toward the top, so a reversed stick shows before it drives anything. */
function StickPreview({ pad }: { pad: { left: number; right: number; stick: Stick | null } | null }) {
  const bar = (stick: Stick, value: number) => (
    <div key={stick} className="flex flex-col items-center gap-1" data-stick={stick}>
      <div className="relative h-24 w-8 overflow-hidden rounded border border-border bg-background">
        <div className="absolute inset-x-0 top-1/2 h-px bg-border" />
        <div
          className={`absolute inset-x-1 ${pad?.stick === stick ? "bg-primary" : "bg-muted-foreground/60"}`}
          style={
            value >= 0
              ? { bottom: "50%", height: `${value * 50}%` }
              : { top: "50%", height: `${-value * 50}%` }
          }
        />
      </div>
      <span className="font-mono text-xs tabular text-muted-foreground">{`${stick} ${value >= 0 ? "+" : ""}${Math.round(value * 100)}%`}</span>
    </div>
  )
  return (
    <div className="flex items-end gap-4" aria-label="Stick preview">
      <span className="self-start text-xs text-muted-foreground">Up ▲</span>
      {bar("left", pad?.left ?? 0)}
      {bar("right", pad?.right ?? 0)}
      <span className="self-end text-xs text-muted-foreground">▼ Down</span>
    </div>
  )
}

/** A duration in seconds, as seconds, minutes or hours, whichever reads best. */
function formatDuration(seconds: number) {
  if (seconds < 60) return `${seconds.toFixed(2)} s`
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)} min`
  return `${(seconds / 3600).toFixed(1)} h`
}

/** How many decimal places a number is written with, so its last digit is 10 to the minus that. */
function leastDigitDecimals(value: number) {
  return (String(value).split(".")[1] ?? "").length
}
