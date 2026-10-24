"use client"

import { useEffect, useId, useRef, useState } from "react"
import { CircleCheck, CircleDashed, Play, SkipForward, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { useAxisValues, useNtValue, useRobotState, useTuner } from "@/components/tuner/tuner-context"
import { LiveRegion, Notice, Panel } from "@/components/tuner/panel"
import { EditableBound } from "@/components/tuner/setpoint-panel"
import { WheelPicker } from "@/components/tuner/wheel-picker"
import { axisReader, formatPosition, wheelLabels, yamsTopics } from "@/lib/yams/topics"
import { formatVolts } from "@/lib/format"
import { cn } from "@/lib/utils"
import { jogParams } from "@/lib/yams/safety"

const DEFAULT_MIN_VOLTS = -1
const DEFAULT_MAX_VOLTS = 1
/** Battery voltage: nothing above this can be applied anyway. */
const HARD_LIMIT_VOLTS = 12
/** Below this, friction alone can keep the mechanism still, so no direction is judged. */
const MIN_TEST_VOLTS = 0.25
/** How much a flywheel's speed has to change, in RPM, before its direction counts. */
const FLYWHEEL_DIRECTION_RPM = 30
const SEND_INTERVAL_MS = 100

type Trial = "with" | "against" | null

export function VoltageInversionCheck() {
  const { mechanismName, commandName, checklistConfirmed, inversionCheck, setInversionCheck, session, kind, wheels, wheel, setWheel } = useTuner()
  // A double flywheel checks one wheel at a time; the step passes once every wheel has.
  const [passed, setPassed] = useState<string[]>([])
  const wheelKey = wheels.join("|")
  const [lastWheelKey, setLastWheelKey] = useState(wheelKey)
  if (wheelKey !== lastWheelKey) {
    setLastWheelKey(wheelKey)
    setPassed([])
  }
  const double = wheels.length > 1
  const labels = wheelLabels(wheels)
  const wheelPassed = () => {
    if (!wheel) return
    const next = passed.includes(wheel) ? passed : [...passed, wheel]
    setPassed(next)
    const left = wheels.filter((w) => !next.includes(w))
    if (left.length === 0) {
      setInversionCheck("passed")
      if (mechanismName) setWheel(mechanismName)
    } else setWheel(left[0])
  }
  const locked =
    !mechanismName || !commandName
      ? "Choose a mechanism first."
      : !checklistConfirmed
        ? "Complete the pre-motion checklist first."
        : null

  if (!locked && inversionCheck !== "pending") {
    return (
      <Panel
        step={3}
        title="Check inversions"
        description={
          inversionCheck === "passed"
            ? double
              ? "Each wheel’s speed followed the sign of the voltage."
              : "Position followed the sign of the voltage."
            : "Skipped. Only skip this when the motor, encoder and follower inversions were already checked on this robot."
        }
      >
        <Button
          variant="outline"
          className="self-start"
          disabled={session !== null}
          onClick={() => {
            setPassed([])
            if (mechanismName) setWheel(mechanismName)
            setInversionCheck("pending")
          }}
        >
          Run the check again
        </Button>
      </Panel>
    )
  }

  return (
    <Panel
      step={3}
      title="Check inversions"
      description={
        double
          ? "Confirm each wheel speeds up forward with positive voltage, one wheel at a time. Drive it with a small voltage while enabled. Only needed once during setup."
          : kind === "flywheel"
          ? "Confirm the flywheel speeds up forward with positive voltage. Drive it with a small voltage while enabled. Only needed once during setup."
          : "Confirm position goes up when the mechanism moves in its positive direction. Drive it with a small voltage while enabled. Only needed once during setup."
      }
      locked={locked}
    >
      {double && (
        <div className="flex flex-col gap-2">
          <WheelPicker disabled={session !== null} />
          <ul className="flex flex-col gap-1 text-sm">
            {wheels.map((w) => (
              <li key={w} className="flex items-center gap-2">
                {passed.includes(w) ? <CircleCheck className="size-4 shrink-0" aria-hidden /> : <CircleDashed className="size-4 shrink-0" aria-hidden />}
                {`${labels[w]}: ${passed.includes(w) ? "passed" : "not checked yet"}`}
              </li>
            ))}
          </ul>
        </div>
      )}
      <CheckBody key={wheel ?? ""} onPassed={wheelPassed} />
    </Panel>
  )
}

function CheckBody({ onPassed }: { onPassed: () => void }) {
  const { nt, wheel: name, wheels, axis, kind, session, starting, startLiveTuning, stop, setInversionCheck } = useTuner()
  const { position, velocity } = useAxisValues()
  const flywheel = kind === "flywheel"
  const topics = name ? yamsTopics(name) : null
  // Subscribing re-renders when the topic is announced by a YAMS version that supports it.
  useNtValue<boolean>(topics?.tuning.voltageEnabled ?? null)
  const supported = !!topics && nt.isAnnounced(topics.tuning.voltageEnabled) && nt.isAnnounced(topics.tuning.voltageSetpoint)

  const active = session === "voltage"
  const [acknowledged, setAcknowledged] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [volts, setVolts] = useState(0)
  const [springBack, setSpringBack] = useState(true)
  const [minVolts, setMinVolts] = useState(DEFAULT_MIN_VOLTS)
  const [maxVolts, setMaxVolts] = useState(DEFAULT_MAX_VOLTS)
  const [trials, setTrials] = useState<{ positive: Trial; negative: Trial }>({ positive: null, negative: null })
  const [warning, setWarning] = useState<string | null>(null)
  const commanded = useRef(0)
  const lastSent = useRef(0)
  const springId = useId()

  const send = (v: number) => {
    if (!topics) return
    commanded.current = v
    nt.set(topics.tuning.voltageSetpoint, v)
  }

  const zero = () => {
    setVolts(0)
    send(0)
  }

  useEffect(() => {
    if (!active) {
      commanded.current = 0
      setVolts(0)
    }
  }, [active])

  // Compares the direction the mechanism moves with the sign of the commanded voltage. A flywheel is judged by
  // the change in its speed rather than its position: after positive voltage it keeps coasting forward, so its
  // position still rises under negative voltage, while its speed falls as it should.
  useEffect(() => {
    if (!active || !name) return
    const reader = axisReader(nt, name, axis)
    const measure = () => (flywheel ? reader.velocity() : reader.position())
    const threshold = flywheel ? FLYWHEEL_DIRECTION_RPM : jogParams(axis).directionThreshold
    let trialSign = 0
    let trialStart: number | undefined
    let judged = false
    const id = setInterval(() => {
      const v = commanded.current
      const sign = Math.abs(v) >= MIN_TEST_VOLTS ? Math.sign(v) : 0
      const pos = measure()
      if (sign !== trialSign) {
        trialSign = sign
        trialStart = pos
        judged = false
        return
      }
      if (sign === 0 || judged || pos === undefined || trialStart === undefined) return
      const moved = pos - trialStart
      if (Math.abs(moved) < threshold) return
      judged = true
      const result: Trial = Math.sign(moved) === sign ? "with" : "against"
      setTrials((t) => ({ ...t, [sign > 0 ? "positive" : "negative"]: result }))
      if (result === "against") {
        // Back off immediately: a reversed motor or follower keeps fighting the mechanism.
        commanded.current = 0
        nt.set(yamsTopics(name).tuning.voltageSetpoint, 0)
        setVolts(0)
        setWarning(
          flywheel
            ? `Speed went ${sign > 0 ? "down with positive" : "up with negative"} voltage, so the voltage was set back to 0 V. The motor or encoder inversion is probably wrong.`
            : `Position went ${sign > 0 ? "down with positive" : "up with negative"} voltage, so the voltage was set back to 0 V. The motor or encoder inversion is probably wrong. If gravity is pulling the mechanism, it can also be stronger than this voltage; try a little more voltage before changing inversions.`,
        )
      } else setWarning(null)
    }, 20)
    return () => clearInterval(id)
  }, [active, name, axis, nt, flywheel])

  const begin = async () => {
    setError(null)
    setWarning(null)
    setTrials({ positive: null, negative: null })
    const err = await startLiveTuning("voltage")
    if (err || !topics) {
      setError(err)
      return
    }
    commanded.current = 0
    nt.set(topics.tuning.voltageSetpoint, 0)
    nt.set(topics.tuning.voltageEnabled, true)
  }

  // One direction is enough: if position follows the voltage one way, the inversions are right. Neither may go against it.
  const passed =
    (trials.positive === "with" || trials.negative === "with") && trials.positive !== "against" && trials.negative !== "against"
  const format = formatVolts
  const [lowLabel, highLabel] = kind === "elevator" ? ["down", "up"] : ["reverse", "forward"]

  if (!supported) {
    return (
      <>
        <Notice tone="warn">
          This robot does not publish voltage/enabled and voltage/setpoint. Update YAMS to a version with voltage live tuning, or skip this step.
        </Notice>
        <Button variant="ghost" className="self-start" onClick={() => setInversionCheck("skipped")}>
          <SkipForward data-icon="inline-start" />
          Skip inversion check
        </Button>
      </>
    )
  }

  return (
    <>
      <div className="flex gap-3 rounded-md border border-destructive bg-destructive/10 p-3 text-sm leading-relaxed text-foreground">
        <TriangleAlert className="mt-0.5 size-5 shrink-0 text-destructive-text" aria-hidden />
        <div className="flex flex-col gap-1.5">
          <p className="font-semibold text-destructive-text">Be very careful during this step.</p>
          <p>
            Voltage runs the motor open loop, with no position control. If two motors drive the same mechanism and a follower’s inversion is wrong, the
            motors fight each other and can bend or break the mechanism almost instantly.
          </p>
          <ul className="flex list-disc flex-col gap-1 ps-5">
            <li>Start with a fraction of a volt and increase it slowly.</li>
            <li>Watch and listen. Grinding, a stalled mechanism or rising current means stop right away.</li>
            <li>Press Space, or disable from the Driver Station, at the first sign of trouble.</li>
          </ul>
        </div>
      </div>

      {!active ? (
        <div className="flex flex-col gap-3">
          <label className="flex items-start gap-3 text-sm leading-relaxed">
            <Checkbox checked={acknowledged} onCheckedChange={(v) => setAcknowledged(v === true)} className="mt-0.5" />
            I am watching the mechanism, my hand is on the disable, and I will start with a very small voltage.
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={begin} disabled={!acknowledged || starting || session !== null}>
              <Play data-icon="inline-start" />
              Start voltage control
            </Button>
            <Button variant="ghost" className="ms-auto" disabled={session !== null} onClick={() => setInversionCheck("skipped")}>
              <SkipForward data-icon="inline-start" />
              Skip (already checked)
            </Button>
          </div>
          {session !== null && <p className="text-sm text-muted-foreground">Stop the current Live Tuning session first.</p>}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">Applied voltage</span>
            <span className="font-mono text-2xl tabular">{format(volts)}</span>
          </div>
          <Slider
            aria-label="Tuning voltage"
            min={minVolts}
            max={maxVolts}
            step={0.05}
            value={Math.min(maxVolts, Math.max(minVolts, volts))}
            onValueChange={(raw) => {
              const v = Array.isArray(raw) ? raw[0] : (raw as number)
              setVolts(v)
              if (Date.now() - lastSent.current >= SEND_INTERVAL_MS) {
                lastSent.current = Date.now()
                send(v)
              }
            }}
            onValueCommitted={(raw) => {
              const v = Array.isArray(raw) ? raw[0] : (raw as number)
              if (springBack) zero()
              else {
                setVolts(v)
                send(v)
              }
            }}
          />
          <div className="flex items-center justify-between gap-2 font-mono text-xs text-muted-foreground tabular">
            <EditableBound
              label="Minimum voltage"
              value={minVolts}
              digits={2}
              step={0.1}
              format={format}
              onSubmit={(v) => {
                const next = Math.max(-HARD_LIMIT_VOLTS, Math.min(0, v))
                if (next >= maxVolts) return `Minimum must be below ${format(maxVolts)}.`
                setMinVolts(next)
                return next !== v ? `Limited to ${format(next)}.` : null
              }}
            />
            <label htmlFor={springId} className="flex items-center gap-2 font-sans">
              <Switch id={springId} size="sm" checked={springBack} onCheckedChange={setSpringBack} />
              {/* One fixed label: the switch says whether it's on. */}
              Back to 0{"\u00a0"}V on release
            </label>
            <EditableBound
              label="Maximum voltage"
              value={maxVolts}
              digits={2}
              step={0.1}
              format={format}
              align="end"
              onSubmit={(v) => {
                const next = Math.min(HARD_LIMIT_VOLTS, Math.max(0, v))
                if (next <= minVolts) return `Maximum must be above ${format(minVolts)}.`
                setMaxVolts(next)
                return next !== v ? `Limited to ${format(next)}.` : null
              }}
            />
          </div>

          <VoltageEntry
            min={minVolts}
            max={maxVolts}
            format={format}
            onApply={(v) => {
              setVolts(v)
              send(v)
            }}
          />

          <div className="grid grid-cols-2 gap-2">
            <TrialStatus label={`Positive voltage moves ${highLabel}`} result={trials.positive} />
            <TrialStatus label={`Negative voltage moves ${lowLabel}`} result={trials.negative} />
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {flywheel
              ? `Speed ${velocity === undefined ? "—" : `${velocity.toFixed(0)} RPM`}. Apply at least ${MIN_TEST_VOLTS} V either way until the speed changes. One direction is enough: positive voltage should speed it up forward, and negative voltage slow it down or spin it in reverse.`
              : `Position ${formatPosition(position, axis)}. Apply at least ${MIN_TEST_VOLTS} V either way until the mechanism moves. One direction is enough.`}
          </p>

          <div className="flex flex-wrap gap-2">
            <Button
              className="ms-auto"
              disabled={!passed}
              onClick={() => {
                stop(wheels.length > 1 ? `Inversion check passed for ${name}` : "Inversion check passed")
                onPassed()
              }}
            >
              Finish check
            </Button>
          </div>
        </div>
      )}

      {/* Always on the page, so a wrong-direction warning that appears in it is announced at once. */}
      <LiveRegion assertive>
        {warning && (
          <Notice tone="warn" live={false}>
            {warning}
          </Notice>
        )}
        {error && (
          <Notice tone="danger" live={false}>
            {error}
          </Notice>
        )}
      </LiveRegion>
    </>
  )
}

function VoltageEntry({
  min,
  max,
  format,
  onApply,
}: {
  min: number
  max: number
  format: (v: number) => string
  onApply: (v: number) => void
}) {
  const inputId = useId()
  const noteId = useId()
  const [text, setText] = useState("")
  const [note, setNote] = useState<string | null>(null)
  const [invalid, setInvalid] = useState(false)

  const apply = () => {
    const v = Number.parseFloat(text)
    if (text.trim() === "" || !Number.isFinite(v)) {
      setInvalid(true)
      setNote("Enter a number of volts.")
      return
    }
    setInvalid(false)
    const next = Math.min(max, Math.max(min, v))
    onApply(next)
    setText(next.toString())
    setNote(
      next !== v
        ? `Limited to ${format(next)}. Change the slider range to go further.`
        : next === 0
          ? `Set to ${format(0)}.`
          : `Holding ${format(next)}. Type 0 or press Space to stop.`,
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-xs uppercase tracking-wider text-muted-foreground">
        Type a voltage
      </label>
      <div className="flex gap-2">
        <Input
          id={inputId}
          type="number"
          inputMode="decimal"
          step={0.05}
          min={min}
          max={max}
          placeholder={`${min} to ${max}`}
          value={text}
          aria-invalid={invalid}
          aria-describedby={noteId}
          className="font-mono tabular"
          onChange={(e) => {
            setText(e.target.value)
            setNote(null)
            setInvalid(false)
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing || e.keyCode === 229) return
            e.preventDefault()
            apply()
          }}
        />
        <Button variant="outline" onClick={apply}>
          Apply
        </Button>
      </div>
      <p id={noteId} role="status" className={cn("text-xs leading-relaxed", invalid ? "text-destructive-text" : "text-muted-foreground")}>
        {note ?? `Press Enter or Apply to send it. Typed values hold until changed and stay within ${format(min)} to ${format(max)}.`}
      </p>
    </div>
  )
}

function TrialStatus({ label, result }: { label: string; result: Trial }) {
  const Icon = result === "with" ? CircleCheck : result === "against" ? TriangleAlert : CircleDashed
  return (
    <div
      className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm data-[result=against]:border-hazard data-[result=against]:bg-hazard/15 data-[result=with]:border-foreground"
      data-result={result ?? "none"}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      <span>{label}</span>
      <span className="sr-only">{result === "with" ? "confirmed" : result === "against" ? "wrong direction" : "not tested yet"}</span>
    </div>
  )
}
