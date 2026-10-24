"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useTuner } from "@/components/tuner/tuner-context"
import { Field, Panel } from "@/components/tuner/panel"
import { PRE_MOTION_CHECKLIST, needsRangeVerification } from "@/lib/yams/safety"
import { inputModeFor, nextText, parseFormatted, type NumberFormat } from "@/lib/number-format"

export function SafetyChecklist({ onContinue }: { onContinue: () => void }) {
  const { mechanismName, commandName, kind, continuous } = useTuner()
  const ready = !!mechanismName && !!commandName
  // Remount when the mechanism changes so every box starts unchecked again.
  return (
    <Panel
      step={2}
      title="Pre-motion checklist"
      description="Nothing moves until every item is confirmed. The current trip can be changed later under the Settings card’s Tuner tab."
      locked={ready ? null : "Choose a mechanism and its Live Tuning command first."}
    >
      <ChecklistBody key={`${mechanismName}|${kind}|${continuous}`} onContinue={onContinue} />
    </Panel>
  )
}

function ChecklistBody({ onContinue: done }: { onContinue: () => void }) {
  const { kind, continuous, checklistConfirmed, setChecklistConfirmed, session } = useTuner()
  const category = kind === "flywheel" ? "flywheel" : needsRangeVerification(kind, continuous) ? "positional" : "continuous"
  const items = PRE_MOTION_CHECKLIST[category]
  const [checked, setChecked] = useState<boolean[]>(() => items.map(() => checklistConfirmed))
  const busy = session !== null

  const toggle = (i: number, value: boolean) => {
    const next = checked.map((c, j) => (j === i ? value : c))
    setChecked(next)
    // Confirmed only by Continue. Unchecking a box after that takes it back.
    if (!next.every(Boolean)) setChecklistConfirmed(false)
  }
  const allChecked = checked.every(Boolean)
  const onContinue = () => {
    setChecklistConfirmed(true)
    done()
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
        <CurrentTripField />
      </div>
      <Button className="self-start" disabled={!allChecked || busy} onClick={onContinue}>
        Continue
      </Button>
    </>
  )
}

/** The stator current that stops Live Tuning. Set on the checklist, then under the Settings card's Tuner tab. */
const TRIP_FORMAT: NumberFormat = { integer: true }
const MIN_TRIP = 5
const MAX_TRIP = 120

/** The current trip, in whole amps from 5 to 120. Applied on Enter or when the field is left. */
export function CurrentTripField() {
  const { stallCurrent, setStallCurrent } = useTuner()
  const [draft, setDraft] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const shown = draft ?? String(stallCurrent)
  const apply = () => {
    if (draft === null) return
    const v = parseFormatted(draft, TRIP_FORMAT)
    setDraft(null)
    if (v === null) {
      setNote(`Enter whole amps, ${MIN_TRIP} to ${MAX_TRIP}.`)
      return
    }
    const next = Math.min(MAX_TRIP, Math.max(MIN_TRIP, v))
    setStallCurrent(next)
    setNote(next !== v ? `Limited to ${next}${"\u00a0"}A.` : null)
  }
  return (
    <Field
      label="Current trip (A)"
      htmlFor="stall"
      hint={note ?? `Stator current above this for 250 ms stops Live Tuning. Whole amps, ${MIN_TRIP} to ${MAX_TRIP}.`}
    >
      <Input
        id="stall"
        type="text"
        inputMode={inputModeFor(TRIP_FORMAT)}
        autoComplete="off"
        spellCheck={false}
        className="font-mono"
        value={shown}
        onChange={(e) => {
          setDraft(nextText(shown, e.target.value, TRIP_FORMAT))
          setNote(null)
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            apply()
          } else if (e.key === "Escape") {
            e.preventDefault()
            setDraft(null)
            setNote(null)
          }
        }}
        onBlur={apply}
      />
    </Field>
  )
}
