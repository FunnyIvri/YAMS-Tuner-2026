"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { ChevronLeft, ChevronRight, Play } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useAxisValues, useNtValue, useTuner } from "@/components/tuner/tuner-context"
import { Field, Notice } from "@/components/tuner/panel"
import { TravelGauge } from "@/components/tuner/travel-gauge"
import { axisReader, formatPosition, yamsTopics } from "@/lib/yams/topics"
import { jogParams } from "@/lib/yams/safety"

type Dir = -1 | 1

const DEFAULT_VOLTS = 1
const MIN_VOLTS = 0.25
const MAX_VOLTS = 6
/** Voltage ramps from 0 to the drive voltage over this long, so a press never slams the mechanism. */
const RAMP_MS = 400
/** Within this many reach tolerances of an end, the voltage is halved to limit overshoot. */
const SLOW_ZONE_TOLERANCES = 8
const LOOP_MS = 20

/**
 * The Live tune card's Voltage tab. Drives the mechanism with voltage while a button is held, like finding the range of motion but with nothing to mark.
 * It stops at the ends of the verified range (or the soft limits). During Live Tuning, letting go hands back to the
 * closed loop, which holds where it stopped. Otherwise the motor gets 0 V between presses.
 */
export function VoltageDrive() {
  const { nt, mechanismName, axis, kind, session, starting, startLiveTuning, stop, verified, positional, tuningUnlocked } =
    useTuner()
  const { position, lower: softLower, upper: softUpper } = useAxisValues()
  const topics = mechanismName ? yamsTopics(mechanismName) : null
  // Subscribing re-renders when the topic is announced by a YAMS version that supports it.
  useNtValue<boolean>(topics?.tuning.voltageEnabled ?? null)
  const supported = !!topics && nt.isAnnounced(topics.tuning.voltageEnabled) && nt.isAnnounced(topics.tuning.voltageSetpoint)

  const [volts, setVolts] = useState(DEFAULT_VOLTS)
  const [voltsText, setVoltsText] = useState(String(DEFAULT_VOLTS))
  const [driving, setDriving] = useState<Dir | null>(null)
  const [applied, setApplied] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const flywheel = kind === "flywheel"
  const [negLabel, posLabel] = kind === "elevator" ? ["down", "up"] : ["reverse", "forward"]
  const active = session === "tune" || session === "jog"
  const verifiedBounded = verified.lower !== null && verified.upper !== null
  // The verified range bounds travel; with none (skipped, or a continuous pivot) the robot's soft limits do.
  const bounds: [number, number] | null = !positional
    ? null
    : verifiedBounded
      ? [verified.lower as number, verified.upper as number]
      : softLower !== undefined && softUpper !== undefined
        ? [softLower, softUpper]
        : null
  const boundLabel = verifiedBounded ? "verified range" : "soft limits"

  const timer = useRef<number | null>(null)
  const sessionRef = useRef(session)
  sessionRef.current = session
  /** A flywheel's velocity setpoint before the drive, restored when Live Tuning takes back over. */
  const heldVelocity = useRef<number | null>(null)

  const endDrive = useCallback(() => {
    if (timer.current !== null) {
      clearInterval(timer.current)
      timer.current = null
    }
    setDriving(null)
    setApplied(0)
    if (!mechanismName) return
    const t = yamsTopics(mechanismName)
    if (sessionRef.current === "tune") {
      // Seed the closed loop before releasing voltage, so it holds where the drive stopped instead of jumping back.
      if (flywheel) {
        if (heldVelocity.current !== null) nt.set(t.tuning.setpointVelocity, heldVelocity.current)
      } else {
        const pos = axisReader(nt, mechanismName, axis).position()
        if (pos !== undefined) nt.set(t.tuning.setpointPosition, pos)
      }
      nt.set(t.tuning.voltageSetpoint, 0)
      nt.set(t.tuning.voltageEnabled, false)
    } else if (sessionRef.current === "jog") {
      // Stay in voltage mode at 0 V: the closed loop may not be tuned yet.
      nt.set(t.tuning.voltageSetpoint, 0)
      nt.set(t.tuning.voltageEnabled, true)
    }
    heldVelocity.current = null
  }, [nt, mechanismName, axis, flywheel])

  useEffect(() => {
    if (!active && timer.current !== null) endDrive()
  }, [active, endDrive])
  useEffect(() => () => endDrive(), [endDrive])

  const boundsRef = useRef(bounds)
  boundsRef.current = bounds

  const beginDrive = (dir: Dir) => {
    if (!active || !mechanismName || !supported) return
    if (timer.current !== null) endDrive()
    const reader = axisReader(nt, mechanismName, axis)
    const t = yamsTopics(mechanismName)
    const params = jogParams(axis)
    const endOf = (d: Dir) => {
      const b = boundsRef.current
      return b ? (d > 0 ? b[1] : b[0]) : undefined
    }
    const startPos = reader.position()
    setNote(null)
    setError(null)
    const end = endOf(dir)
    if (!flywheel) {
      if (startPos === undefined) return setError("No position telemetry. Set the telemetry verbosity to HIGH on the robot.")
      if (end !== undefined && (end - startPos) * dir <= params.reachTolerance) {
        return setNote(`Already at the ${dir > 0 ? "upper" : "lower"} end of the ${boundLabel} (${formatPosition(end, axis)}).`)
      }
    }
    heldVelocity.current = flywheel ? (nt.getNumber(t.tuning.setpointVelocity) ?? null) : null
    nt.set(t.tuning.voltageSetpoint, 0)
    nt.set(t.tuning.voltageEnabled, true)
    setDriving(dir)

    const startedAt = performance.now()
    const drive = volts
    let sent = 0
    timer.current = window.setInterval(() => {
      if (sessionRef.current !== "tune" && sessionRef.current !== "jog") {
        endDrive()
        return
      }
      const pos = reader.position()
      const target = endOf(dir)
      if (!flywheel) {
        if (pos === undefined) {
          endDrive()
          return
        }
        if (target !== undefined && (target - pos) * dir <= params.reachTolerance) {
          endDrive()
          setNote(`Stopped at the ${dir > 0 ? "upper" : "lower"} end of the ${boundLabel} (${formatPosition(target, axis)}).`)
          return
        }
      }
      const ramp = Math.min(1, (performance.now() - startedAt) / RAMP_MS)
      // Near an end, but never across more than a quarter of the range, or a short range would be driven at half voltage.
      const range = boundsRef.current ? boundsRef.current[1] - boundsRef.current[0] : Infinity
      const slowZone = Math.min(params.reachTolerance * SLOW_ZONE_TOLERANCES, range / 4)
      const slow = !flywheel && target !== undefined && pos !== undefined && Math.abs(target - pos) <= slowZone
      const out = Math.round(dir * drive * ramp * (slow ? 0.5 : 1) * 1000) / 1000
      if (out !== sent) {
        sent = out
        nt.set(t.tuning.voltageSetpoint, out)
        setApplied(out)
      }
    }, LOOP_MS)
  }

  const holdProps = (dir: Dir) => ({
    disabled: !active || !supported,
    onPointerDown: (e: React.PointerEvent) => {
      e.currentTarget.setPointerCapture(e.pointerId)
      beginDrive(dir)
    },
    onPointerUp: () => endDrive(),
    onPointerCancel: () => endDrive(),
    onLostPointerCapture: () => endDrive(),
    onBlur: () => {
      if (driving === dir) endDrive()
    },
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  })
  const holdClass =
    "flex min-h-14 touch-none select-none items-center justify-center gap-2 rounded-md border border-border bg-background px-3 text-center font-medium disabled:opacity-50 data-[active=true]:border-foreground data-[active=true]:bg-hazard data-[active=true]:text-hazard-foreground"

  const setVoltsFrom = (text: string) => {
    setVoltsText(text)
    const v = Number(text)
    if (text.trim() !== "" && Number.isFinite(v) && v >= MIN_VOLTS && v <= MAX_VOLTS) setVolts(v)
  }

  return (
    <>
      <p className="text-sm leading-relaxed text-muted-foreground">
        {bounds
          ? `Hold a button to move the mechanism with voltage. It stops at the ends of the ${boundLabel}.`
          : "Hold a button to move the mechanism with voltage."}
      </p>
      {!supported && <Notice tone="warn">This YAMS version can&apos;t drive with voltage. Update YAMS on the robot.</Notice>}
      {positional && (
        <TravelGauge
          axis={axis}
          position={position}
          softLower={softLower}
          softUpper={softUpper}
          verifiedLower={verified.lower}
          verifiedUpper={verified.upper}
        />
      )}
      <div className="grid grid-cols-2 gap-2">
        <button type="button" {...holdProps(-1)} className={holdClass} data-active={driving === -1}>
          <ChevronLeft className="size-5" aria-hidden />
          {`Hold: drive ${negLabel}`}
        </button>
        <button type="button" {...holdProps(1)} className={holdClass} data-active={driving === 1}>
          {`Hold: drive ${posLabel}`}
          <ChevronRight className="size-5" aria-hidden />
        </button>
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <div className="w-32">
          <Field label="Voltage (V)" htmlFor="drive-volts">
            <Input
              id="drive-volts"
              type="number"
              inputMode="decimal"
              min={MIN_VOLTS}
              max={MAX_VOLTS}
              step={0.25}
              className="font-mono"
              aria-invalid={Number(voltsText) !== volts}
              value={voltsText}
              disabled={driving !== null}
              onChange={(e) => setVoltsFrom(e.target.value)}
              onBlur={() => setVoltsText(String(volts))}
            />
          </Field>
        </div>
        <p className="pb-2 font-mono text-sm tabular" aria-live="off">{`Applied ${applied.toFixed(2)} V`}</p>
      </div>
      {!active && (
        <div className="flex flex-col gap-2">
          <Button
            variant="outline"
            className="self-start"
            disabled={!tuningUnlocked || starting || session !== null}
            onClick={async () => setError(await startLiveTuning("jog"))}
          >
            <Play data-icon="inline-start" />
            Start voltage control
          </Button>
          <p className="text-sm text-muted-foreground">Or start Live Tuning on the Setpoints tab, then drive here.</p>
        </div>
      )}
      {session === "jog" && (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => stop("Voltage control stopped")}>
            Done
          </Button>
          <p className="text-sm text-muted-foreground">
            {flywheel
              ? "Between presses the motor gets 0 V and the flywheel coasts."
              : "Between presses the motor gets 0 V, so gravity can move it. Start Live Tuning to hold it with the closed loop instead."}
          </p>
        </div>
      )}
      {session === "tune" && (
        <p className="text-sm text-muted-foreground">
          {flywheel
            ? "Letting go hands back to Live Tuning at the setpoint it had."
            : "Letting go hands back to Live Tuning, which holds where it stopped."}
        </p>
      )}
      {note && <Notice>{note}</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}
      <p className="text-xs text-muted-foreground">{`Between ${MIN_VOLTS} and ${MAX_VOLTS} V. It ramps up over ${RAMP_MS} ms and halves near an end. Space stops everything.`}</p>
    </>
  )
}
