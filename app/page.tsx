import { TunerProvider } from "@/components/tuner/tuner-context"
import { ConnectionBar } from "@/components/tuner/connection-bar"
import { StopBar } from "@/components/tuner/stop-bar"
import { DemoControls } from "@/components/tuner/demo-controls"
import { SiteFooter } from "@/components/tuner/site-footer"
import { TunerLayout } from "@/components/tuner/tuner-layout"

export default function Page() {
  return (
    <TunerProvider>
      {/* At least a screen tall, with the main area taking the spare height: the footer sits at the bottom of the
          screen when the page is short, and after the content when it is long. It is never fixed. */}
      <div className="flex min-h-dvh flex-col pt-[var(--stop-bar-pad,0px)]">
        <ConnectionBar />
        <DemoControls />
        <div aria-hidden className="yass-stripe" />
        <StopBar />
        <TunerLayout />
        {/* On a phone turned sideways the footer is in the right-hand column instead, under the cards. */}
        <SiteFooter className="short:hidden" />
      </div>
    </TunerProvider>
  )
}
