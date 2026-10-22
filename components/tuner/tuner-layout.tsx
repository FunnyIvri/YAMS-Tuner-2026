"use client"

import { useEffect, useRef } from "react"
import { useTuner } from "@/components/tuner/tuner-context"
import { MechanismPanel } from "@/components/tuner/mechanism-panel"
import { SafetyChecklist } from "@/components/tuner/safety-checklist"
import { RangeVerification } from "@/components/tuner/range-verification"
import { LiveTuneStart, SetpointPanel } from "@/components/tuner/setpoint-panel"
import { VoltageInversionCheck } from "@/components/tuner/voltage-inversion-check"
import { GainsPanel } from "@/components/tuner/gains-panel"
import { TelemetryPanel } from "@/components/tuner/telemetry-panel"
import { TABLET_LANDSCAPE, useMediaQuery } from "@/lib/use-media-query"

export function TunerLayout() {
  return useMediaQuery(TABLET_LANDSCAPE) ? <TabletLandscapeLayout /> : <DefaultLayout />
}

/** Desktop, portrait, and a phone turned sideways. */
function DefaultLayout() {
  return (
    // On a phone turned sideways (short:), the telemetry is pinned on the left and everything else scrolls on the right.
    <main className="mx-auto grid max-w-7xl gap-4 px-4 pt-6 pb-8 lg:grid-cols-2 short:grid-cols-2 short:gap-3 short:px-3 short:pt-3">
      <div className="flex flex-col gap-4 short:contents short:[&>*]:col-start-2">
        <MechanismPanel />
        <SafetyChecklist />
        <VoltageInversionCheck />
        <RangeVerification />
      </div>
      <div className="flex flex-col gap-4 lg:sticky lg:top-20 lg:max-h-[calc(100dvh-8rem)] lg:self-start short:contents">
        <div className="shrink-0 short:sticky short:top-14 short:col-start-1 short:row-span-6 short:row-start-1 short:h-[calc(100dvh-5.5rem)] short:self-start">
          <TelemetryPanel />
        </div>
        <div className="flex min-h-0 flex-col gap-4 lg:overflow-y-auto lg:overscroll-contain lg:pr-1 short:contents short:[&>*]:col-start-2">
          <SetpointPanel />
          <GainsPanel />
        </div>
      </div>
    </main>
  )
}

/**
 * A tablet on its side. Until Live Tuning starts, step 5 is a start button under the telemetry. Once it starts,
 * the setpoint controls and gains open at the top of the left column, beside the telemetry on the right.
 *
 * Only the telemetry is pinned. The gains scroll with the page, so when a field near the bottom (such as the
 * current limits) opens the on-screen keyboard, the page can scroll it into view. Inside a pinned column with its
 * own scroll area, the keyboard covered them.
 */
function TabletLandscapeLayout() {
  const { session } = useTuner()
  const tuning = session === "tune"
  const controls = useRef<HTMLDivElement>(null)

  // Starting is pressed on the right, often with the left column scrolled down to the last step.
  useEffect(() => {
    if (tuning) controls.current?.scrollIntoView({ block: "start", behavior: "smooth" })
  }, [tuning])

  return (
    <main className="mx-auto grid max-w-7xl grid-cols-2 gap-4 px-4 pt-6 pb-8">
      <div className="flex flex-col gap-4">
        {tuning && (
          <div ref={controls} className="flex scroll-mt-24 flex-col gap-4">
            <SetpointPanel />
            <GainsPanel />
          </div>
        )}
        <MechanismPanel />
        <SafetyChecklist />
        <VoltageInversionCheck />
        <RangeVerification />
        {!tuning && <GainsPanel />}
      </div>
      <div className="sticky top-20 flex flex-col gap-4 self-start">
        <TelemetryPanel />
        {!tuning && <LiveTuneStart />}
      </div>
    </main>
  )
}
