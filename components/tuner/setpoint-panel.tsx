"use client"

import { useId, useRef, useState } from "react"
import { Switch } from "@/components/ui/switch"

const FOLLOW_INTERVAL_MS = 100
import { Play, Send } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"
import { SetpointAlternator } from "@/components/tuner/setpoint-alternator"
import { useAxisValues, useNtValue, useTuner } from "@/components/tuner/tuner-context"
import { CardTabs, Notice, Panel } from "@/components/tuner/panel"
import { VoltageDrive, useLiveTune, type LiveTab } from "@/components/tuner/voltage-drive"
import { TravelGauge } from "@/components/tuner/travel-gauge"
import { formatPosition, positionUnit, yamsTopics } from "@/lib/yams/topics"
import { DEFAULT_FLYWHEEL_MAX_RPM, DEFAULT_FLYWHEEL_RANGE, FLYWHEEL_IDLE_VELOCITY, defaultMaxStep } from "@/lib/yams/safety"

/** Why the Live tune step can't be used yet, or null once it can. */
function useLiveTuneLock(): string | null {
  const { status, mechanismName, commandName, rangeVerified, checklistConfirmed, inversionCheck } = useTuner()
  return status !== "connected" || !mechanismName || !commandName
    ? "Choose a mechanism first."
    : !checklistConfirmed
      ? "Complete the pre-motion checklist first."
      : inversionCheck === "pending"
        ? "Check the inversions first, or skip that step if it was already done."
        : !rangeVerified
          ? "Verify the range of motion first. Setpoints are limited to the verified range."
          : null
}

const TABS = [
  ["setpoints", "Setpoints"],
  ["voltage", "Voltage"],
] as const satisfies readonly (readonly [LiveTab, string])[]

export function SetpointPanel() {
  const { kind } = useTuner()
  const { tab, setTab } = useLiveTune()
  return (
    <Panel
      step={5}
      title="Live tune"
      description="Send setpoints while you adjust gains, or drive with voltage. Press Space at any time to stop."
      locked={useLiveTuneLock()}
    >
      <CardTabs label="Setpoints or voltage" tabs={TABS} value={tab} onChange={setTab} />
      {tab === "voltage" ? <VoltageDrive /> : kind === "flywheel" ? <VelocityControl /> : <PositionControl />}
    </Panel>
  )
}

function SessionButton() {
  const { session, starting, startLiveTuning, tuningUnlocked } = useTuner()
  const [error, setError] = useState<string | null>(null)
  if (session === "tune") return null
  return (
    <div className="flex flex-col gap-2">
      <Button
        onClick={async () => setError(await startLiveTuning("tune"))}
        disabled={!tuningUnlocked || starting || session !== null}
        className="self-start"
      >
        <Play data-icon="inline-start" />
        Start Live Tuning
      </Button>
      {session === "verify" && <p className="text-sm text-muted-foreground">Finish range verification first.</p>}
      {session === "voltage" && <p className="text-sm text-muted-foreground">Finish the inversion check first.</p>}
      {session === "jog" && <p className="text-sm text-muted-foreground">Stop driving with voltage first.</p>}
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  )
}

function PositionControl() {
  const { nt, mechanismName, axis, verified, session, requiresRangeVerification, positional } = useTuner()
  const { position, lower, upper } = useAxisValues()
  const t = yamsTopics(mechanismName ?? "")
  const setpoint = useNtValue<number>(t.tuning.setpointPosition)
  const profiled = useNtValue<boolean>(t.data.motionProfile) === true
  const [draft, setDraft] = useState("")
  const [pending, setPending] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The slider's ends, once moved past the verified range or soft limits.
  const [override, setOverride] = useState<{ min: number; max: number } | null>(null)

  const active = session === "tune"
  // A skipped verification leaves no verified range, so soft limits (if any) take over.
  const verifiedBounded = requiresRangeVerification && verified.lower !== null && verified.upper !== null
  const softBounded = positional && !verifiedBounded && lower !== undefined && upper !== undefined && upper > lower
  const bounded = verifiedBounded || softBounded
  const boundLabel = verifiedBounded ? "verified range" : "soft limits"
  const limitLo = verifiedBounded ? (verified.lower as number) : softBounded ? (lower as number) : -360
  const limitHi = verifiedBounded ? (verified.upper as number) : softBounded ? (upper as number) : 360
  // Setpoints are limited to the slider's range, which starts at those limits and can be moved past them.
  const lo = bounded && override ? override.min : limitLo
  const hi = bounded && override ? override.max : limitHi
  const unit = positionUnit(axis)
  const digits = axis === "linear" ? 3 : 1
  const maxStep = defaultMaxStep(axis)
  const sliderMin = bounded ? lo : axis === "linear" ? 0 : -180
  const sliderMax = bounded ? hi : axis === "linear" ? 2 : 180
  const sliderStep = axis === "linear" ? 0.005 : 0.5
  const clamp = (v: number) => (bounded ? Math.min(hi, Math.max(lo, v)) : v)
  const draftNumber = Number(draft)
  const sliderValue = Math.min(
    sliderMax,
    Math.max(
      sliderMin,
      draft !== "" && Number.isFinite(draftNumber)
        ? draftNumber
        : typeof setpoint === "number"
          ? setpoint
          : (position ?? sliderMin),
    ),
  )

  const write = (value: number) => {
    nt.set(t.tuning.setpointPosition, value)
    setPending(null)
    setDraft(value.toFixed(digits))
  }

  const send = (raw: number) => {
    setError(null)
    if (!Number.isFinite(raw)) return setError("Enter a number.")
    let value = raw
    if (bounded && (raw < lo || raw > hi)) {
      value = Math.min(hi, Math.max(lo, raw))
      setError(`Clamped to the slider's range (${formatPosition(lo, axis)} to ${formatPosition(hi, axis)}).`)
    }
    const from = typeof setpoint === "number" ? setpoint : position
    if (!profiled && from !== undefined && Math.abs(value - from) > maxStep) {
      setPending(value)
      return
    }
    write(value)
  }

  const presets = bounded
    ? [
        { label: "Lower", value: lo },
        { label: "25%", value: lo + (hi - lo) * 0.25 },
        { label: "Mid", value: (lo + hi) / 2 },
        { label: "75%", value: lo + (hi - lo) * 0.75 },
        { label: "Upper", value: hi },
      ]
    : axis === "linear"
      ? [0, 0.25, 0.5, 1].map((v) => ({ label: `${v} m`, value: v }))
      : [-90, 0, 90, 180].map((v) => ({ label: `${v}°`, value: v }))

  return (
    <>
      <TravelGauge
        axis={axis}
        position={position}
        setpoint={typeof setpoint === "number" ? setpoint : undefined}
        softLower={lower}
        softUpper={upper}
        verifiedLower={verified.lower}
        verifiedUpper={verified.upper}
      />
      <SessionButton />
      <fieldset disabled={!active} className="flex flex-col gap-3 disabled:opacity-50">
        <legend className="sr-only">Position setpoint</legend>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            send(Number(draft))
          }}
        >
          <label htmlFor="pos-setpoint" className="sr-only">
            {`Setpoint in ${unit}`}
          </label>
          <Input
            id="pos-setpoint"
            type="number"
            step={axis === "linear" ? 0.01 : 1}
            className="font-mono"
            placeholder={`Setpoint (${unit})`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button type="submit">
            <Send data-icon="inline-start" />
            Send
          </Button>
        </form>
        <SliderRow
          label={`Position setpoint slider (${unit})`}
          min={sliderMin}
          max={sliderMax}
          bounds={
            bounded
              ? {
                  set: (min, max, edited) => {
                    setOverride({ min, max })
                    return edited < limitLo || edited > limitHi
                      ? `Warning: ${formatPosition(edited, axis)} is outside the ${boundLabel} of ${formatPosition(limitLo, axis)} to ${formatPosition(limitHi, axis)}.`
                      : null
                  },
                  reset: () => setOverride(null),
                  changed: override !== null,
                }
              : undefined
          }
          digits={digits}
          step={sliderStep}
          value={sliderValue}
          format={(v) => formatPosition(v, axis)}
          onChange={(v) => setDraft(v.toFixed(digits))}
          onCommit={send}
        />
        <div className="flex flex-wrap gap-2">
          {presets.map((p) => (
            <Button key={p.label} size="sm" variant="outline" className="short:h-10 short:px-3.5" onClick={() => send(p.value)}>
              {p.label}
            </Button>
          ))}
        </div>
        {!profiled && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {`No motion profile is configured, so steps larger than ${maxStep} ${unit} need confirmation.`}
          </p>
        )}
      </fieldset>
      <SetpointAlternator
        id="pos-alt"
        active={active}
        unit={unit}
        step={axis === "linear" ? 0.01 : 1}
        defaultA={Number((bounded ? lo + (hi - lo) * 0.25 : 0).toFixed(digits))}
        defaultB={Number((bounded ? lo + (hi - lo) * 0.75 : axis === "linear" ? 0.25 : 45).toFixed(digits))}
        clamp={clamp}
        write={(v) => {
          nt.set(t.tuning.setpointPosition, v)
          setPending(null)
        }}
        confirmMessage={(a, b) =>
          !profiled && Math.abs(b - a) > maxStep
            ? `A and B are ${Math.abs(b - a).toFixed(digits)} ${unit} apart with no motion profile. Each switch will move at full closed-loop effort.`
            : null
        }
      />
      {pending !== null && (
        <div className="flex flex-col gap-2 rounded-md border border-hazard bg-hazard/15 p-3">
          <p className="text-sm leading-relaxed">
            {`Jump to ${formatPosition(pending, axis)}? Without a motion profile the mechanism will move there at full closed-loop effort.`}
          </p>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => write(pending)}>
              Confirm move
            </Button>
            <Button size="sm" variant="outline" onClick={() => setPending(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {error && <Notice tone="warn">{error}</Notice>}
    </>
  )
}

function VelocityControl() {
  const { nt, mechanismName, session, flywheelRange, setFlywheelRange } = useTuner()
  const { min: lo, max: hi } = flywheelRange
  const { velocity } = useAxisValues()
  const t = yamsTopics(mechanismName ?? "")
  const setpoint = useNtValue<number>(t.tuning.setpointVelocity)
  const [draft, setDraft] = useState("")
  const [error, setError] = useState<string | null>(null)
  const active = session === "tune"

  const clampRpm = (v: number) => Math.max(lo, Math.min(hi, v))

  const send = (raw: number) => {
    setError(null)
    if (!Number.isFinite(raw)) return setError("Enter a number.")
    // Idle always gets through, so the flywheel can be stopped whatever the range.
    const value = raw === 0 ? 0 : clampRpm(raw)
    if (value !== raw) setError(`Clamped to the slider's range, ${lo} to ${hi} RPM.`)
    // YAMS ignores a velocity setpoint of exactly 0.
    nt.set(t.tuning.setpointVelocity, value === 0 ? FLYWHEEL_IDLE_VELOCITY : value)
    setDraft(String(Math.round(value)))
  }

  const writeVelocity = (value: number) => {
    // YAMS ignores a velocity setpoint of exactly 0.
    nt.set(t.tuning.setpointVelocity, value === 0 ? FLYWHEEL_IDLE_VELOCITY : value)
  }

  const shownSetpoint = typeof setpoint === "number" ? (Math.abs(setpoint) < 0.01 ? 0 : setpoint) : undefined
  const draftNumber = Number(draft)
  const sliderValue = clampRpm(
    draft !== "" && Number.isFinite(draftNumber) ? draftNumber : (shownSetpoint ?? 0),
  )
  // Presets are fractions of the fastest speed in the range, in whichever direction that is.
  const top = Math.abs(hi) >= Math.abs(lo) ? hi : lo
  const steps = [0.25, 0.5, 0.75, 1].map((f) => Math.round(clampRpm(top * f)))

  return (
    <>
      <div className="grid grid-cols-2 gap-2 font-mono tabular">
        <div className="rounded-md border border-border bg-background px-3 py-2">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Measured</p>
          <p className="text-2xl font-medium">{velocity === undefined ? "-" : `${velocity.toFixed(0)}`}</p>
        </div>
        <div className="rounded-md border border-border bg-background px-3 py-2">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Setpoint</p>
          <p className="text-2xl font-medium">{shownSetpoint === undefined ? "-" : `${shownSetpoint.toFixed(0)}`}</p>
        </div>
      </div>
      <SessionButton />
      <fieldset disabled={!active} className="flex flex-col gap-3 disabled:opacity-50">
        <legend className="sr-only">Velocity setpoint</legend>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            send(Number(draft))
          }}
        >
          <label htmlFor="vel-setpoint" className="sr-only">
            Setpoint in RPM
          </label>
          <Input
            id="vel-setpoint"
            type="number"
            step={50}
            className="font-mono"
            placeholder="Setpoint (RPM)"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button type="submit">
            <Send data-icon="inline-start" />
            Send
          </Button>
        </form>
        <SliderRow
          label="Velocity setpoint slider (RPM)"
          min={lo}
          max={hi}
          bounds={{
            set: (min, max, edited) => {
              setFlywheelRange({ min, max })
              // The range can go past the safety default, but says so.
              return Math.abs(edited) > DEFAULT_FLYWHEEL_MAX_RPM
                ? `Warning: ${Math.round(edited)} RPM is outside the ±${DEFAULT_FLYWHEEL_MAX_RPM} RPM safety limit.`
                : null
            },
            reset: () => setFlywheelRange(DEFAULT_FLYWHEEL_RANGE),
            changed: lo !== DEFAULT_FLYWHEEL_RANGE.min || hi !== DEFAULT_FLYWHEEL_RANGE.max,
          }}
          digits={0}
          step={10}
          value={sliderValue}
          format={(v) => `${Math.round(v)} RPM`}
          onChange={(v) => setDraft(String(Math.round(v)))}
          onCommit={send}
        />
        <p className="text-xs leading-relaxed text-muted-foreground">
          {`Setpoints are limited to the slider's range, which starts at the ±${DEFAULT_FLYWHEEL_MAX_RPM} RPM safety default. Click either end to change it.`}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" className="short:h-10 short:px-3.5" onClick={() => send(0)}>
            Idle (0)
          </Button>
          {steps.map((s) => (
            <Button key={s} size="sm" variant="outline" className="short:h-10 short:px-3.5" onClick={() => send(s)}>
              {`${s} RPM`}
            </Button>
          ))}
        </div>
      </fieldset>
      <SetpointAlternator
        id="vel-alt"
        active={active}
        unit="RPM"
        step={50}
        defaultA={Math.round(clampRpm(top * 0.25))}
        defaultB={Math.round(clampRpm(top * 0.75))}
        clamp={clampRpm}
        write={writeVelocity}
      />
      {error && <Notice tone="warn">{error}</Notice>}
    </>
  )
}

function SliderRow({
  label,
  min,
  max,
  step,
  value,
  format,
  onChange,
  onCommit,
  limitMin,
  limitMax,
  digits,
  bounds,
}: {
  label: string
  min: number
  max: number
  limitMin?: number
  limitMax?: number
  digits: number
  step: number
  value: number
  format: (v: number) => string
  onChange: (v: number) => void
  onCommit: (v: number) => void
  /**
   * When given, the caller owns the slider's ends: min and max are its range, editing an end calls set with no
   * limit other than min below max (set gets the value typed, and returns a note to show or null), and reset puts back its default. Otherwise the ends are this slider's own,
   * within limitMin and limitMax.
   */
  bounds?: { set: (min: number, max: number, edited: number) => string | null; reset: () => void; changed: boolean }
}) {
  const first = (v: number | readonly number[]) => (Array.isArray(v) ? v[0] : (v as number))
  const [follow, setFollow] = useState(false)
  const [customMin, setCustomMin] = useState<number | null>(null)
  const [customMax, setCustomMax] = useState<number | null>(null)
  // The ends' notes, shown one under the other below the slider so two long warnings never overlap.
  const [minNote, setMinNote] = useState<string | null>(null)
  const [maxNote, setMaxNote] = useState<string | null>(null)
  const lastSent = useRef(0)
  const switchId = useId()

  const within = (v: number) => {
    let next = v
    if (limitMin !== undefined) next = Math.max(limitMin, next)
    if (limitMax !== undefined) next = Math.min(limitMax, next)
    return next
  }
  const effMin = bounds ? min : within(customMin ?? min)
  const effMaxRaw = bounds ? max : within(customMax ?? max)
  const effMax = effMaxRaw > effMin ? effMaxRaw : Math.max(effMin + step, max)
  const shown = Math.min(effMax, Math.max(effMin, value))

  return (
    <div className="flex flex-col gap-2">
      <Slider
        aria-label={label}
        min={effMin}
        max={effMax}
        step={step}
        value={shown}
        onValueChange={(v) => {
          const next = first(v)
          onChange(next)
          // Throttled so dragging doesn't flood NetworkTables; the release always sends the final value.
          if (follow && Date.now() - lastSent.current >= FOLLOW_INTERVAL_MS) {
            lastSent.current = Date.now()
            onCommit(next)
          }
        }}
        onValueCommitted={(v) => onCommit(first(v))}
      />
      <div className="flex items-center justify-between gap-2 font-mono text-xs text-muted-foreground tabular">
        <EditableBound
          label="Slider minimum"
          value={effMin}
          digits={digits}
          step={step}
          format={format}
          onNote={setMinNote}
          onSubmit={(v) => {
            if (bounds) {
              if (v >= effMax) return `Minimum must be below ${format(effMax)}.`
              return bounds.set(v, effMax, v)
            }
            const next = within(v)
            if (next >= effMax) return `Minimum must be below ${format(effMax)}.`
            setCustomMin(next)
            return next !== v ? `Limited to ${format(next)}.` : null
          }}
        />
        <label htmlFor={switchId} className="flex items-center gap-2 font-sans">
          <Switch id={switchId} size="sm" checked={follow} onCheckedChange={setFollow} />
          {follow ? "Following slider" : "Follow slider (otherwise sends on release)"}
        </label>
        <EditableBound
          label="Slider maximum"
          value={effMax}
          digits={digits}
          step={step}
          format={format}
          align="end"
          onNote={setMaxNote}
          onSubmit={(v) => {
            if (bounds) {
              if (v <= effMin) return `Maximum must be above ${format(effMin)}.`
              return bounds.set(effMin, v, v)
            }
            const next = within(v)
            if (next <= effMin) return `Maximum must be above ${format(effMin)}.`
            setCustomMax(next)
            return next !== v ? `Limited to ${format(next)}.` : null
          }}
        />
      </div>
      {(minNote || maxNote) && (
        <div role="status" className="flex flex-col gap-0.5 text-xs leading-relaxed text-hazard">
          {minNote && <p>{minNote}</p>}
          {maxNote && <p>{maxNote}</p>}
        </div>
      )}
      {(bounds ? bounds.changed : customMin !== null || customMax !== null) && (
        <button
          type="button"
          className="self-start font-sans text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          onClick={() => {
            setMinNote(null)
            setMaxNote(null)
            if (bounds) return bounds.reset()
            setCustomMin(null)
            setCustomMax(null)
          }}
        >
          Reset slider range
        </button>
      )}
    </div>
  )
}

export function EditableBound({
  label,
  value,
  digits,
  step,
  format,
  align = "start",
  onSubmit,
  onNote,
}: {
  label: string
  value: number
  digits: number
  step: number
  format: (v: number) => string
  align?: "start" | "end"
  onSubmit: (v: number) => string | null
  /** When given, the note from onSubmit goes here for the parent to show, instead of floating under this bound. */
  onNote?: (note: string | null) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const [note, setNote] = useState<string | null>(null)
  const cancelled = useRef(false)

  const commit = () => {
    setEditing(false)
    if (cancelled.current) {
      cancelled.current = false
      return
    }
    const parsed = Number(draft)
    if (draft.trim() === "" || !Number.isFinite(parsed)) {
      setNote(null)
      return
    }
    const next = onSubmit(parsed)
    if (onNote) onNote(next)
    else setNote(next)
  }

  return (
    <div className={`relative flex flex-col ${align === "end" ? "items-end" : "items-start"}`}>
      {editing ? (
        <input
          aria-label={label}
          type="number"
          step={step}
          autoFocus
          className="w-24 rounded-sm border border-ring bg-background px-1.5 py-0.5 font-mono text-xs text-foreground outline-none"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return
            if (e.key === "Enter") {
              e.preventDefault()
              e.currentTarget.blur()
            } else if (e.key === "Escape") {
              cancelled.current = true
              e.currentTarget.blur()
            }
          }}
        />
      ) : (
        <button
          type="button"
          title="Click to edit"
          aria-label={`${label}: ${format(value)}. Click to edit.`}
          className="rounded-sm border border-dashed border-transparent px-1.5 py-0.5 hover:border-border hover:text-foreground focus-visible:border-ring focus-visible:outline-none"
          onClick={() => {
            setDraft(value.toFixed(digits))
            setNote(null)
            setEditing(true)
          }}
        >
          {format(value)}
        </button>
      )}
      {note && (
        <span role="status" className="pointer-events-none absolute top-full mt-1 whitespace-nowrap font-sans text-hazard">
          {note}
        </span>
      )}
    </div>
  )
}
