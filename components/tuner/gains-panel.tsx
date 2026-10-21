"use client"

import { useState } from "react"
import { Input } from "@/components/ui/input"
import { useNtValue, useNtVersion, useTuner } from "@/components/tuner/tuner-context"
import { Panel } from "@/components/tuner/panel"
import { GAIN_DEFS, profileUnit, yamsTopics, type GainDef, type GainUnit } from "@/lib/yams/topics"
import { cn } from "@/lib/utils"

const GROUPS: { key: GainDef["group"]; label: string }[] = [
  { key: "feedback", label: "Feedback" },
  { key: "feedforward", label: "Feedforward" },
  { key: "profile", label: "Motion profile" },
  { key: "limits", label: "Limits" },
]

export function GainsPanel() {
  const { nt, mechanismName, status, kind, axis } = useTuner()
  useNtVersion()
  const prefix = mechanismName ? yamsTopics(mechanismName).tuningPrefix : ""
  const available = mechanismName ? GAIN_DEFS.filter((g) => nt.isAnnounced(prefix + g.path)) : []

  return (
    <Panel
      title="Gains"
      description="Values the robot publishes under /Tuning. Applied when you press Enter or click away; Esc cancels."
      locked={status !== "connected" || !mechanismName ? "Choose a mechanism to edit its gains." : available.length === 0 ? "This mechanism publishes no tunable gains." : null}
    >
      {GROUPS.map((group) => {
        const defs = available.filter((g) => g.group === group.key)
        if (defs.length === 0) return null
        const units = defs.map((g) => (g.group === "profile" ? profileUnit(g.key, kind, axis) : null))
        const converted = units.find((u) => u && u.label !== u.wireLabel)
        return (
          <div key={group.key} className="flex flex-col gap-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{group.label}</h3>
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
          </div>
        )
      })}
    </Panel>
  )
}

function GainInput({ def, topic, unit }: { def: GainDef; topic: string; unit: GainUnit | null }) {
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
    if (draft.trim() === "" || !Number.isFinite(v) || (def.nonNegative && v < 0)) {
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
