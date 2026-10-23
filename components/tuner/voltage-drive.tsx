"use client"

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { ChevronLeft, ChevronRight, Play } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"
import { useAxisValues, useNtValue, useTuner } from "@/components/tuner/tuner-context"
import { Notice } from "@/components/tuner/panel"
import { TravelGauge } from "@/components/tuner/travel-gauge"
import { EditableBound } from "@/components/tuner/setpoint-panel"
import { axisReader, formatPosition, yamsTopics } from "@/lib/yams/topics"
import { jogParams } from "@/lib/yams/safety"

type Dir = -1 | 1
/** What letting go of a drive button does: cut the voltage to 0 at once, or ramp it down to 0. */
type Release = "cut" | "ramp"

const DEFAULT_VOLTS = 1
/** Battery voltage: nothing above this can be applied anyway. */
const HARD_LIMIT_VOLTS = 12
const LOOP_MS = 20
/** Within this many reach tolerances of an end, the voltage is halved to limit overshoot. */
const SLOW_ZONE_TOLERANCES = 8
/** The gravity hold voltage stays within this, in volts: it only has to balance the mechanism's weight. */
const MAX_GRAVITY_VOLTS = 3
const GRAVITY_STEP_VOLTS = 0.02

export interface VoltageSettings {
  /** The drive voltage's magnitude, between minVolts and maxVolts. */
  volts: number
  minVolts: number
  maxVolts: number
  /** Voltage ramps from 0 to the drive voltage over this long, so a press never slams the mechanism. */
  rampUpMs: number
  /** Halve the voltage near an end of the range. */
  slowNearEnds: boolean
  release: Release
  /** Volts per second, when the release ramps down. */
  rampDownRate: number
  /** An elevator's or arm's gravity hold voltage, added to every drive and sent between presses (kG for an arm). */
  gravityVolts: number
}

const DEFAULT_SETTINGS: VoltageSettings = {
  volts: DEFAULT_VOLTS,
  minVolts: 0.25,
  maxVolts: 3,
  rampUpMs: 400,
  slowNearEnds: true,
  release: "cut",
  rampDownRate: 4,
  gravityVolts: 0,
}

export type LiveTab = "setpoints" | "voltage"

interface LiveTuneApi {
  /** The Live tune card's tab. On Voltage, the Settings card gets a Voltage tab with these settings. */
  tab: LiveTab
  setTab: (tab: LiveTab) => void
  settings: VoltageSettings
  update: (next: Partial<VoltageSettings>) => void
}

const LiveTuneContext = createContext<LiveTuneApi | null>(null)

/** Shared by the Live tune and Settings cards. Starts over for each mechanism. */
export function LiveTuneProvider({ children }: { children: ReactNode }) {
  const [tab, setTab] = useState<LiveTab>("setpoints")
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const update = useCallback((next: Partial<VoltageSettings>) => setSettings((s) => ({ ...s, ...next })), [])
  return <LiveTuneContext.Provider value={{ tab, setTab, settings, update }}>{children}</LiveTuneContext.Provider>
}

export function useLiveTune(): LiveTuneApi {
  const api = useContext(LiveTuneContext)
  if (!api) throw new Error("useLiveTune must be used inside LiveTuneProvider")
  return api
}

const formatVolts = (v: number) => `${v.toFixed(2)} V`

/** The voltage that holds an elevator up, or an arm at an angle (0° is level), when a gravity hold voltage is set. */
function holdVolts(kind: string, gravity: number, pos: number | undefined) {
  if (gravity === 0 || pos === undefined || (kind !== "elevator" && kind !== "arm")) return 0
  const v = kind === "arm" ? gravity * Math.cos((pos * Math.PI) / 180) : gravity
  return Math.round(v * 1000) / 1000
}

/**
 * The Live tune card's Voltage tab. Drives the mechanism with voltage while a button is held, like finding the range of
 * motion but with nothing to mark. It stops at the ends of the verified range (or the soft limits). During Live Tuning,
 * letting go hands back to the closed loop, which holds where it stopped. Otherwise the motor gets 0 V (or the gravity
 * hold voltage) between presses. The settings are in the Settings card's Voltage tab.
 */
export function VoltageDrive() {
  const { nt, mechanismName, axis, kind, session, starting, startLiveTuning, stop, verified, positional, tuningUnlocked } =
    useTuner()
  const { settings } = useLiveTune()
  const { position, lower: softLower, upper: softUpper } = useAxisValues()
  const topics = mechanismName ? yamsTopics(mechanismName) : null
  // Subscribing re-renders when the topic is announced by a YAMS version that supports it.
  useNtValue<boolean>(topics?.tuning.voltageEnabled ?? null)
  const supported = !!topics && nt.isAnnounced(topics.tuning.voltageEnabled) && nt.isAnnounced(topics.tuning.voltageSetpoint)

  const [driving, setDriving] = useState<Dir | null>(null)
  const [rampingDown, setRampingDown] = useState(false)
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
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  /** The voltage last sent, which a ramp down starts from. */
  const sentVolts = useRef(0)
  /** A flywheel's velocity setpoint before the drive, restored when Live Tuning takes back over. */
  const heldVelocity = useRef<number | null>(null)
  const holdAt = useCallback(
    (pos: number | undefined) => holdVolts(kind, settingsRef.current.gravityVolts, pos),
    [kind],
  )

  const endDrive = useCallback(() => {
    if (timer.current !== null) {
      clearInterval(timer.current)
      timer.current = null
    }
    setDriving(null)
    setRampingDown(false)
    setApplied(0)
    sentVolts.current = 0
    if (!mechanismName) return
    const t = yamsTopics(mechanismName)
    const pos = axisReader(nt, mechanismName, axis).position()
    if (sessionRef.current === "tune") {
      // Seed the closed loop before releasing voltage, so it holds where the drive stopped instead of jumping back.
      if (flywheel) {
        if (heldVelocity.current !== null) nt.set(t.tuning.setpointVelocity, heldVelocity.current)
      } else if (pos !== undefined) nt.set(t.tuning.setpointPosition, pos)
      nt.set(t.tuning.voltageSetpoint, 0)
      nt.set(t.tuning.voltageEnabled, false)
    } else if (sessionRef.current === "jog") {
      // Stay in voltage mode: the closed loop may not be tuned yet. 0 V, or the gravity hold voltage.
      const hold = holdAt(pos)
      nt.set(t.tuning.voltageSetpoint, hold)
      nt.set(t.tuning.voltageEnabled, true)
      setApplied(hold)
    }
    heldVelocity.current = null
  }, [nt, mechanismName, axis, flywheel, holdAt])

  useEffect(() => {
    if (!active && timer.current !== null) endDrive()
  }, [active, endDrive])
  useEffect(() => () => endDrive(), [endDrive])

  // Between presses with voltage only, keep sending the gravity hold voltage: an arm's changes with its angle.
  useEffect(() => {
    if (session !== "jog" || settings.gravityVolts === 0 || !mechanismName) return
    const reader = axisReader(nt, mechanismName, axis)
    const t = yamsTopics(mechanismName)
    let last: number | null = null
    const id = window.setInterval(() => {
      if (timer.current !== null || sessionRef.current !== "jog") {
        last = null
        return
      }
      const v = holdAt(reader.position())
      if (v === last) return
      last = v
      nt.set(t.tuning.voltageSetpoint, v)
      nt.set(t.tuning.voltageEnabled, true)
    }, LOOP_MS)
    return () => clearInterval(id)
  }, [session, settings.gravityVolts, mechanismName, nt, axis, holdAt])

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
    nt.set(t.tuning.voltageSetpoint, holdAt(startPos))
    nt.set(t.tuning.voltageEnabled, true)
    setDriving(dir)

    const startedAt = performance.now()
    const { volts: drive, rampUpMs, slowNearEnds } = settingsRef.current
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
      const ramp = rampUpMs > 0 ? Math.min(1, (performance.now() - startedAt) / rampUpMs) : 1
      // Near an end, but never across more than a quarter of the range, or a short range would be driven at half voltage.
      const range = boundsRef.current ? boundsRef.current[1] - boundsRef.current[0] : Infinity
      const slowZone = Math.min(params.reachTolerance * SLOW_ZONE_TOLERANCES, range / 4)
      const slow = slowNearEnds && !flywheel && target !== undefined && pos !== undefined && Math.abs(target - pos) <= slowZone
      // On top of the gravity hold voltage, so driving up and down feel the same.
      const out = Math.round((holdAt(pos) + dir * drive * ramp * (slow ? 0.5 : 1)) * 1000) / 1000
      if (out !== sent) {
        sent = out
        sentVolts.current = out
        nt.set(t.tuning.voltageSetpoint, out)
        setApplied(out)
      }
    }, LOOP_MS)
  }

  /** Letting go: cut at once, or ramp down to the hold voltage first. Reaching an end always cuts at once. */
  const releaseDrive = () => {
    if (timer.current === null || rampingDown) return
    const { release, rampDownRate } = settingsRef.current
    if (release === "cut" || !mechanismName) {
      endDrive()
      return
    }
    clearInterval(timer.current)
    const reader = axisReader(nt, mechanismName, axis)
    const t = yamsTopics(mechanismName)
    const params = jogParams(axis)
    const dir = driving
    let out = sentVolts.current
    setDriving(null)
    setRampingDown(true)
    timer.current = window.setInterval(() => {
      if (sessionRef.current !== "tune" && sessionRef.current !== "jog") {
        endDrive()
        return
      }
      const pos = reader.position()
      const end = dir === null ? undefined : boundsRef.current?.[dir > 0 ? 1 : 0]
      if (!flywheel && dir !== null && end !== undefined && pos !== undefined && (end - pos) * dir <= params.reachTolerance) {
        endDrive()
        return
      }
      const goal = holdAt(pos)
      const step = (rampDownRate * LOOP_MS) / 1000
      out = Math.abs(out - goal) <= step ? goal : out - Math.sign(out - goal) * step
      if (out === goal) {
        endDrive()
        return
      }
      const v = Math.round(out * 1e6) / 1e6
      sentVolts.current = v
      nt.set(t.tuning.voltageSetpoint, v)
      setApplied(v)
    }, LOOP_MS)
  }

  const holdProps = (dir: Dir) => ({
    disabled: !active || !supported,
    onPointerDown: (e: React.PointerEvent) => {
      e.currentTarget.setPointerCapture(e.pointerId)
      beginDrive(dir)
    },
    onPointerUp: () => releaseDrive(),
    onPointerCancel: () => releaseDrive(),
    onLostPointerCapture: () => releaseDrive(),
    onBlur: () => {
      if (driving === dir) releaseDrive()
    },
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  })
  const holdClass =
    "flex min-h-14 touch-none select-none items-center justify-center gap-2 rounded-md border border-border bg-background px-3 text-center font-medium disabled:opacity-50 data-[active=true]:border-foreground data-[active=true]:bg-hazard data-[active=true]:text-hazard-foreground"

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
          {`Hold: drive ${negLabel} (−${formatVolts(settings.volts)})`}
        </button>
        <button type="button" {...holdProps(1)} className={holdClass} data-active={driving === 1}>
          {`Hold: drive ${posLabel} (+${formatVolts(settings.volts)})`}
          <ChevronRight className="size-5" aria-hidden />
        </button>
      </div>
      <p className="font-mono text-sm tabular" aria-live="off">
        {rampingDown ? `Ramping down ${formatVolts(applied)}` : `Applied ${formatVolts(applied)}`}
      </p>
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
              : settings.gravityVolts !== 0
                ? "Between presses the motor gets the gravity hold voltage."
                : "Between presses the motor gets 0 V, so gravity can move it. Set a gravity hold voltage, or start Live Tuning to hold it with the closed loop."}
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
      <p className="text-xs text-muted-foreground">Change the voltage and how it ramps in the Settings card&apos;s Voltage tab. Space stops everything.</p>
    </>
  )
}

/** The Settings card's Voltage tab, shown while the Live tune card is on its Voltage tab: the drive's settings. */
export function VoltageSettingsPanel() {
  const { nt, mechanismName, kind } = useTuner()
  const { settings, update } = useLiveTune()
  const { volts, minVolts, maxVolts, rampUpMs, slowNearEnds, release, rampDownRate, gravityVolts } = settings
  const gravityLoaded = kind === "elevator" || kind === "arm"
  const kGTopic = mechanismName ? `${yamsTopics(mechanismName).tuningPrefix}closedloop/feedforward/kG` : null
  const robotKG = useNtValue<number>(kGTopic)

  return (
    <>
      <Group label="Drive voltage">
        <div className="flex justify-between font-mono text-sm tabular">
          <span className="text-muted-foreground">Magnitude</span>
          <span>{formatVolts(volts)}</span>
        </div>
        <Slider
          aria-label="Drive voltage"
          min={minVolts}
          max={maxVolts}
          step={0.05}
          value={Math.min(maxVolts, Math.max(minVolts, volts))}
          onValueChange={(v) => update({ volts: Math.round((Array.isArray(v) ? v[0] : v) * 100) / 100 })}
        />
        <div className="flex items-center justify-between font-mono text-xs text-muted-foreground tabular">
          <EditableBound
            label="Minimum drive voltage"
            value={minVolts}
            digits={2}
            step={0.05}
            format={formatVolts}
            onSubmit={(v) => {
              const next = Math.max(0.05, v)
              if (next >= maxVolts) return `Minimum must be below ${formatVolts(maxVolts)}.`
              update({ minVolts: next, volts: Math.max(volts, next) })
              return next !== v ? `Raised to ${formatVolts(next)}.` : null
            }}
          />
          <EditableBound
            label="Maximum drive voltage"
            value={maxVolts}
            digits={2}
            step={0.1}
            format={formatVolts}
            align="end"
            onSubmit={(v) => {
              const next = Math.min(HARD_LIMIT_VOLTS, v)
              if (next <= minVolts) return `Maximum must be above ${formatVolts(minVolts)}.`
              update({ maxVolts: next, volts: Math.min(volts, next) })
              return next !== v ? `Limited to ${formatVolts(next)}.` : null
            }}
          />
        </div>
      </Group>

      <Group label="Ramp up">
        <NumberField
          id="ramp-up"
          label="Time to reach the drive voltage"
          unit="ms"
          value={rampUpMs}
          min={0}
          max={5000}
          onCommit={(v) => update({ rampUpMs: Math.round(v) })}
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-foreground"
            checked={slowNearEnds}
            onChange={(e) => update({ slowNearEnds: e.target.checked })}
          />
          Halve the voltage near an end of the range
        </label>
      </Group>

      <Group label="When a drive button is released">
        <div role="radiogroup" aria-label="When a drive button is released" className="grid grid-cols-2 gap-1 rounded-md border border-border p-1">
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
              onClick={() => update({ release: value })}
              className="rounded px-3 py-1.5 text-sm font-medium text-muted-foreground aria-checked:bg-secondary aria-checked:text-foreground"
            >
              {label}
            </button>
          ))}
        </div>
        {release === "ramp" && (
          <>
            <NumberField
              id="ramp-down"
              label="Ramp down rate"
              unit="V/s"
              value={rampDownRate}
              min={0.01}
              max={100}
              onCommit={(v) => update({ rampDownRate: v })}
            />
            <p className="text-xs leading-relaxed text-muted-foreground">
              {`From ${formatVolts(volts)} that takes ${((volts / rampDownRate) * 1000).toFixed(0)} ms, and the mechanism keeps moving meanwhile. Reaching an end still cuts at once.`}
            </p>
          </>
        )}
      </Group>

      {gravityLoaded && (
        <Group label="Gravity hold voltage">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              aria-label="Lower the gravity hold voltage"
              onClick={() => update({ gravityVolts: clampGravity(gravityVolts - GRAVITY_STEP_VOLTS) })}
            >
              −
            </Button>
            <NumberField
              id="gravity-volts"
              label="Gravity hold voltage"
              hideLabel
              unit="V"
              value={gravityVolts}
              min={-MAX_GRAVITY_VOLTS}
              max={MAX_GRAVITY_VOLTS}
              onCommit={(v) => update({ gravityVolts: clampGravity(v) })}
            />
            <Button
              variant="outline"
              size="sm"
              aria-label="Raise the gravity hold voltage"
              onClick={() => update({ gravityVolts: clampGravity(gravityVolts + GRAVITY_STEP_VOLTS) })}
            >
              +
            </Button>
            {typeof robotKG === "number" && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={gravityVolts === clampGravity(robotKG)}
                  onClick={() => update({ gravityVolts: clampGravity(robotKG) })}
                >
                  {`Use robot kG (${formatVolts(robotKG)})`}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!kGTopic || gravityVolts === clampGravity(robotKG)}
                  onClick={() => kGTopic && nt.set(kGTopic, gravityVolts)}
                >
                  Set kG to this
                </Button>
              </>
            )}
            <Button variant="outline" size="sm" disabled={gravityVolts === 0} onClick={() => update({ gravityVolts: 0 })}>
              Set to 0 V
            </Button>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {`${kind === "arm" ? "Holds the arm level, like kG, scaled by the cosine of the angle (0° is level)." : "Holds the elevator up, like kG."} Drives add to it, and with voltage only it is sent between presses. Starts at 0 V; up to ${MAX_GRAVITY_VOLTS} V.`}
          </p>
        </Group>
      )}
    </>
  )
}

const clampGravity = (v: number) => Math.max(-MAX_GRAVITY_VOLTS, Math.min(MAX_GRAVITY_VOLTS, Math.round(v * 1000) / 1000))

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</h3>
      {children}
    </div>
  )
}

/** A number that applies on Enter or when you click away, and goes back to the last value if it isn't valid. */
function NumberField({
  id,
  label,
  hideLabel,
  unit,
  value,
  min,
  max,
  onCommit,
}: {
  id: string
  label: string
  hideLabel?: boolean
  unit: string
  value: number
  min: number
  max: number
  onCommit: (v: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft === null) return
    const v = Number(draft)
    if (draft.trim() !== "" && Number.isFinite(v)) onCommit(Math.min(max, Math.max(min, v)))
    setDraft(null)
  }
  return (
    <div className="flex items-center gap-2 text-sm">
      {!hideLabel && (
        <label htmlFor={id} className="text-muted-foreground">
          {label}
        </label>
      )}
      <Input
        id={id}
        type="number"
        step="any"
        inputMode="decimal"
        aria-label={hideLabel ? label : undefined}
        className="h-8 w-24 font-mono"
        value={draft ?? String(value)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            commit()
          } else if (e.key === "Escape") {
            e.preventDefault()
            setDraft(null)
          }
        }}
      />
      <span className="text-muted-foreground">{unit}</span>
    </div>
  )
}
