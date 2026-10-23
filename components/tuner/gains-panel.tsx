"use client"

import { useState, type ReactNode } from "react"
import { Input } from "@/components/ui/input"
import { useNtValue, useNtVersion, useTuner } from "@/components/tuner/tuner-context"
import { CardTabs, Panel } from "@/components/tuner/panel"
import { CurrentTripField } from "@/components/tuner/safety-checklist"
import { GAIN_DEFS, axisReader, positionUnit, profileUnit, yamsTopics, type GainDef, type GainUnit } from "@/lib/yams/topics"
import { cn } from "@/lib/utils"

const GAIN_GROUPS: { key: GainDef["group"]; label: string }[] = [
  { key: "feedback", label: "Feedback" },
  { key: "feedforward", label: "Feedforward" },
  { key: "profile", label: "Motion profile" },
]

const TABS = [
  ["gains", "Gains"],
  ["limits", "Limits"],
] as const

export function GainsPanel() {
  const { nt, mechanismName, status, kind, axis, positional } = useTuner()
  useNtVersion()
  const [tab, setTab] = useState<(typeof TABS)[number][0]>("gains")
  const prefix = mechanismName ? yamsTopics(mechanismName).tuningPrefix : ""
  const available = mechanismName ? GAIN_DEFS.filter((g) => nt.isAnnounced(prefix + g.path)) : []
  const reader = mechanismName ? axisReader(nt, mechanismName, axis) : null
  const softLimits =
    positional && reader && nt.isAnnounced(reader.lowerLimitTopic) && nt.isAnnounced(reader.upperLimitTopic) ? reader : null

  const group = (key: GainDef["group"], label: string) => {
    const defs = available.filter((g) => g.group === key)
    if (defs.length === 0) return null
    const units = defs.map((g) => (g.group === "profile" ? profileUnit(g.key, kind, axis) : null))
    const converted = units.find((u) => u && u.label !== u.wireLabel)
    return (
      <GainGroup key={key} label={label}>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {defs.map((g, i) => (
            <GainInput key={`${g.key}|${kind}|${axis}`} def={g} topic={prefix + g.path} unit={units[i]} />
          ))}
        </div>
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
      title="Gains"
      description="Values the robot publishes under /Tuning. Applied when you press Enter or click away; Esc cancels."
      locked={status !== "connected" || !mechanismName ? "Choose a mechanism to edit its gains." : null}
    >
      <CardTabs label="Gains or limits" tabs={TABS} value={tab} onChange={setTab} />
      {tab === "gains" ? (
        gains.length > 0 ? (
          gains
        ) : (
          <p className="text-sm text-muted-foreground">This mechanism publishes no tunable gains.</p>
        )
      ) : (
        <>
          {group("current", "Current limits")}
          <GainGroup label="Stator fault">
            <div className="sm:w-1/2">
              <CurrentTripField />
            </div>
          </GainGroup>
          {softLimits && <SoftLimits lowerTopic={softLimits.lowerLimitTopic} upperTopic={softLimits.upperLimitTopic} />}
          {group("ramp", "Ramp rate")}
        </>
      )}
    </Panel>
  )
}

function GainGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</h3>
      {children}
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
          ? "The robot won't drive past these. Live Tuning still stops if the mechanism leaves the verified range."
          : "The robot won't drive past these. The lower limit must be below the upper one."}
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
  const [startWire, setStartWire] = useState<number | null>(null)
  if (startWire === null && typeof value === "number") setStartWire(value)
  const id = `gain-${def.key}`
  const toDisplay = (w: number) => (unit ? unit.fromWire(w) : w)
  const fmt = (n: number) => String(Number(n.toPrecision(6)))
  const displayValue = typeof value === "number" ? toDisplay(value) : null
  const shown = draft ?? (displayValue !== null ? fmt(displayValue) : "")
  const hint = unit?.label ?? def.hint
  const converted = unit && unit.label !== unit.wireLabel
  const changedFromStart =
    startWire !== null &&
    ((typeof value === "number" && fmt(toDisplay(value)) !== fmt(toDisplay(startWire))) ||
      (draft !== null && draft.trim() !== "" && Number(draft) !== Number(fmt(toDisplay(startWire)))))

  const apply = (): boolean => {
    if (draft === null) return true
    const v = Number(draft)
    if (draft.trim() === "" || !Number.isFinite(v) || (def.nonNegative && v < 0) || (valid && !valid(v))) {
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
      <Input
        id={id}
        type="number"
        step="any"
        aria-invalid={invalid}
        aria-describedby={converted ? `${id}-wire` : undefined}
        className={cn("h-8 font-mono", draft !== null && "border-hazard")}
        value={shown}
        onChange={(e) => {
          setDraft(e.target.value)
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
      {changedFromStart && startWire !== null && (
        <button
          type="button"
          onClick={() => {
            nt.set(topic, startWire)
            setDraft(null)
            setInvalid(false)
          }}
          title={`Restore ${def.label} to its starting value`}
          className="self-start rounded-sm font-mono text-[11px] leading-tight text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {`was ${fmt(toDisplay(startWire))}`}
        </button>
      )}
      {converted && typeof value === "number" && (
        <WireValueEditor
          id={`${id}-wire`}
          label={def.label}
          value={value}
          wireLabel={unit.wireLabel}
          nonNegative={def.nonNegative}
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
  nonNegative,
  onCommit,
}: {
  id: string
  label: string
  value: number
  wireLabel: string
  nonNegative?: boolean
  onCommit: (v: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [invalid, setInvalid] = useState(false)
  const pretty = String(Number(value.toPrecision(4)))

  const commit = () => {
    if (draft === null) return
    const v = Number(draft)
    if (draft.trim() === "" || !Number.isFinite(v) || (nonNegative && v < 0)) {
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
        onClick={() => setDraft(String(Number(value.toPrecision(6))))}
        title={`Edit ${label} directly in ${wireLabel}`}
        className="self-start rounded-sm font-mono text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
        type="number"
        step="any"
        aria-label={`${label} in ${wireLabel}`}
        aria-invalid={invalid}
        className="h-6 w-24 px-1.5 font-mono text-xs border-hazard"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
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
