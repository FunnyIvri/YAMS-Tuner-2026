import { TunerProvider } from "@/components/tuner/tuner-context"
import { ConnectionBar } from "@/components/tuner/connection-bar"
import { StopBar } from "@/components/tuner/stop-bar"
import { DemoControls } from "@/components/tuner/demo-controls"
import { MechanismPanel } from "@/components/tuner/mechanism-panel"
import { SafetyChecklist } from "@/components/tuner/safety-checklist"
import { RangeVerification } from "@/components/tuner/range-verification"
import { SetpointPanel } from "@/components/tuner/setpoint-panel"
import { VoltageInversionCheck } from "@/components/tuner/voltage-inversion-check"
import { GainsPanel } from "@/components/tuner/gains-panel"
import { TelemetryPanel } from "@/components/tuner/telemetry-panel"
import { VersionFooter } from "@/components/tuner/version-footer"

export default function Page() {
  return (
    <TunerProvider>
      <ConnectionBar />
      <DemoControls />
      <div aria-hidden className="yass-stripe" />
      <StopBar />
      {/* On a phone turned sideways (short:), the telemetry is pinned on the left and everything else scrolls on the right. */}
      <main className="mx-auto grid max-w-7xl gap-4 px-4 pt-6 pb-12 lg:grid-cols-2 short:grid-cols-2 short:gap-3 short:px-3 short:pt-3">
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
      <VersionFooter />
    </TunerProvider>
  )
}
