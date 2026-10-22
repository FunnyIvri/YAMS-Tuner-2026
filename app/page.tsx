import { TunerProvider } from "@/components/tuner/tuner-context"
import { ConnectionBar } from "@/components/tuner/connection-bar"
import { StopBar } from "@/components/tuner/stop-bar"
import { DemoControls } from "@/components/tuner/demo-controls"
import { SiteFooter } from "@/components/tuner/site-footer"
import { TunerLayout } from "@/components/tuner/tuner-layout"

export default function Page() {
  return (
    <TunerProvider>
      <ConnectionBar />
      <DemoControls />
      <div aria-hidden className="yass-stripe" />
      <StopBar />
      <TunerLayout />
      <SiteFooter />
    </TunerProvider>
  )
}
