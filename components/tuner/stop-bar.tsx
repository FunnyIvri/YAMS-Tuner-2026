"use client"

import { OctagonX, TriangleAlert, X } from "lucide-react"
import { useTuner } from "@/components/tuner/tuner-context"
import { Kbd } from "@/components/tuner/panel"
import { cn } from "@/lib/utils"

export function StopBar() {
  const {
    session,
    starting,
    stop,
    lastStop,
    clearLastStop,
    mechanismName,
    rangeWarning,
    currentWarning,
    currentAsWarning,
    setCurrentAsWarning,
  } = useTuner()
  const active = session !== null || starting

  return (
    <div className="sticky top-0 z-40 border-b border-border">
      {active && <div aria-hidden className="hazard-stripes h-1.5" />}
      <div className={cn("transition-colors", active ? "bg-primary text-primary-foreground" : "bg-card text-card-foreground")}>
        {/* On a touch screen in landscape the controls are on the right, so Stop goes on the left, away from Send. */}
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-2.5 touch-landscape:flex-row-reverse short:px-3 short:py-1">
          <div aria-live="polite" className="min-w-0 text-sm leading-relaxed">
            {active ? (
              <p className="truncate">
                <span className="font-mono font-semibold uppercase tracking-wide">
                  {starting ? "Starting" : session === "verify" ? "Verifying range" : "Live tuning"}
                </span>
                <span className="opacity-80">{` · ${mechanismName ?? ""} · Press `}</span>
                <Kbd>Space</Kbd>
                <span className="opacity-80"> anywhere to stop</span>
              </p>
            ) : lastStop ? (
              <p className={cn("flex items-center gap-2", lastStop.fault && "text-destructive")}>
                <span className="font-mono text-xs font-semibold uppercase">{lastStop.fault ? "Fault stop" : "Stopped"}</span>
                <span className="truncate">{lastStop.reason}</span>
                {lastStop.cause === "overcurrent" && !currentAsWarning && (
                  <button
                    type="button"
                    onClick={() => {
                      setCurrentAsWarning(true)
                      clearLastStop()
                    }}
                    className="shrink-0 rounded-sm border border-current px-2 py-0.5 font-mono text-xs font-semibold uppercase hover:bg-destructive/15"
                  >
                    Warn only from now on
                  </button>
                )}
                <button
                  type="button"
                  onClick={clearLastStop}
                  className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
                  aria-label="Dismiss"
                >
                  <X className="size-4" />
                </button>
              </p>
            ) : (
              <p className="text-muted-foreground">
                {"Idle. "}
                <Kbd>Space</Kbd>
                {" stops Live Tuning at any time, from anywhere on this page."}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => stop("Stopped with the Stop button")}
            disabled={!active}
            className={cn(
              "flex h-11 shrink-0 items-center gap-2 rounded-md px-4 short:h-10 font-mono text-sm font-semibold uppercase tracking-wider transition-colors",
              "bg-destructive text-destructive-foreground hover:bg-destructive/90 focus-visible:ring-3 focus-visible:ring-ring/50 outline-none",
              "disabled:bg-muted disabled:text-muted-foreground",
            )}
          >
            <OctagonX className="size-5" aria-hidden />
            Stop
            <Kbd className="hidden sm:inline-flex">Space</Kbd>
          </button>
        </div>
      </div>
      {active && rangeWarning && (
        <div role="alert" className="bg-hazard text-hazard-foreground">
          <p className="mx-auto flex max-w-7xl items-center gap-2 px-4 py-2 text-sm leading-relaxed">
            <TriangleAlert className="size-4 shrink-0" aria-hidden />
            <span className="font-mono text-xs font-semibold uppercase">Sim warning</span>
            <span>{rangeWarning}</span>
          </p>
        </div>
      )}
      {active && currentWarning && (
        <div role="alert" className="bg-hazard text-hazard-foreground">
          <p className="mx-auto flex max-w-7xl items-center gap-2 px-4 py-2 text-sm leading-relaxed">
            <TriangleAlert className="size-4 shrink-0" aria-hidden />
            <span className="font-mono text-xs font-semibold uppercase">Current warning</span>
            <span>{currentWarning}</span>
            <button
              type="button"
              onClick={() => setCurrentAsWarning(false)}
              className="ml-auto shrink-0 rounded-sm border border-current px-2 py-0.5 font-mono text-xs font-semibold uppercase"
            >
              Make it a fault again
            </button>
          </p>
        </div>
      )}
    </div>
  )
}
