"use client"

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { Check, ChevronLeft, ChevronRight, Crosshair, Flag, Play } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { useAxisValues, useNtValue, useTuner } from "@/components/tuner/tuner-context"
import { Kbd, LiveRegion, Notice, Segmented } from "@/components/tuner/panel"
import { TravelGauge } from "@/components/tuner/travel-gauge"
import { Hint } from "@/components/tuner/hint"
import { EditableBound } from "@/components/tuner/setpoint-panel"
import { SignToggle, flipSign, useSignToggleShown } from "@/components/tuner/sign-toggle"
import { nextText, parseFormatted, type NumberFormat } from "@/lib/number-format"
import { axisReader, formatPosition, positionUnit, yamsTopics } from "@/lib/yams/topics"
import { formatVolts } from "@/lib/format"
import { jogParams, overshootTolerance, STALL_DEBOUNCE_MS } from "@/lib/yams/safety"
import { PAD_TYPES, readSticks, STICK_DEADBAND, type PadType, type Stick } from "@/lib/gamepad"

type Dir = -1 | 1
type Mode = "find" | "define"
type Side = "lower" | "upper"
/** What releasing a drive button does: cut the voltage to 0 at once, or ramp it down to 0. */
type Release = "cut" | "ramp"
/** What drives the mechanism: holding the on-screen buttons, or a game controller's stick. */
type DriveInput = "buttons" | "controller"

/** The voltage slider's ends to start with. The drive buttons drive at them. */
const DEFAULT_MIN_VOLTS = -1
const DEFAULT_MAX_VOLTS = 1
/** Battery voltage: nothing above this can be applied anyway. */
const HARD_LIMIT_VOLTS = 12
/** Voltage ramps from 0 to the drive voltage over this long, so a press never slams the mechanism. */
const RAMP_MS = 400
/** How fast the voltage ramps down to 0 after a drive button is released, in ramp mode, in volts per second. */
const DEFAULT_RAMP_DOWN_VOLTS_PER_SECOND = 4
const MIN_RAMP_DOWN_VOLTS_PER_SECOND = 0.01
/** Raising the ramp rate while the mechanism still goes up stops here, in volts per second. */
const MAX_RAMP_RATE_BOOST = 4
/** How often the drive and the ramp down send a voltage. */
const LOOP_MS = 20
/** Holding with the closed loop: moving this far from the hold position at any time means it is running away. */
const RUNAWAY_TOLERANCE = { linear: 0.1, rotary: 30 }
/** Holding with the closed loop: still this far off after HOLD_SETTLE_MS means the gains are not holding it. */
const HOLD_SETTLE_MS = 1000
/** The gravity hold voltage stays within this, in volts: it only has to balance the mechanism's weight. */
const MAX_GRAVITY_VOLTS = 3
/** Positions and voltages: any number, negative too. */
const ANY_NUMBER: NumberFormat = { negative: true }
/** One press of − or + on the gravity hold voltage. */
const GRAVITY_STEP_VOLTS = 0.02
/** Driving with a stick, below this fraction of the drive voltage a mechanism may just not move: no hard stop then. */
const STALL_CHECK_MIN_STICK = 0.9

const sideOf = (dir: Dir): Side => (dir > 0 ? "upper" : "lower")

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
  // The voltage slider's ends, at most 0 and at least 0. The drive buttons and the stick drive at them.
  const [minVolts, setMinVolts] = useState(DEFAULT_MIN_VOLTS)
  const [maxVolts, setMaxVolts] = useState(DEFAULT_MAX_VOLTS)
  const endsRef = useRef({ min: minVolts, max: maxVolts })
  endsRef.current = { min: minVolts, max: maxVolts }
  /** The voltage slider's position, signed. It goes back to 0 whenever a drive ends. */
  const [sliderVolts, setSliderVolts] = useState(0)
  const sliderRef = useRef(0)
  /** Letting go of the slider goes back to 0 V. Off, its voltage holds until changed. */
  const [springBack, setSpringBack] = useState(true)
  /** What started the drive that is running. */
  const driveSource = useRef<"button" | "stick" | "slider" | null>(null)
  const [appliedVolts, setAppliedVolts] = useState(0)
  // Cut to 0 V by default for every mechanism. Ramping is a choice.
  const [release, setRelease] = useState<Release>("cut")
  const [rampDownRate, setRampDownRate] = useState(DEFAULT_RAMP_DOWN_VOLTS_PER_SECOND)
  const [rampDownText, setRampDownText] = useState(String(DEFAULT_RAMP_DOWN_VOLTS_PER_SECOND))
  /** The voltage is ramping down to 0 after a release. */
  const [rampingDown, setRampingDown] = useState(false)
  /** The ramp's rate right now, raised while the mechanism keeps going up after a release. */
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
  const gravityInput = useRef<HTMLInputElement>(null)
  // While its ± shows, − and + would read as the sign too, so they step aside.
  const gravitySignShown = useSignToggleShown(gravityInput)
  const lowerInput = useRef<HTMLInputElement>(null)
  const upperInput = useRef<HTMLInputElement>(null)
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
      driveSource.current = null
      sliderRef.current = 0
      setSliderVolts(0)
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
        }. Its gains are probably not tuned yet. Under “Between drives, hold the mechanism with”, choose “Voltage, no closed loop” and verify again.`,
        true,
      )
    }, LOOP_MS)
    return () => clearInterval(id)
  }, [verifying, verifyHold, mechanismName, nt, axis, stop])

  /**
   * Drives toward an end. A button drives at the slider's end on that side and ramps up; the stick drives at a fraction
   * of it; the slider drives at its own voltage, read every loop, with no ramp since it is moved by hand.
   */
  const beginDrive = (dir: Dir, source: "button" | "stick" | "slider" = "button") => {
    if (!verifying || !mechanismName || !supported) return
    const slid = sliderRef.current
    endDrive(false)
    if (source === "slider") {
      sliderRef.current = slid
      setSliderVolts(slid)
    }
    const byStick = source !== "button"
    holdAt.current = null
    const reader = axisReader(nt, mechanismName, axis)
    const t = yamsTopics(mechanismName)
    const startPos = reader.position()
    if (startPos === undefined) return
    setNote(null)
    setError(null)

    nt.set(t.tuning.setpointPosition, startPos)
    nt.set(t.tuning.voltageSetpoint, holdVoltsAt(startPos))
    nt.set(t.tuning.voltageEnabled, true)
    lastDrive.current = { dir, endedAt: null }
    driveSource.current = source
    setDriving(dir)

    const startedAt = performance.now()
    // The magnitude at full stick or full button: the slider's end on this side.
    const volts = dir > 0 ? endsRef.current.max : -endsRef.current.min
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
      // Moving against the drive is not a fault here: the inversion check already proved the direction, and a falling
      // mechanism keeps falling for a moment after a drive up starts.
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
            text: `Reached the robot’s ${sideOf(dir)} soft limit and marked it as the ${sideOf(dir)} end (${fmt(softLimit)}).`,
          })
        }
        return
      }

      const ramp = source === "slider" ? 1 : Math.min(1, (now - startedAt) / RAMP_MS)
      // On top of the gravity hold voltage, so driving up and down feel the same and a press never jumps.
      // Below full voltage a mechanism may just not move, so the hard-stop check below waits for near full.
      const scale =
        source === "stick" ? stickScale.current : source === "slider" ? Math.min(1, Math.abs(sliderRef.current) / volts) : 1
      const out = Math.round((holdVoltsAt(pos) + dir * volts * scale * ramp) * 1000) / 1000
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
            `No movement at ${formatVolts(volts * scale)}, likely a hard stop`,
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
    // While it is still going up, the rate rises by its own last digit every loop (0.09 to 0.1, then 0.2, up to 1, then
    // 2), so it ramps down faster the longer it coasts up, up to 4 V/s. Only for this ramp: the next release starts
    // from the entered rate.
    const maxRate = Math.max(MAX_RAMP_RATE_BOOST, rampDownRate)
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
      if (pos !== undefined && lastPos !== undefined && pos > lastPos && rate < maxRate) {
        const decimals = leastDigitDecimals(rate)
        rate = Math.min(maxRate, Number((rate + 10 ** -decimals).toFixed(decimals)))
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

  /** The voltage slider: a new position drives that way at that voltage, 0 is the same as letting go. */
  const slide = (v: number) => {
    sliderRef.current = v
    setSliderVolts(v)
    if (!verifying || !supported) return
    const sliding = driveSource.current === "slider" && timer.current !== null && !rampingDown
    if (v === 0) {
      if (sliding) releaseDrive()
      return
    }
    const dir: Dir = v > 0 ? 1 : -1
    // Already driving this way with the slider: the loop reads the new voltage itself.
    if (sliding && driving === dir) return
    beginDrive(dir, "slider")
  }
  const releaseDriveRef = useRef(releaseDrive)
  releaseDriveRef.current = releaseDrive
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
      drivingDir = dir
      beginDriveRef.current(dir, "stick")
      if (timer.current === null) {
        // It did not start.
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
   * Uses the typed ends as the range without driving. Nothing is sent to the robot, so it works with the robot disabled
   * and the mechanism moved by hand.
   */
  const applyManualRange = () => {
    if (definedError) return
    setError(null)
    setNote(null)
    setVerifiedBound("lower", lowerValue)
    setVerifiedBound("upper", upperValue)
  }
  /** Fills in an end from where the mechanism is now. */
  const fillFromPosition = (side: Side) => {
    const now = mechanismName ? axisReader(nt, mechanismName, axis).position() : undefined
    const value = now ?? position
    if (value === undefined) return
    ;(side === "lower" ? setDefinedLower : setDefinedUpper)(value.toFixed(decimals))
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

  // A button whose end of the slider is 0 has nothing to drive with.
  const noVolts = (dir: Dir) => (dir > 0 ? maxVolts <= 0 : minVolts >= 0)
  const holdProps = (dir: Dir, onStart: () => void) => ({
    disabled: !verifying || !supported || noVolts(dir),
    onPointerDown: (e: React.PointerEvent) => {
      e.currentTarget.setPointerCapture(e.pointerId)
      onStart()
    },
    onPointerUp: () => releaseDrive(),
    onPointerCancel: () => releaseDrive(),
    onLostPointerCapture: () => releaseDrive(),
    // From the keyboard, holding Enter drives and letting go stops. Space stays the stop key.
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.repeat) {
        e.preventDefault()
        onStart()
      }
    },
    onKeyUp: (e: React.KeyboardEvent) => {
      if (e.key === "Enter") releaseDrive()
    },
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
  const outsideSoft =
    !definedError &&
    ((softLower !== undefined && lowerValue < softLower) || (softUpper !== undefined && upperValue > softUpper))

  const holdClass =
    "flex min-h-14 touch-none select-none items-center justify-center gap-2 rounded-md border border-border bg-background px-3 text-center font-medium enabled:hover:border-foreground disabled:opacity-50 data-[active=true]:border-foreground data-[active=true]:bg-hazard data-[active=true]:text-hazard-foreground"

  // Each part of the page, so the order can change while verifying: on a phone the drive buttons then sit right under
  // the gauge, with the settings and their help below.
  const rangeSetup = (
    <>
      <Segmented
        label="How to set the range"
        options={[["find", "Find ends by driving"], ["define", "Enter range manually"]] as const}
        value={mode}
        onChange={selectMode}
        disabled={driving !== null}
      />

      {mode === "define" && (
        <div className="flex flex-col gap-3">
          <p className="text-sm leading-relaxed text-muted-foreground">
            With the robot disabled, move the mechanism by hand to each end and use its position, or type the ends. Nothing
            is driven.
          </p>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ["lower", "Lower end", definedLower, setDefinedLower],
                ["upper", "Upper end", definedUpper, setDefinedUpper],
              ] as const
            ).map(([side, label, value, set]) => (
              <div key={side} className="flex flex-col gap-1.5">
                <label htmlFor={`defined-${side}`} className="text-xs uppercase tracking-wider text-muted-foreground">
                  {`${label} (${unit})`}
                </label>
                <div className="flex gap-1">
                  {/* The ends are only used once Use this range is pressed, so a flip just changes the text. */}
                  <SignToggle label={`the ${side} end`} input={side === "lower" ? lowerInput : upperInput} onFlip={() => set(flipSign(value))} />
                  <Input
                    ref={side === "lower" ? lowerInput : upperInput}
                    id={`defined-${side}`}
                    inputMode="decimal"
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={definedError !== null && (definedLower !== "" || definedUpper !== "")}
                    aria-describedby="defined-range-error"
                    className="font-mono"
                    value={value}
                    onChange={(e) => set(nextText(value, e.target.value, ANY_NUMBER))}
                    onKeyDown={blurOnEnter}
                  />
                </div>
                <Button
                  variant="outline"
                  className="h-auto min-h-9 whitespace-normal py-2"
                  disabled={position === undefined}
                  aria-label={`Use the current position as the ${side} end`}
                  onClick={() => fillFromPosition(side)}
                >
                  <Crosshair data-icon="inline-start" />
                  Use current position
                </Button>
              </div>
            ))}
          </div>
          <div id="defined-range-error" role="status" className="contents">
            {definedError && (definedLower !== "" || definedUpper !== "") && (
              <Notice tone="warn" live={false}>
                {definedError}
              </Notice>
            )}
            {outsideSoft && (
              <Notice tone="warn" live={false}>
                Part of this range is outside the robot’s soft limits, which still stop the mechanism.
              </Notice>
            )}
          </div>
          {position === undefined && <Notice>No position from the robot yet. Type the ends instead.</Notice>}
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={applyManualRange} disabled={definedError !== null || definedMatchesVerified}>
              <Check data-icon="inline-start" />
              Use this range
            </Button>
            {!rangeVerified && skipControl}
          </div>
          <Hint summary="How entering a range works">
            <ul className="flex list-disc flex-col gap-1 ps-4">
              <li>The tuner sends no voltage here, so the robot can stay disabled.</li>
              <li>Use current position reads where the mechanism is now.</li>
              <li>Live Tuning stops if the mechanism leaves this range, so leave room before a hard stop.</li>
              <li>The range is not tested by driving. To test it, find the ends by driving instead.</li>
            </ul>
          </Hint>
        </div>
      )}
    </>
  )
  const holdSetup = (
      <div className="flex flex-col gap-1.5">
        <span className="text-xs uppercase tracking-wider text-muted-foreground" id="hold-label">
          Between drives, hold the mechanism with
        </span>
        <Segmented
          labelledBy="hold-label"
          options={[["zeroVolts", "Voltage, no closed loop (safe before tuning)"], ["closedLoop", "Closed loop (tuned gains)"]] as const}
          value={verifyHold}
          onChange={setVerifyHold}
          disabled={verifying || starting}
        />
        <Hint summary="What each hold does" className={verifying ? "hidden" : undefined}>
          <ul className="flex list-disc flex-col gap-1 ps-4">
            {verifyHold === "zeroVolts" ? (
              <>
                <li>The closed loop never runs.</li>
                <li>{gravityLoaded ? "Between drives the motor gets the gravity hold voltage, 0 V unless you set one." : "Between drives the motor gets 0 V, as if disabled."}</li>
                <li>Use this until the gains are tuned: an untuned closed loop can oscillate or run away.</li>
              </>
            ) : (
              <>
                <li>The closed loop holds where each drive stops.</li>
                <li>Drifting away, or not settling within a second, cuts to 0 V and stops.</li>
                <li>Only use this once the gains hold the mechanism.</li>
              </>
            )}
          </ul>
        </Hint>
        {verifyHold === "zeroVolts" && gravityLoaded && (
          <div className="flex flex-col gap-1.5 rounded-md border border-border p-3">
            <span className="text-xs uppercase tracking-wider text-muted-foreground" id="gravity-label">
              Gravity hold voltage
            </span>
            <div className="flex flex-wrap items-center gap-2">
              {!gravitySignShown && (
                <Button
                  variant="outline"
                  size="sm"
                  aria-label="Lower the gravity hold voltage"
                  disabled={driving !== null || rampingDown}
                  onClick={() => setGravity(gravityVolts - GRAVITY_STEP_VOLTS)}
                >
                  −
                </Button>
              )}
              <SignToggle
                label="the gravity hold voltage"
                input={gravityInput}
                disabled={driving !== null || rampingDown}
                onFlip={(editing) => {
                  const next = flipSign(gravityText)
                  if (editing) setGravityText(next)
                  else setGravity(-gravityVolts)
                }}
              />
              <Input
                ref={gravityInput}
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
                aria-labelledby="gravity-label"
                className="h-8 w-24 font-mono"
                value={gravityText}
                disabled={driving !== null || rampingDown}
                onChange={(e) => setGravityText(nextText(gravityText, e.target.value, ANY_NUMBER))}
                onBlur={() => {
                  const v = parseFormatted(gravityText, ANY_NUMBER)
                  if (v === null) setGravityText(String(gravityVolts))
                  else if (v !== gravityVolts) setGravity(v)
                }}
                onKeyDown={blurOnEnter}
              />
              <span className="text-sm text-muted-foreground">V</span>
              {!gravitySignShown && (
                <Button
                  variant="outline"
                  size="sm"
                  aria-label="Raise the gravity hold voltage"
                  disabled={driving !== null || rampingDown}
                  onClick={() => setGravity(gravityVolts + GRAVITY_STEP_VOLTS)}
                >
                  +
                </Button>
              )}
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
              <ul className="flex list-disc flex-col gap-1 ps-4">
                <li>{kind === "arm" ? "Holds the arm level, like kG, scaled by the cosine of the angle (0° is level)." : "Holds the elevator up, like kG."}</li>
                <li>While verifying, raise it until it stops sagging between drives. Lower it if it creeps up.</li>
                <li>Drives add to it, and a ramp ends at it.</li>
                <li>Starts at 0 V. Use robot kG loads the robot’s; Set kG to this sends yours back.</li>
                <li>{`Friction (kS${typeof robotKS === "number" && robotKS > 0 ? `, ${formatVolts(robotKS)} here` : ""}) means anything from kG − kS to kG + kS holds it still.`}</li>
                <li>{`Up to ${MAX_GRAVITY_VOLTS} V. Stopping verification ends at 0 V.`}</li>
              </ul>
            </Hint>
          </div>
        )}
      </div>
  )
  const driveInputSetup = (
      <div className="flex flex-col gap-1.5">
        <span className="text-xs uppercase tracking-wider text-muted-foreground" id="drive-input-label">
          Drive with
        </span>
        <Segmented
          labelledBy="drive-input-label"
          options={[["buttons", "Hold buttons"], ["controller", "Game controller"]] as const}
          value={driveInput}
          onChange={setDriveInput}
          disabled={driving !== null || rampingDown}
        />
        {driveInput === "controller" && (
          <div className="flex flex-col gap-2 rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm">
                <span className="text-xs uppercase tracking-wider text-muted-foreground">Controller</span>
                <select
                  className="h-8 rounded-md border border-input bg-background px-2 text-base sm:text-sm"
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
              <ul className="flex list-disc flex-col gap-1 ps-4">
                <li>Push each stick up: its bar should go up. If it goes down, tick Invert up and down.</li>
                <li>Whichever stick moves first drives. Up drives toward the upper end.</li>
                <li>{`Travel past the ${Math.round(STICK_DEADBAND * 100)}% deadband scales the voltage. Centering the stick releases.`}</li>
                <li>After a drive stops by itself, center the stick to drive again.</li>
                <li>The buttons still work.</li>
              </ul>
            </Hint>
          </div>
        )}
      </div>
  )
  // A slider for any voltage between its ends, like the Live tune card's Voltage tab. Its ends are what the drive
  // buttons and the stick drive at.
  const driveSettings = (
      <div className="flex flex-col gap-1.5 text-sm">
        <span className="flex justify-between gap-2 text-xs uppercase tracking-wider text-muted-foreground">
          <span>Voltage</span>
          <span className="font-mono normal-case tabular text-foreground">
            {rampingDown
              ? `Ramping down ${formatVolts(appliedVolts)} at ${rampRateNow}\u00a0V/s`
              : `Applied ${formatVolts(appliedVolts)}`}
          </span>
        </span>
        <Slider
          aria-label="Voltage"
          min={minVolts}
          max={maxVolts}
          step={0.05}
          disabled={!verifying || !supported || (driving !== null && driveSource.current !== "slider")}
          value={Math.min(maxVolts, Math.max(minVolts, sliderVolts))}
          onValueChange={(raw) => slide(Math.round((Array.isArray(raw) ? raw[0] : raw) * 100) / 100)}
          onValueCommitted={() => {
            if (springBack && driveSource.current === "slider") releaseDrive()
            if (springBack) {
              sliderRef.current = 0
              setSliderVolts(0)
            }
          }}
        />
        <div className="flex items-center justify-between gap-2 font-mono text-xs text-muted-foreground tabular">
          <EditableBound
            label="Minimum voltage"
            value={minVolts}
            digits={2}
            step={0.1}
            format={formatVolts}
            onSubmit={(v) => {
              const next = Math.max(-HARD_LIMIT_VOLTS, Math.min(0, v))
              if (next >= maxVolts) return `Minimum must be below ${formatVolts(maxVolts)}.`
              setMinVolts(next)
              return next !== v ? `Limited to ${formatVolts(next)}.` : null
            }}
          />
          <label htmlFor="range-spring-back" className="flex items-center gap-2 font-sans">
            <Switch id="range-spring-back" size="sm" checked={springBack} onCheckedChange={(v) => setSpringBack(v === true)} />
            Back to 0{"\u00a0"}V on release
          </label>
          <EditableBound
            label="Maximum voltage"
            value={maxVolts}
            digits={2}
            step={0.1}
            format={formatVolts}
            align="end"
            onSubmit={(v) => {
              const next = Math.min(HARD_LIMIT_VOLTS, Math.max(0, v))
              if (next <= minVolts) return `Maximum must be above ${formatVolts(minVolts)}.`
              setMaxVolts(next)
              return next !== v ? `Limited to ${formatVolts(next)}.` : null
            }}
          />
        </div>
      </div>
  )
  // How a drive ends, chosen before verifying starts and still changeable while verifying.
  const releaseSetup = (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs uppercase tracking-wider text-muted-foreground" id="release-label">
        When the voltage is let go
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          labelledBy="release-label"
          options={[["cut", "Cut to 0 V"], ["ramp", "Ramp to 0 V"]] as const}
          value={release}
          onChange={setRelease}
          disabled={driving !== null || rampingDown}
        />
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
          <ul className="flex list-disc flex-col gap-1 ps-4">
            <li>{`On release the voltage falls at ${rampDownRate} V/s: ${formatDuration(maxVolts / rampDownRate)} from ${formatVolts(maxVolts)}.`}</li>
            <li>The mechanism keeps moving while it ramps.</li>
            <li>{`While it still goes up, the rate rises by its last digit every ${LOOP_MS} ms (0.09, 0.1, 0.2), up to ${Math.max(MAX_RAMP_RATE_BOOST, rampDownRate)} V/s.`}</li>
            {kind === "arm" && <li>{`Below 0° there is no ramp: it goes straight to ${gravityVolts !== 0 ? "the gravity hold voltage" : "0 V"}.`}</li>}
            <li>Faults, ends, soft limits, stalls and marking still cut at once.</li>
          </ul>
        </Hint>
      )}
    </div>
  )
  const notices = (
    <>
      <LiveRegion>
        {note && (
          <Notice tone={note.tone === "warn" ? "warn" : undefined} live={false}>
            {note.text}
          </Notice>
        )}
      </LiveRegion>
      <LiveRegion assertive>
        {error && (
          <Notice tone="danger" live={false}>
            {error}
          </Notice>
        )}
      </LiveRegion>
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

      {!supported && mode === "find" && (
        <Notice tone="warn">
          This robot does not publish voltage/enabled and voltage/setpoint, which range verification uses to drive the mechanism. Update YAMS to a
          version with voltage live tuning, enter the range manually, or skip this step.
        </Notice>
      )}

      {mode === "find" && supported && position !== undefined && (softLower === undefined || softUpper === undefined) && (
        <Notice tone="warn">
          {`No ${softLower === undefined && softUpper === undefined ? "soft limits" : `${softLower === undefined ? "lower" : "upper"} soft limit`}: drives stop only at a hard stop, on over-current or when you let go.`}
        </Notice>
      )}

      {verifying ? (
        <>
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
              <button type="button" {...holdProps(-1, () => beginDrive(-1))} className={holdClass} data-active={driving === -1}>
                <ChevronLeft className="size-5" strokeWidth={2} absoluteStrokeWidth aria-hidden />
                {`Hold: drive ${negLabel} (${formatVolts(minVolts)})`}
              </button>
              <button type="button" {...holdProps(1, () => beginDrive(1))} className={holdClass} data-active={driving === 1}>
                {`Hold: drive ${posLabel} (+${formatVolts(maxVolts)})`}
                <ChevronRight className="size-5" strokeWidth={2} absoluteStrokeWidth aria-hidden />
              </button>
            </div>
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
              Hold <Kbd>Enter</Kbd> on a drive button to drive from the keyboard. While holding one, press <Kbd>W</Kbd> to mark the upper end here or <Kbd>Q</Kbd> to mark the lower end.
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
          {holdSetup}
          {driveInputSetup}
        </>
      ) : mode === "define" ? (
        <>
          {rangeSetup}
          {notices}
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
            <ul className="flex list-disc flex-col gap-1 ps-4">
              <li>{`Drive ${negLabel} is negative voltage, drive ${posLabel} is positive.`}</li>
              <li>Use the least voltage that moves the mechanism.</li>
              <li>Against gravity can take more than with it.</li>
            </ul>
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
