"use client"

import { useState } from "react"
import { Input } from "@/components/ui/input"
import { useTuner } from "@/components/tuner/tuner-context"
import { Field, Panel } from "@/components/tuner/panel"
import { PRE_MOTION_CHECKLIST, needsRangeVerification } from "@/lib/yams/safety"

export function SafetyChecklist() {
  const { mechanismName, commandName, kind, continuous } = useTuner()
  const ready = !!mechanismName && !!commandName
  // Remount when the mechanism changes so every box starts unchecked again.
  return (
    <Panel
      step={2}
      title="Pre-motion checklist"
      description="Nothing moves until every item is confirmed."
      locked={ready ? null : "Choose a mechanism and its Live Tuning command first."}
    >
      <ChecklistBody key={`${mechanismName}|${kind}|${continuous}`} />
    </Panel>
  )
}

function ChecklistBody() {
  const { kind, continuous, checklistConfirmed, setChecklistConfirmed, stallCurrent, setStallCurrent, flywheelMaxRpm, setFlywheelMaxRpm, session } =
    useTuner()
  const category = kind === "flywheel" ? "flywheel" : needsRangeVerification(kind, continuous) ? "positional" : "continuous"
  const items = PRE_MOTION_CHECKLIST[category]
  const [checked, setChecked] = useState<boolean[]>(() => items.map(() => checklistConfirmed))
  const busy = session !== null

  const toggle = (i: number, value: boolean) => {
    const next = checked.map((c, j) => (j === i ? value : c))
    setChecked(next)
    setChecklistConfirmed(next.every(Boolean))
  }

  return (
    <>
      <ul className="flex flex-col gap-2">
        {items.map((item, i) => (
          <li key={item}>
            <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-background px-3 py-2.5 text-sm leading-relaxed has-checked:border-foreground">
              <input
                type="checkbox"
                className="mt-1 size-4 shrink-0 accent-foreground"
                checked={checked[i] ?? false}
                disabled={busy}
                onChange={(e) => toggle(i, e.target.checked)}
              />
              <span>{item}</span>
            </label>
          </li>
        ))}
      </ul>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Current trip (A)" htmlFor="stall" hint="Stator current above this for 250 ms stops Live Tuning.">
          <Input
            id="stall"
            type="number"
            min={5}
            max={120}
            className="font-mono"
            value={stallCurrent}
            onChange={(e) => {
              const v = Number(e.target.value)
              if (Number.isFinite(v)) setStallCurrent(Math.min(120, Math.max(5, v)))
            }}
          />
        </Field>
        {kind === "flywheel" && (
          <Field label="Max speed (RPM)" htmlFor="maxrpm" hint="Velocity setpoints are clamped to this.">
            <Input
              id="maxrpm"
              type="number"
              min={0}
              className="font-mono"
              value={flywheelMaxRpm}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (Number.isFinite(v) && v >= 0) setFlywheelMaxRpm(v)
              }}
            />
          </Field>
        )}
      </div>
    </>
  )
}
