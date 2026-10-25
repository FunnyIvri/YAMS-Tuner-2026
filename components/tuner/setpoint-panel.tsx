"use client"

import { useId, useRef, useState } from "react"
import { Switch } from "@/components/ui/switch"

const FOLLOW_INTERVAL_MS = 100
import { Play, Send } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"
import { SetpointAlternator } from "@/components/tuner/setpoint-alternator"
import { useAxisValues, useNtValue, useNtVersion, useTuner } from "@/components/tuner/tuner-context"
import { CardTabPanel, CardTabs, LiveRegion, Notice, Panel } from "@/components/tuner/panel"
import { VoltageDrive, useLiveTune, type LiveTab } from "@/components/tuner/voltage-drive"
import { TravelGauge } from "@/components/tuner/travel-gauge"
import { WheelPicker } from "@/components/tuner/wheel-picker"
import { formatPosition, positionUnit, wheelLabels, yamsTopics } from "@/lib/yams/topics"
import { cn } from "@/lib/utils"
import { EMPTY, num } from "@/lib/format"
import { DEFAULT_FLYWHEEL_MAX_RPM, DEFAULT_FLYWHEEL_RANGE, FLYWHEEL_IDLE_VELOCITY, defaultMaxStep, overshootTolerance } from "@/lib/yams/safety"

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
  const { kind, wheels, wheel } = useTuner()
  const { tab, setTab } = useLiveTune()
  return (
    <Panel
      step={5}
      title="Live tune"
      description="Send setpoints while you adjust gains, or drive with voltage. Press Space at any time to stop."
      locked={useLiveTuneLock()}
    >
      <CardTabs label="Setpoints or voltage" tabs={TABS} value={tab} onChange={setTab} />
      <CardTabPanel label="Setpoints or voltage" value={tab}>
        {tab === "voltage" ? (
          <>
            <WheelPicker />
            {/* A new wheel starts a new drive: the old wheel goes back to its closed loop. */}
            <VoltageDrive key={wheel ?? ""} />
          </>
        ) : kind === "flywheel" ? (
          wheels.length > 1 ? (
            <DoubleVelocityControl />
          ) : (
            <VelocityControl />
          )
        ) : (
          <PositionControl />
        )}
      </CardTabPanel>
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
      <LiveRegion assertive>
        {error && (
          <Notice tone="danger" live={false}>
            {error}
          </Notice>
        )}
      </LiveRegion>
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
  // Outside the range, say after sagging while disabled. Live Tuning may still start, to bring it back.
  const tol = overshootTolerance(axis)
  const outside =
    bounded && position !== undefined ? (position < limitLo - tol ? "below" : position > limitHi + tol ? "above" : null) : null
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
      setError(`Limited to the slider’s range (${formatPosition(lo, axis)} to ${formatPosition(hi, axis)}).`)
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
      {session === null && outside && (
        <Notice tone="warn">
          {`The mechanism is ${outside} the ${boundLabel} (${outside === "below" ? "lower" : "upper"} end ${formatPosition(outside === "below" ? limitLo : limitHi, axis)}). Start Live Tuning, then send a setpoint inside the range to bring it back. It holds where it is until then, and moving further out stops it.`}
        </Notice>
      )}
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
              {`Move to ${formatPosition(pending, axis)}`}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setPending(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      <LiveRegion>
        {error && (
          <Notice tone="warn" live={false}>
            {error}
          </Notice>
        )}
      </LiveRegion>
    </>
  )
}

/** The flywheel slider's ends, which start at the safety default and can be moved past it, with a warning. */
function useFlywheelBounds() {
  const { flywheelRange, setFlywheelRange } = useTuner()
  const { min: lo, max: hi } = flywheelRange
  return {
    set: (min: number, max: number, edited: number) => {
      setFlywheelRange({ min, max })
      return Math.abs(edited) > DEFAULT_FLYWHEEL_MAX_RPM
        ? `Warning: ${Math.round(edited)} RPM is outside the ±${DEFAULT_FLYWHEEL_MAX_RPM} RPM safety limit.`
        : null
    },
    reset: () => setFlywheelRange(DEFAULT_FLYWHEEL_RANGE),
    changed: lo !== DEFAULT_FLYWHEEL_RANGE.min || hi !== DEFAULT_FLYWHEEL_RANGE.max,
  }
}

/** YAMS ignores a velocity setpoint of exactly 0, so idle is a negligible one. */
const wireVelocity = (rpm: number) => (rpm === 0 ? FLYWHEEL_IDLE_VELOCITY : rpm)
const shownVelocity = (setpoint: number | undefined) =>
  typeof setpoint === "number" ? (Math.abs(setpoint) < 0.01 ? 0 : setpoint) : undefined

/** One wheel's measured speed and setpoint, in RPM. */
function WheelSpeed({ name, label }: { name: string; label: string }) {
  const { velocity } = useAxisValues(name)
  const setpoint = shownVelocity(useNtValue<number>(yamsTopics(name).tuning.setpointVelocity))
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-md border border-border bg-background px-3 py-2 font-mono tabular">
      <p className="truncate text-xs font-medium uppercase tracking-wider text-foreground" title={name}>
        {label}
      </p>
      <p className="flex items-baseline justify-between gap-2">
        <span className="text-xs uppercase tracking-wider text-muted-foreground">Measured</span>
        <span className="text-xl font-medium">{velocity === undefined ? EMPTY : num(velocity, 0)}</span>
      </p>
      <p className="flex items-baseline justify-between gap-2">
        <span className="text-xs uppercase tracking-wider text-muted-foreground">Setpoint</span>
        <span className="text-xl font-medium">{setpoint === undefined ? EMPTY : num(setpoint, 0)}</span>
      </p>
    </div>
  )
}

/**
 * A double flywheel's setpoints: a speed for each wheel, sent together, so a shot's spin can be tuned. Each wheel's
 * slider sets only that wheel, unless both are set to the same speed.
 */
function DoubleVelocityControl() {
  const { nt, wheels, session, flywheelRange } = useTuner()
  const { min: lo, max: hi } = flywheelRange
  const bounds = useFlywheelBounds()
  const labels = wheelLabels(wheels)
  const active = session === "tune"
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [same, setSame] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sameId = useId()
  // An empty box shows its wheel's setpoint now, so this follows it.
  useNtVersion()

  const clampRpm = (v: number) => Math.max(lo, Math.min(hi, v))
  const setpointOf = (w: string) => shownVelocity(nt.getNumber(yamsTopics(w).tuning.setpointVelocity))

  /** Sends a speed to each wheel given; the others keep theirs. Idle always gets through, whatever the range. */
  const send = (values: Record<string, number>) => {
    setError(null)
    const missing = Object.keys(values).find((w) => !Number.isFinite(values[w]))
    if (missing) return setError(`Enter a number for ${labels[missing]}.`)
    let limited = false
    const next = { ...drafts }
    for (const [w, raw] of Object.entries(values)) {
      const value = raw === 0 ? 0 : clampRpm(raw)
      if (value !== raw) limited = true
      nt.set(yamsTopics(w).tuning.setpointVelocity, wireVelocity(value))
      next[w] = String(Math.round(value))
    }
    setDrafts(next)
    if (limited) setError(`Limited to the slider’s range, ${lo} to ${hi} RPM.`)
  }
  const sendBoth = (rpm: number) => send(Object.fromEntries(wheels.map((w) => [w, rpm])))
  const edit = (w: string, text: string) =>
    setDrafts((d) => (same ? Object.fromEntries(wheels.map((x) => [x, text])) : { ...d, [w]: text }))
  /** What a wheel's box would send: what was typed, or its setpoint now. */
  const draftOf = (w: string) => drafts[w] ?? (setpointOf(w) === undefined ? "" : String(Math.round(setpointOf(w) as number)))

  const top = Math.abs(hi) >= Math.abs(lo) ? hi : lo
  const steps = [0.25, 0.5, 0.75, 1].map((f) => Math.round(clampRpm(top * f)))

  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        {wheels.map((w) => (
          <WheelSpeed key={w} name={w} label={labels[w]} />
        ))}
      </div>
      <SessionButton />
      <fieldset disabled={!active} className="flex flex-col gap-3 disabled:opacity-50">
        <legend className="sr-only">Velocity setpoints</legend>
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            send(Object.fromEntries(wheels.map((w) => [w, draftOf(w) === "" ? Number.NaN : Number(draftOf(w))])))
          }}
        >
          <div className="grid grid-cols-2 gap-2">
            {wheels.map((w) => (
              <div key={w} className="flex min-w-0 flex-col gap-1">
                <label htmlFor={`vel-${w}`} className="truncate text-xs uppercase tracking-wider text-muted-foreground" title={w}>
                  {labels[w]}
                  <span className="sr-only"> (RPM)</span>
                </label>
                <Input
                  id={`vel-${w}`}
                  type="number"
                  step={50}
                  className="font-mono"
                  placeholder="RPM"
                  value={draftOf(w)}
                  onChange={(e) => edit(w, e.target.value)}
                />
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit">
              <Send data-icon="inline-start" />
              Send both
            </Button>
            <label htmlFor={sameId} className="flex items-center gap-2 text-sm">
              <Switch id={sameId} size="sm" checked={same} onCheckedChange={setSame} />
              Same speed for both
            </label>
          </div>
        </form>
        {wheels.map((w) => {
          const value = Number(draftOf(w))
          return (
            <div key={w} className="flex flex-col gap-1">
              <span className="truncate text-xs uppercase tracking-wider text-muted-foreground" title={w}>
                {labels[w]}
              </span>
              <SliderRow
                label={`${labels[w]} velocity setpoint slider (RPM)`}
                min={lo}
                max={hi}
                bounds={bounds}
                digits={0}
                step={10}
                value={clampRpm(Number.isFinite(value) ? value : 0)}
                format={(v) => `${Math.round(v)} RPM`}
                onChange={(v) => edit(w, String(Math.round(v)))}
                onCommit={(v) => (same ? sendBoth(v) : send({ [w]: v }))}
              />
            </div>
          )
        })}
        <p className="text-xs leading-relaxed text-muted-foreground">
          {`Send both sets each wheel to its box. A slider sets only its wheel, or both with Same speed for both on. Setpoints are limited to the sliders’ range, which starts at the ±${DEFAULT_FLYWHEEL_MAX_RPM} RPM safety default. Select either end to change it.`}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" className="short:h-10 short:px-3.5" onClick={() => sendBoth(0)}>
            Idle both (0)
          </Button>
          {steps.map((s) => (
            <Button key={s} size="sm" variant="outline" className="short:h-10 short:px-3.5" onClick={() => sendBoth(s)}>
              {`Both ${s} RPM`}
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
        write={(v) => {
          for (const w of wheels) nt.set(yamsTopics(w).tuning.setpointVelocity, wireVelocity(v))
        }}
      />
      <LiveRegion>
        {error && (
          <Notice tone="warn" live={false}>
            {error}
          </Notice>
        )}
      </LiveRegion>
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
    if (value !== raw) setError(`Limited to the slider’s range, ${lo} to ${hi} RPM.`)
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
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Measured</p>
          <p className="text-2xl font-medium">{velocity === undefined ? EMPTY : num(velocity, 0)}</p>
        </div>
        <div className="rounded-md border border-border bg-background px-3 py-2">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Setpoint</p>
          <p className="text-2xl font-medium">{shownSetpoint === undefined ? EMPTY : num(shownSetpoint, 0)}</p>
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
          {`Setpoints are limited to the slider’s range, which starts at the ±${DEFAULT_FLYWHEEL_MAX_RPM} RPM safety default. Select either end to change it.`}
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
      <LiveRegion>
        {error && (
          <Notice tone="warn" live={false}>
            {error}
          </Notice>
        )}
      </LiveRegion>
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
          <Switch id={switchId} size="sm" checked={follow} onCheckedChange={setFollow} aria-describedby={`${switchId}-hint`} />
          Follow slider
          <span id={`${switchId}-hint`} className="sr-only">
            Off, the setpoint is sent when you let go of the slider.
          </span>
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
      {/* Always on the page, so a note that appears in it is announced. */}
      <div role="status" className={cn("flex flex-col gap-0.5 text-xs leading-relaxed text-hazard-text", !minNote && !maxNote && "hidden")}>
        {minNote && <p>{minNote}</p>}
        {maxNote && <p>{maxNote}</p>}
      </div>
      {(bounds ? bounds.changed : customMin !== null || customMax !== null) && (
        <button
          type="button"
          className="self-start font-sans text-xs text-muted-foreground underline underline-offset-2 transition-colors duration-150 hover:text-foreground"
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
  const buttonRef = useRef<HTMLButtonElement>(null)
  const noteId = useId()

  const commit = () => {
    setEditing(false)
    // The input goes away, so focus goes back to the value it edited rather than to the page.
    requestAnimationFrame(() => buttonRef.current?.focus())
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
          aria-describedby={noteId}
          className="w-24 rounded-sm border border-focus-ring bg-background px-1.5 py-0.5 font-mono text-base text-foreground outline-none sm:text-xs"
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
          ref={buttonRef}
          title="Select to edit"
          aria-label={`${label}: ${format(value)}. Select to edit.`}
          aria-describedby={note ? noteId : undefined}
          className="rounded-sm border border-dashed border-transparent px-1.5 py-0.5 transition-[border-color,color] duration-150 hover:border-border hover:text-foreground focus-visible:border-focus-ring focus-visible:outline-none"
          onClick={() => {
            setDraft(value.toFixed(digits))
            setNote(null)
            setEditing(true)
          }}
        >
          {format(value)}
        </button>
      )}
      <span id={noteId} role="status" className="pointer-events-none absolute top-full mt-1 whitespace-nowrap font-sans text-hazard-text">
        {note}
      </span>
    </div>
  )
}
