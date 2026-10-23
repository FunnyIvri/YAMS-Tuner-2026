"use client"

import { useEffect, useRef, useState } from "react"
import { Check } from "lucide-react"
import { useTuner } from "@/components/tuner/tuner-context"
import { MechanismPanel } from "@/components/tuner/mechanism-panel"
import { SafetyChecklist } from "@/components/tuner/safety-checklist"
import { VoltageInversionCheck } from "@/components/tuner/voltage-inversion-check"
import { RangeVerification } from "@/components/tuner/range-verification"
import { SetpointPanel } from "@/components/tuner/setpoint-panel"
import { GainsPanel } from "@/components/tuner/gains-panel"
import { LiveTuneProvider } from "@/components/tuner/voltage-drive"
import { TelemetryPanel } from "@/components/tuner/telemetry-panel"
import { cn } from "@/lib/utils"

const STAGES = [
  ["mechanism", "Mechanism"],
  ["checklist", "Checklist"],
  ["inversion", "Inversions"],
  ["range", "Range"],
  ["tune", "Live tune"],
] as const

type Stage = (typeof STAGES)[number][0]
const indexOf = (stage: Stage) => STAGES.findIndex(([s]) => s === stage)

/** The first step that isn't done. A step that is still running stays open until it is finished. */
function useStage(): Stage {
  const { status, mechanismConfirmed, checklistConfirmed, inversionCheck, rangeVerified, session } = useTuner()
  if (status !== "connected" || !mechanismConfirmed) return "mechanism"
  if (!checklistConfirmed) return "checklist"
  if (inversionCheck === "pending" || session === "voltage") return "inversion"
  if (!rangeVerified || session === "verify") return "range"
  return "tune"
}

/**
 * One step at a time on the left, at most two cards, with the telemetry always on the right. Live tuning is the Live
 * tune card and the Settings card. On a phone held upright everything stacks; on a phone turned sideways (short:) the
 * telemetry is pinned on the left instead.
 *
 * Only the telemetry is pinned. The cards scroll with the page, so when a field near the bottom (such as the current
 * limits) opens the on-screen keyboard, the page can scroll it into view.
 */
export function TunerLayout() {
  const { session, starting, mechanismName, kind } = useTuner()
  const stage = useStage()
  // A finished step opened again from the progress bar. Only earlier steps can be opened.
  const [viewing, setViewing] = useState<Stage | null>(null)
  const shown = viewing !== null && indexOf(viewing) < indexOf(stage) ? viewing : stage
  const busy = session !== null || starting
  const top = useRef<HTMLDivElement>(null)

  // A new step starts at the top of the column, not wherever the last one was scrolled to.
  useEffect(() => {
    const el = top.current
    if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: "start", behavior: "smooth" })
  }, [shown])

  const back = () => setViewing(null)
  const cards =
    shown === "mechanism" ? (
      <MechanismPanel onContinue={back} />
    ) : shown === "checklist" ? (
      <SafetyChecklist onContinue={back} />
    ) : shown === "inversion" ? (
      <VoltageInversionCheck />
    ) : shown === "range" ? (
      <RangeVerification />
    ) : (
      <LiveTuneProvider key={`${mechanismName}|${kind}`}>
        <SetpointPanel />
        <GainsPanel />
      </LiveTuneProvider>
    )

  return (
    <main className="mx-auto grid max-w-7xl gap-4 px-4 pt-6 pb-8 lg:grid-cols-2 short:grid-cols-2 short:gap-3 short:px-3 short:pt-3">
      <div ref={top} className="flex scroll-mt-24 flex-col gap-4 short:col-start-2 short:row-start-1">
        <Progress stage={stage} shown={shown} busy={busy} onOpen={(s) => setViewing(s === stage ? null : s)} />
        {cards}
      </div>
      <div
        className={cn(
          "flex flex-col gap-4 lg:sticky lg:top-20 lg:self-start short:sticky short:top-14 short:col-start-1 short:row-start-1 short:h-[calc(100dvh-5.5rem)] short:self-start",
          // On a phone held upright, the graph sits above the controls while tuning, and below the setup steps.
          shown === "tune" && "order-first lg:order-none short:order-none",
        )}
      >
        <TelemetryPanel />
      </div>
    </main>
  )
}

/** Where you are in setup. Finished steps can be opened again while nothing is running. */
function Progress({ stage, shown, busy, onOpen }: { stage: Stage; shown: Stage; busy: boolean; onOpen: (s: Stage) => void }) {
  const { mechanismName } = useTuner()
  const current = indexOf(stage)
  return (
    <nav aria-label="Setup steps">
      <ol className="grid grid-cols-5 gap-1">
        {STAGES.map(([key, label], i) => {
          const done = i < current
          const open = key === shown
          return (
            <li key={key}>
              <button
                type="button"
                disabled={busy || i > current || open}
                aria-current={open ? "step" : undefined}
                title={key === "mechanism" && mechanismName ? mechanismName : undefined}
                onClick={() => onOpen(key)}
                className={cn(
                  "flex min-h-11 w-full flex-col items-start justify-center gap-0.5 rounded-sm border border-border bg-card px-2 py-1.5 text-left font-mono text-[11px] uppercase tracking-wider text-muted-foreground",
                  "enabled:hover:border-foreground disabled:cursor-default",
                  open && "border-primary text-foreground",
                  i > current && "opacity-50",
                )}
              >
                <span className="flex items-center gap-1 font-bold">
                  {done ? <Check className="size-3 text-primary" aria-hidden /> : <span aria-hidden>{i + 1}</span>}
                  <span className="sr-only">{done ? "Done: " : `Step ${i + 1}: `}</span>
                </span>
                <span className="w-full truncate">{label}</span>
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
