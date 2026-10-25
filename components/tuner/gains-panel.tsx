"use client"

import { useRef, useState, type ReactNode } from "react"
import { Input } from "@/components/ui/input"
import { useAxisValues, useNtValue, useNtVersion, useTuner } from "@/components/tuner/tuner-context"
import { CardTabPanel, CardTabs, Panel } from "@/components/tuner/panel"
import { CurrentTripField } from "@/components/tuner/safety-checklist"
import { useValueHistory } from "@/components/tuner/value-history"
import { VoltageSettingsPanel, useLiveTune } from "@/components/tuner/voltage-drive"
import { WheelPicker } from "@/components/tuner/wheel-picker"
import { SignToggle, flipSign } from "@/components/tuner/sign-toggle"
import { Button } from "@/components/ui/button"
import { GAIN_DEFS, axisReader, formatPosition, lqrUnit, positionUnit, profileUnit, wheelLabels, yamsTopics, type GainDef, type GainUnit } from "@/lib/yams/topics"
import { cn } from "@/lib/utils"
import { describeFormat, inputModeFor, nextText, parseFormatted, type NumberFormat } from "@/lib/number-format"

/** Positions: any number, negative too. */
const ANY_NUMBER: NumberFormat = { negative: true }

const GAIN_GROUPS: { key: GainDef["group"]; label: string }[] = [
  { key: "feedback", label: "Feedback" },
  { key: "lqr", label: "LQR" },
  { key: "feedforward", label: "Feedforward" },
  { key: "profile", label: "Motion profile" },
]

type Tab = "gains" | "limits" | "tuner" | "voltage"
/** Tabs whose values live on the robot. The others only change this tuner. */
const ROBOT_TABS: Tab[] = ["gains", "limits"]

export function GainsPanel() {
  // A double flywheel's gains are each wheel's own: these are the chosen wheel's.
  const { nt, wheel: name, wheels, status, kind, axis, positional, requiresRangeVerification } = useTuner()
  useNtVersion()
  const live = useLiveTune()
  // While the Live tune card drives with voltage, a Voltage tab holds the drive's settings, and opens when it appears.
  const voltageTab = live.tab === "voltage"
  const [chosen, setTab] = useState<Tab>("gains")
  const [lastVoltageTab, setLastVoltageTab] = useState(voltageTab)
  if (voltageTab !== lastVoltageTab) {
    setLastVoltageTab(voltageTab)
    if (voltageTab) setTab("voltage")
  }
  const tab: Tab = chosen === "voltage" && !voltageTab ? "gains" : chosen
  const tabs: [Tab, string][] = [
    ["gains", "Gains"],
    ["limits", "Limits"],
    ["tuner", "Tuner"],
    ...(voltageTab ? ([["voltage", "Voltage"]] as [Tab, string][]) : []),
  ]
  const prefix = name ? yamsTopics(name).tuningPrefix : ""
  const available = name ? GAIN_DEFS.filter((g) => nt.isAnnounced(prefix + g.path)) : []
  const reader = name ? axisReader(nt, name, axis) : null
  const softLimits =
    positional && reader && nt.isAnnounced(reader.lowerLimitTopic) && nt.isAnnounced(reader.upperLimitTopic) ? reader : null

  const group = (key: GainDef["group"], label: string) => {
    const defs = available.filter((g) => g.group === key)
    if (defs.length === 0) return null
    const units = defs.map((g) => (g.group === "profile" ? profileUnit(g.key, kind, axis) : g.group === "lqr" ? lqrUnit(g.key, kind, axis) : null))
    const converted = units.find((u) => u && u.label !== u.wireLabel)
    return (
      <GainGroup key={key} label={label}>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {defs.map((g, i) => (
            <GainInput key={`${name}|${g.key}|${kind}|${axis}`} def={g} topic={prefix + g.path} unit={units[i]} />
          ))}
        </div>
        {key === "lqr" && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {"This mechanism runs an LQR in place of kP, kI and kD. Smaller tolerances, or a larger voltage effort, make it correct harder. The std devs say how far to trust the model and the encoder: a smaller encoder std dev follows the measurement more closely. Each change rebuilds the LQR on the robot."}
          </p>
        )}
        {converted && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {"Entered in degrees for this mechanism type, then converted to the RPM-based units YAMS reads."}
          </p>
        )}
      </GainGroup>
    )
  }
  const gains = GAIN_GROUPS.map((g) => group(g.key, g.label)).filter(Boolean)

  return (
    <Panel
      title="Settings"
      description="Gains and Limits are the robot’s own values. Tuner and Voltage only change this tuner. Changes apply when you press Enter or click away; Esc cancels."
      locked={status !== "connected" || !name ? "Choose a mechanism to edit its gains." : null}
    >
      <WheelPicker />
      <CardTabs label="Robot or tuner settings" tabs={tabs} value={tab} onChange={setTab} />
      <CardTabPanel label="Robot or tuner settings" value={tab}>
        <p className="rounded-sm border-s-2 border-primary px-2 py-1 text-xs leading-relaxed text-foreground">
          {ROBOT_TABS.includes(tab)
            ? "On the robot: sent to it under /Tuning."
            : tab === "voltage"
              ? "Only in this tuner: nothing on this tab is sent to the robot, except Set kG to this."
              : "Only in this tuner: nothing on this tab is sent to the robot."}
        </p>
        {tab === "voltage" ? (
          <VoltageSettingsPanel />
        ) : tab === "gains" ? (
          gains.length > 0 ? (
            <>
              {gains}
              {name && wheels.length > 1 && <CopyGains from={name} />}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">This mechanism publishes no tunable gains.</p>
          )
        ) : tab === "tuner" ? (
          <>
            {/* The field's own label names it, so no group heading above it. */}
            <div className="sm:w-1/2">
              <CurrentTripField />
            </div>
            {positional && requiresRangeVerification && <RangeOfMotion />}
          </>
        ) : (
          <>
            {group("current", "Current limits")}
            {softLimits && <SoftLimits lowerTopic={softLimits.lowerLimitTopic} upperTopic={softLimits.upperLimitTopic} />}
            {group("ramp", "Ramp rate")}
          </>
        )}
      </CardTabPanel>
    </Panel>
  )
}

/** Copies a double flywheel wheel's gains (feedback, feedforward and profile) to its other wheel, for wheels that are alike. */
function CopyGains({ from }: { from: string }) {
  const { nt, wheels } = useTuner()
  const [note, setNote] = useState<string | null>(null)
  const labels = wheelLabels(wheels)
  const others = wheels.filter((w) => w !== from)
  const copy = () => {
    const src = yamsTopics(from).tuningPrefix
    const copied = new Set<string>()
    for (const w of others) {
      const dst = yamsTopics(w).tuningPrefix
      for (const g of GAIN_DEFS) {
        if (!GAIN_GROUPS.some((group) => group.key === g.group)) continue
        const v = nt.getNumber(src + g.path)
        if (v === undefined || !nt.isAnnounced(dst + g.path)) continue
        nt.set(dst + g.path, v)
        copied.add(g.label)
      }
    }
    const to = others.map((w) => labels[w]).join(" and ")
    setNote(copied.size > 0 ? `Copied ${[...copied].join(", ")} to ${to}.` : `${to} has none of these gains to set.`)
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Button variant="outline" className="self-start" onClick={copy}>
        {`Copy these gains to ${others.map((w) => labels[w]).join(" and ")}`}
      </Button>
      <p role="status" className="text-xs leading-relaxed text-muted-foreground">
        {note ?? "For wheels that are alike. The current limits and ramp rate are not copied."}
      </p>
    </div>
  )
}

/** Steps back to the value before the last change. Each press goes one change further back. */
function WasButton({ label, text, depth, onClick }: { label: string; text: string; depth: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Restore ${label} to ${text}${depth > 1 ? `. ${depth - 1} earlier ${depth === 2 ? "value" : "values"} before that` : ""}`}
      className="self-start rounded-sm font-mono text-xs leading-tight text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
    >
      {`was ${text}`}
      {depth > 1 && <span className="opacity-60">{` (${depth})`}</span>}
    </button>
  )
}

function GainGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</h3>
      {children}
    </div>
  )
}

/**
 * The allowed range of motion: found in the range step, and changeable here. Live Tuning stops if the mechanism leaves
 * it, and setpoints are limited to it.
 */
function RangeOfMotion() {
  const { verified, overrideVerifiedBound, foundRange: start, axis, session } = useTuner()
  const { position } = useAxisValues()
  const unit = positionUnit(axis)
  const check = (side: "lower" | "upper", v: number): string | null => {
    const other = side === "lower" ? verified.upper : verified.lower
    if (other !== null && (side === "lower" ? v >= other : v <= other)) {
      return side === "lower"
        ? `The lower end must be below the upper end (${formatPosition(other, axis)}).`
        : `The upper end must be above the lower end (${formatPosition(other, axis)}).`
    }
    // Live Tuning stops the moment the mechanism is outside the range, so it can't be moved past where it is now.
    if (session !== null && position !== undefined && (side === "lower" ? position < v : position > v)) {
      return `The mechanism is at ${formatPosition(position, axis)}, outside that range. Move it first.`
    }
    return null
  }
  return (
    <GainGroup label="Range of motion">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {(["lower", "upper"] as const).map((side) => (
          <RangeInput
            key={`${side}|${axis}`}
            id={`range-${side}`}
            label={side === "lower" ? "Lower" : "Upper"}
            unit={unit}
            digits={axis === "linear" ? 3 : 1}
            historyKey={`range-${side}`}
            value={verified[side]}
            check={(v) => check(side, v)}
            warning={
              start[side] !== null && verified[side] !== null && (side === "lower" ? verified[side] < start[side] : verified[side] > start[side])
                ? `Warning: ${side === "lower" ? "below" : "above"} the verified ${side} end (${formatPosition(start[side] as number, axis)}).`
                : null
            }
            onCommit={(v) => overrideVerifiedBound(side, v)}
          />
        ))}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Live Tuning stops if the mechanism leaves this range, and setpoints are limited to it. It can go past what you
        verified, but that can drive the mechanism into a hard stop.
      </p>
    </GainGroup>
  )
}

function RangeInput({
  id,
  label,
  unit,
  digits,
  historyKey,
  value,
  check,
  warning,
  onCommit,
}: {
  id: string
  label: string
  unit: string
  digits: number
  historyKey: string
  value: number | null
  check: (v: number) => string | null
  /** Shown under the field while the value is past what was verified. */
  warning: string | null
  onCommit: (v: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const history = useValueHistory(historyKey, value, (v) => {
    const problem = check(v)
    if (problem) {
      setError(problem)
      return false
    }
    onCommit(v)
  })
  const shown = draft ?? (value === null ? "" : value.toFixed(digits))
  const input = useRef<HTMLInputElement>(null)
  const apply = (text = draft): boolean => {
    if (text === null) return true
    const v = parseFormatted(text, ANY_NUMBER)
    if (v === null) {
      setError("Enter a number.")
      return false
    }
    const problem = check(v)
    if (problem) {
      setError(problem)
      return false
    }
    if (v !== value) onCommit(v)
    setDraft(null)
    setError(null)
    return true
  }
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="flex justify-between gap-2 font-mono text-xs">
        <span>{label}</span>
        <span className="text-muted-foreground">{unit}</span>
      </label>
      <div className="flex gap-1">
      <SignToggle
        label={`the ${label.toLowerCase()}`}
        input={input}
        onFlip={(editing) => {
          const next = flipSign(shown)
          if (editing) {
            setDraft(next)
            setError(null)
          } else if (!apply(next)) setDraft(null)
        }}
      />
      <Input
        ref={input}
        id={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        aria-invalid={error !== null}
        aria-describedby={error ? `${id}-error` : undefined}
        placeholder="Not set"
        className={cn("h-8 font-mono", draft !== null && "border-hazard")}
        value={shown}
        onChange={(e) => {
          setDraft(nextText(shown, e.target.value, ANY_NUMBER))
          setError(null)
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            apply()
          } else if (e.key === "Escape") {
            e.preventDefault()
            setDraft(null)
            setError(null)
          }
        }}
        onBlur={() => {
          if (!apply()) setDraft(null)
        }}
      />
      </div>
      {error && (
        <p id={`${id}-error`} className="text-xs leading-snug text-destructive-text">
          {error}
        </p>
      )}
      {warning && !error && <p className="text-xs leading-snug text-hazard-text">{warning}</p>}
      {history.last !== null && (
        <WasButton
          label={`the ${label.toLowerCase()} end`}
          text={history.last.toFixed(digits)}
          depth={history.depth}
          onClick={() => {
            setDraft(null)
            history.undo()
          }}
        />
      )}
    </div>
  )
}

/**
 * The robot's soft limits, in degrees or meters like the setpoints. They don't change the verified range: Live Tuning
 * still stops if the mechanism leaves it.
 */
function SoftLimits({ lowerTopic, upperTopic }: { lowerTopic: string; upperTopic: string }) {
  const { nt, axis, verified } = useTuner()
  const unit = positionUnit(axis)
  const limit = (key: string, label: string): GainDef => ({ key, label, path: "", nonNegative: false, group: "current", hint: unit })
  const verifiedRange = verified.lower !== null && verified.upper !== null
  return (
    <GainGroup label="Soft limits">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <GainInput
          key={`softLower|${axis}`}
          def={limit("softLower", "Lower")}
          topic={lowerTopic}
          unit={null}
          valid={(v) => {
            const upper = nt.getNumber(upperTopic)
            return upper === undefined || v < upper
          }}
        />
        <GainInput
          key={`softUpper|${axis}`}
          def={limit("softUpper", "Upper")}
          topic={upperTopic}
          unit={null}
          valid={(v) => {
            const lower = nt.getNumber(lowerTopic)
            return lower === undefined || v > lower
          }}
        />
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {verifiedRange
          ? "The robot won’t drive past these. Live Tuning still stops if the mechanism leaves the range of motion on the Tuner tab."
          : "The robot won’t drive past these. The lower limit must be below the upper one."}
      </p>
    </GainGroup>
  )
}

function GainInput({
  def,
  topic,
  unit,
  valid,
}: {
  def: GainDef
  topic: string
  unit: GainUnit | null
  /** Extra check on the entered value, in display units. */
  valid?: (v: number) => boolean
}) {
  const { nt } = useTuner()
  const value = useNtValue<number>(topic)
  const [draft, setDraft] = useState<string | null>(null)
  const [invalid, setInvalid] = useState(false)
  const history = useValueHistory(topic, value, (v) => nt.set(topic, v))
  const id = `gain-${def.key}`
  // Only numbers can be typed: a key that doesn't fit the format does nothing. Soft limits take any number.
  const format: NumberFormat = def.format ?? { negative: !def.nonNegative }
  const toDisplay = (w: number) => (unit ? unit.fromWire(w) : w)
  const fmt = (n: number) => String(Number(n.toPrecision(6)))
  const displayValue = typeof value === "number" ? toDisplay(value) : null
  const shown = draft ?? (displayValue !== null ? fmt(displayValue) : "")
  const hint = unit?.label ?? def.hint
  const converted = unit && unit.label !== unit.wireLabel
  const input = useRef<HTMLInputElement>(null)
  const apply = (text = draft): boolean => {
    if (text === null) return true
    const v = parseFormatted(text, format)
    if (v === null || (def.nonNegative && v < 0) || (def.positive && v <= 0) || (valid && !valid(v))) {
      setInvalid(true)
      return false
    }
    if (displayValue === null || v !== Number(fmt(displayValue))) {
      nt.set(topic, unit ? unit.toWire(v) : v)
    }
    setInvalid(false)
    setDraft(null)
    return true
  }

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="flex justify-between gap-2 font-mono text-xs">
        <span>{def.label}</span>
        {hint && <span className="text-muted-foreground">{hint}</span>}
      </label>
      <div className="flex gap-1">
      {format.negative && (
        <SignToggle
          label={def.key.startsWith("soft") ? `the ${def.label.toLowerCase()} soft limit` : def.label}
          input={input}
          onFlip={(editing) => {
            const next = flipSign(shown)
            if (editing) {
              setDraft(next)
              setInvalid(false)
            } else if (!apply(next)) setInvalid(false)
          }}
        />
      )}
      <Input
        ref={input}
        id={id}
        type="text"
        inputMode={inputModeFor(format)}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={invalid}
        aria-describedby={cn(`${id}-format`, converted && `${id}-wire`)}
        className={cn("h-8 font-mono", draft !== null && "border-hazard")}
        value={shown}
        onChange={(e) => {
          setDraft(nextText(shown, e.target.value, format))
          setInvalid(false)
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            apply()
          } else if (e.key === "Escape") {
            e.preventDefault()
            setDraft(null)
            setInvalid(false)
          }
        }}
        onBlur={() => {
          if (!apply()) {
            setDraft(null)
            setInvalid(false)
          }
        }}
      />
      </div>
      {/* Read with the field; shown only when an entry is refused. */}
      <p id={`${id}-format`} className={cn("text-xs leading-snug text-destructive-text", !invalid && "sr-only")}>
        {describeFormat(format)}
      </p>
      {history.last !== null && (
        <WasButton
          label={def.label}
          text={fmt(toDisplay(history.last))}
          depth={history.depth}
          onClick={() => {
            setDraft(null)
            setInvalid(false)
            history.undo()
          }}
        />
      )}
      {converted && typeof value === "number" && (
        <WireValueEditor
          id={`${id}-wire`}
          label={def.label}
          value={value}
          wireLabel={unit.wireLabel}
          format={format}
          onCommit={(v) => {
            nt.set(topic, v)
            setDraft(null)
            setInvalid(false)
          }}
        />
      )}
    </div>
  )
}

function WireValueEditor({
  id,
  label,
  value,
  wireLabel,
  format,
  onCommit,
}: {
  id: string
  label: string
  value: number
  wireLabel: string
  format: NumberFormat
  onCommit: (v: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [invalid, setInvalid] = useState(false)
  const pretty = String(Number(value.toPrecision(4)))

  const commit = () => {
    if (draft === null) return
    const v = parseFormatted(draft, format)
    if (v === null) {
      setInvalid(true)
      return
    }
    if (v !== value) onCommit(v)
    setDraft(null)
    setInvalid(false)
  }

  if (draft === null) {
    return (
      <button
        type="button"
        id={id}
        onClick={() => setDraft(String(Number(value.toPrecision(format.significant ?? 6))))}
        title={`Edit ${label} directly in ${wireLabel}`}
        className="self-start rounded-sm font-mono text-xs text-muted-foreground underline decoration-dotted underline-offset-2 transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        {`= ${pretty} ${wireLabel}`}
      </button>
    )
  }

  return (
    <div id={id} className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
      <span aria-hidden>=</span>
      <Input
        autoFocus
        type="text"
        inputMode={inputModeFor(format)}
        autoComplete="off"
        spellCheck={false}
        aria-label={`${label} in ${wireLabel}. ${describeFormat(format)}`}
        aria-invalid={invalid}
        className="h-8 w-24 px-1.5 font-mono text-base border-hazard sm:h-6 sm:text-xs"
        value={draft}
        onChange={(e) => {
          setDraft(nextText(draft, e.target.value, format))
          setInvalid(false)
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            commit()
          } else if (e.key === "Escape") {
            e.preventDefault()
            setDraft(null)
            setInvalid(false)
          }
        }}
        onBlur={() => {
          if (draft !== null && invalid) {
            setDraft(null)
            setInvalid(false)
            return
          }
          commit()
        }}
      />
      <span>{wireLabel}</span>
    </div>
  )
}
