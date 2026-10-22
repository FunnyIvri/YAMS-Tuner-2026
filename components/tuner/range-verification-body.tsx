"use client"

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { ChevronLeft, ChevronRight, Flag, Play } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useAxisValues, useNtValue, useTuner } from "@/components/tuner/tuner-context"
import { Kbd, Notice } from "@/components/tuner/panel"
import { TravelGauge } from "@/components/tuner/travel-gauge"
import { EditableBound } from "@/components/tuner/setpoint-panel"
import { axisReader, formatPosition, positionUnit, yamsTopics } from "@/lib/yams/topics"
import { jogParams, overshootTolerance, STALL_DEBOUNCE_MS } from "@/lib/yams/safety"

type Dir = -1 | 1
type Mode = "find" | "define"
type Side = "lower" | "upper"
/** What releasing a drive button does: cut the voltage to 0 at once, or ramp it down to 0. */
type Release = "cut" | "ramp"

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
const MIN_RAMP_DOWN_VOLTS_PER_SECOND = 0.5
/** How often the drive and the ramp down send a voltage. */
const LOOP_MS = 20
/** Holding with the closed loop: moving this far from the hold position at any time means it is running away. */
const RUNAWAY_TOLERANCE = { linear: 0.1, rotary: 30 }
/** Holding with the closed loop: still this far off after HOLD_SETTLE_MS means the gains are not holding it. */
const HOLD_SETTLE_MS = 1000

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
  const [release, setRelease] = useState<Release>("cut")
  const [rampDownRate, setRampDownRate] = useState(DEFAULT_RAMP_DOWN_VOLTS_PER_SECOND)
  const [rampDownText, setRampDownText] = useState(String(DEFAULT_RAMP_DOWN_VOLTS_PER_SECOND))
  /** The voltage is ramping down to 0 after a release. */
  const [rampingDown, setRampingDown] = useState(false)
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
        // Holding at 0 V: stay in voltage mode, so the closed loop, which may be untuned, never takes over.
        if (nt.isAnnounced(t.tuning.voltageSetpoint)) nt.set(t.tuning.voltageSetpoint, 0)
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
    [nt, mechanismName, axis],
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
  const beginDrive = (dir: Dir, target?: number) => {
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
    nt.set(t.tuning.voltageSetpoint, 0)
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
      const out = Math.round(dir * volts * ramp * (nearTarget ? 0.5 : 1) * 100) / 100
      if (out !== sent) {
        sent = out
        sentVolts.current = out
        nt.set(t.tuning.voltageSetpoint, out)
        setAppliedVolts(out)
      }

      if (Math.abs(pos - progressPos) > params.directionThreshold) {
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
    if (release === "cut" || start === 0 || !mechanismName) {
      endDrive()
      return
    }
    clearInterval(timer.current)
    timer.current = null
    holdAt.current = null
    const t = yamsTopics(mechanismName)
    const step = (rampDownRate * LOOP_MS) / 1000
    let out = start
    setDriving(null)
    setRampingDown(true)
    timer.current = window.setInterval(() => {
      if (sessionRef.current !== "verify") {
        endDrive(false)
        return
      }
      out = Math.abs(out) <= step ? 0 : out - Math.sign(out) * step
      out = Math.round(out * 100) / 100
      if (out === 0) {
        endDrive()
        return
      }
      sentVolts.current = out
      nt.set(t.tuning.voltageSetpoint, out)
      setAppliedVolts(out)
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
  const outsideSoft =
    !definedError &&
    ((softLower !== undefined && lowerValue < softLower) || (softUpper !== undefined && upperValue > softUpper))

  const holdClass =
    "flex min-h-14 touch-none select-none items-center justify-center gap-2 rounded-md border border-border bg-background px-3 text-center font-medium disabled:opacity-50 data-[active=true]:border-foreground data-[active=true]:bg-hazard data-[active=true]:text-hazard-foreground"

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
          <p className="text-sm leading-relaxed text-muted-foreground">
            {verified.lower !== null || verified.upper !== null
              ? "Starts from the range already found. Edits apply when you click away or press Enter. Narrowing an end applies right away; widening one past reached travel means driving the mechanism there to test it."
              : "Each end only counts once the mechanism has actually been driven there."}{" "}
            Voltage is halved close to each end to limit overshoot. If it stalls or faults on the way, the point where it stopped is marked
            instead.
          </p>
          {definedError && (definedLower !== "" || definedUpper !== "") && <Notice tone="warn">{definedError}</Notice>}
          {outsideSoft && <Notice tone="warn">Part of this range is outside the robot&apos;s soft limits. Driving stops at the soft limit.</Notice>}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <span className="text-xs uppercase tracking-wide text-muted-foreground" id="hold-label">
          Between drives, hold the mechanism with
        </span>
        <div role="radiogroup" aria-labelledby="hold-label" className="grid grid-cols-2 gap-1 rounded-md border border-border p-1">
          {(
            [
              ["zeroVolts", "0 V (safe before tuning)"],
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
        <p className="text-xs leading-relaxed text-muted-foreground">
          {verifyHold === "zeroVolts"
            ? "The closed loop never runs: between drives the motor gets 0 V, as if disabled, so an arm or elevator can settle under gravity. Use this until the gains are tuned, since an untuned closed loop can oscillate or run away."
            : "The closed loop holds the mechanism where each drive stops. If it moves away from there or does not settle within a second, verification cuts to 0 V and stops. Only use this once the gains hold the mechanism."}
        </p>
      </div>

      {!verifying ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={begin} disabled={starting}>
            <Play data-icon="inline-start" />
            {rangeVerified ? "Re-verify range" : "Start verification"}
          </Button>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {verifyHold === "zeroVolts"
              ? "Applies 0 V to start with. Voltage is only applied while you hold a drive button."
              : "Holds the mechanism where it is with the closed loop. Voltage is only applied while you hold a drive button."}
          </p>
          {!rangeVerified && skipControl}
        </div>
      ) : (
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

          <div className="flex flex-col gap-1.5 text-sm">
            <span className="flex justify-between text-xs uppercase tracking-wide text-muted-foreground">
              <label htmlFor="drive-volts">Drive voltage (magnitude)</label>
              <span className="font-mono normal-case tabular">
                {driving !== null
                  ? `Applying ${formatVolts(appliedVolts)}`
                  : rampingDown
                    ? `Ramping down ${formatVolts(appliedVolts)}`
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
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {`Releasing a drive button lowers the voltage to 0 at ${rampDownRate} V/s, so from ${formatVolts(driveVolts)} it takes ${(driveVolts / rampDownRate).toFixed(2)} s, then holds the position. The mechanism keeps moving while it ramps down. Faults, ends, soft limits, stalls and marking still cut the voltage at once.`}
                </p>
              )}
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Driving down applies this as negative voltage and driving up as positive, so a correctly inverted mechanism moves down on
              negative volts. Use the least voltage that moves the mechanism. Elevators and arms may need more to drive against gravity than with it.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" {...markProps("lower")} disabled={position === undefined}>
              <Flag data-icon="inline-start" />
              {verified.lower === null ? "Mark lower end here" : `Lower: ${fmt(verified.lower)}`}
            </Button>
            <Button variant="outline" {...markProps("upper")} disabled={position === undefined}>
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
      )}

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
}
