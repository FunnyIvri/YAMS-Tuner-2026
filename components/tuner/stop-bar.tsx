"use client"

import { useEffect, useRef } from "react"
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
  const bar = useRef<HTMLDivElement>(null)

  // The bar's height, for what has to stay clear of it: the pinned telemetry and controls scrolled into view. While
  // something runs, the bar is fixed to the top of the window and the page is padded down by the same height.
  useEffect(() => {
    const el = bar.current
    if (!el) return
    const root = document.documentElement.style
    const measure = () => {
      const h = `${el.offsetHeight}px`
      root.setProperty("--stop-bar-h", h)
      root.setProperty("--stop-bar-pad", active ? h : "0px")
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => {
      observer.disconnect()
      root.setProperty("--stop-bar-pad", "0px")
    }
  }, [active])

  return (
    <div ref={bar} className={cn("z-40 border-b border-border", active ? "fixed inset-x-0 top-0" : "sticky top-0")}>
      {active && <div aria-hidden className="hazard-stripes h-1.5" />}
      <div className={cn("transition-colors", active ? "bg-primary text-primary-foreground" : "bg-card text-card-foreground")}>
        {/* On a touch screen in landscape the controls are on the right, so Stop goes on the left, away from Send. */}
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2.5 touch-landscape:flex-row-reverse short:px-3 short:py-1">
          <div aria-live="polite" className="min-w-0 flex-1 basis-48 text-sm leading-relaxed">
            {active ? (
              // Wraps instead of cutting off: the mechanism and how to stop must stay readable at any width.
              <p className="flex flex-wrap items-center gap-x-1 text-pretty">
                <span className="font-mono font-semibold uppercase tracking-wider">
                  {starting
                    ? "Starting"
                    : session === "verify"
                      ? "Verifying range"
                      : session === "voltage"
                        ? "Checking inversions"
                        : session === "jog"
                          ? "Driving with voltage"
                          : "Live tuning"}
                </span>
                <span className="min-w-0 break-words opacity-80">{`· ${mechanismName ?? ""} ·`}</span>
                <span className="whitespace-nowrap opacity-80">
                  Press <Kbd>Space</Kbd> anywhere to stop
                </span>
              </p>
            ) : lastStop ? (
              <p className={cn("flex flex-wrap items-center gap-x-2 gap-y-1", lastStop.fault && "text-destructive-text")}>
                <span className="font-mono text-xs font-semibold uppercase tracking-wider">{lastStop.fault ? "Fault stop" : "Stopped"}</span>
                {/* The whole reason, on its own line on a phone: it's the one fact needed after a stop. */}
                <span className="min-w-0 basis-full text-pretty sm:basis-auto">{lastStop.reason}</span>
                {lastStop.cause === "overcurrent" && !currentAsWarning && (
                  <button
                    type="button"
                    onClick={() => {
                      setCurrentAsWarning(true)
                      clearLastStop()
                    }}
                    className="shrink-0 rounded-sm border border-current px-2 py-0.5 font-mono text-xs font-semibold uppercase tracking-wider hover:bg-destructive/15 transition-[scale,background-color,color] duration-150 ease-out motion-safe:enabled:active:scale-[0.96]"
                  >
                    Warn only from now on
                  </button>
                )}
                <button
                  type="button"
                  onClick={clearLastStop}
                  className="rounded-sm p-1 text-muted-foreground hover:text-foreground transition-[scale,background-color,color] duration-150 ease-out motion-safe:enabled:active:scale-[0.96]"
                  aria-label="Dismiss stop message"
                >
                  <X className="size-4" />
                </button>
              </p>
            ) : (
              <p className="text-muted-foreground">
                {"Idle. "}
                <Kbd>Space</Kbd>
                {" stops the mechanism at any time, from anywhere on this page."}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => stop("Stopped with the Stop button")}
            disabled={!active}
            className={cn(
              "flex h-11 shrink-0 items-center gap-2 rounded-md px-4 short:h-10 font-mono text-sm font-semibold uppercase tracking-wider transition-[scale,background-color,color] duration-150 ease-out motion-safe:enabled:active:scale-[0.96]",
              "bg-destructive text-destructive-foreground hover:bg-destructive/90 focus-visible:ring-2 focus-visible:ring-focus-ring outline-none",
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
            <span className="font-mono text-xs font-semibold uppercase tracking-wider">Out of range</span>
            <span>{rangeWarning}</span>
          </p>
        </div>
      )}
      {active && currentWarning && (
        <div role="alert" className="bg-hazard text-hazard-foreground">
          <p className="mx-auto flex max-w-7xl flex-wrap items-center gap-2 px-4 py-2 text-sm leading-relaxed">
            <TriangleAlert className="size-4 shrink-0" aria-hidden />
            <span className="font-mono text-xs font-semibold uppercase tracking-wider">Current warning</span>
            <span>{currentWarning}</span>
            <button
              type="button"
              onClick={() => setCurrentAsWarning(false)}
              className="ms-auto shrink-0 rounded-sm border border-current px-2 py-0.5 font-mono text-xs font-semibold uppercase tracking-wider transition-[scale,background-color,color] duration-150 ease-out motion-safe:enabled:active:scale-[0.96]"
            >
              Make it a fault again
            </button>
          </p>
        </div>
      )}
    </div>
  )
}
