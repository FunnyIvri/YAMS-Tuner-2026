"use client"

import { useEffect, useRef, useState, type Ref } from "react"
import { Check } from "lucide-react"
import { useTuner } from "@/components/tuner/tuner-context"
import { MechanismPanel } from "@/components/tuner/mechanism-panel"
import { SafetyChecklist } from "@/components/tuner/safety-checklist"
import { VoltageInversionCheck } from "@/components/tuner/voltage-inversion-check"
import { RangeVerification } from "@/components/tuner/range-verification"
import { SetpointPanel } from "@/components/tuner/setpoint-panel"
import { GainsPanel } from "@/components/tuner/gains-panel"
import { LiveTuneProvider } from "@/components/tuner/voltage-drive"
import { ValueHistoryProvider } from "@/components/tuner/value-history"
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
  const top = useRef<HTMLElement>(null)
  const column = useRef<HTMLDivElement>(null)
  const first = useRef(true)

  // A new step starts at its title, not wherever the last one was scrolled to: focus moves to the title, so keyboard
  // and screen-reader users land on the new step, and the page scrolls back up to the steps.
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    column.current?.querySelector<HTMLElement>("h2[data-step-heading]")?.focus({ preventScroll: true })
    const el = top.current
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" })
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
        <ValueHistoryProvider>
          <SetpointPanel />
          <GainsPanel />
        </ValueHistoryProvider>
      </LiveTuneProvider>
    )
  const tuning = shown === "tune"

  const cardColumn = (
    <div
      key="cards"
      ref={column}
      className="flex flex-col gap-4 lg:col-start-1 lg:row-start-2 short:col-start-2 short:row-start-2"
    >
      {cards}
    </div>
  )
  const telemetry = (
    <div
      key="telemetry"
      className="flex flex-col gap-4 lg:sticky lg:top-20 lg:col-start-2 lg:row-start-2 lg:self-start short:sticky short:top-14 short:col-start-1 short:row-start-2 short:h-[calc(100dvh-5.5rem)] short:self-start short:overflow-y-auto"
    >
      <TelemetryPanel />
    </div>
  )

  return (
    <main className="mx-auto grid w-full max-w-7xl flex-1 content-start gap-4 px-4 pt-6 pb-8 lg:grid-cols-2 short:grid-cols-2 short:gap-3 short:px-3 short:pt-3">
      {/* The steps come first at every width, across both columns. */}
      <Progress
        ref={top}
        stage={stage}
        shown={shown}
        busy={busy}
        onOpen={(s) => setViewing(s === stage ? null : s)}
      />
      {/* On a phone held upright the graph sits above the controls while tuning, and below the setup steps. It is
          placed first in the page, not just drawn first, so the reading order matches what is on screen. */}
      {tuning ? [telemetry, cardColumn] : [cardColumn, telemetry]}
    </main>
  )
}

/** Where you are in setup. Finished steps can be opened again while nothing is running. */
function Progress({
  ref,
  stage,
  shown,
  busy,
  onOpen,
}: {
  ref: Ref<HTMLElement>
  stage: Stage
  shown: Stage
  busy: boolean
  onOpen: (s: Stage) => void
}) {
  const { mechanismName } = useTuner()
  const current = indexOf(stage)
  const open = indexOf(shown)
  return (
    <nav ref={ref} aria-label="Setup steps" className="flex scroll-mt-24 flex-col gap-1.5 lg:col-span-2 short:col-span-2">
      <ol className="grid grid-cols-5 gap-1">
        {STAGES.map(([key, label], i) => {
          const done = i < current
          const isOpen = i === open
          return (
            <li key={key}>
              <button
                type="button"
                disabled={busy || i > current || isOpen}
                aria-current={isOpen ? "step" : undefined}
                aria-label={`${done ? "Done" : `Step ${i + 1}`}: ${label}${isOpen ? ", open" : ""}`}
                title={key === "mechanism" && mechanismName ? `${label}: ${mechanismName}` : label}
                onClick={() => onOpen(key)}
                className={cn(
                  "flex min-h-11 w-full flex-col items-start justify-center gap-0.5 rounded-sm border border-border bg-card px-2 py-1.5 text-start font-mono text-xs uppercase tracking-wider text-muted-foreground",
                  "enabled:hover:border-foreground disabled:cursor-default",
                  // The open step is thicker and filled, a step still to come is dashed, so neither relies on colour.
                  isOpen && "border-2 border-primary-text bg-secondary text-foreground",
                  i > current && "border-dashed",
                )}
              >
                <span aria-hidden className="flex items-center gap-1 font-bold">
                  {done ? <Check className="size-3.5 text-primary-text" strokeWidth={2.5} absoluteStrokeWidth /> : i + 1}
                </span>
                {/* Below sm the boxes are too narrow for words, so the open step is named underneath instead. */}
                <span aria-hidden className="hidden w-full break-words leading-tight hyphens-auto sm:block">
                  {label}
                </span>
              </button>
            </li>
          )
        })}
      </ol>
      <p aria-hidden className="font-mono text-xs uppercase tracking-wider text-muted-foreground sm:hidden">
        {`Step ${open + 1} of ${STAGES.length} · ${STAGES[open][1]}`}
      </p>
    </nav>
  )
}
