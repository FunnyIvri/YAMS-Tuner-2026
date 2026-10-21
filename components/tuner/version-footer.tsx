import { ON_SYSTEMCORE, REPO_URL } from "@/lib/site"

const VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? ""
/** A build from CI has a version such as 0.1.0+12.abc1234, ending in the short hash of its commit. */
const COMMIT = /\+\d+\.([0-9a-f]{7,40})$/.exec(VERSION)?.[1]

/** The version of this build, pinned to the bottom of the page so it is always visible. */
export function VersionFooter() {
  return (
    <footer className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background/90 backdrop-blur-sm">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-3 px-4 py-1 font-mono text-xs text-muted-foreground">
        {/* How to install the package the Download IPK button gets; it is already installed on the robot */}
        {ON_SYSTEMCORE ? (
          <span />
        ) : (
          <span data-hint="ipk-install">
            <span className="hidden lg:inline">Install on SystemCore: drag the .ipk onto http://robot.local, then open the yams-tuner tile</span>
            <span className="lg:hidden">Install: drag the .ipk onto robot.local</span>
          </span>
        )}
        {COMMIT ? (
          <a
            href={`${REPO_URL}/commit/${COMMIT}`}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 hover:text-foreground hover:underline"
            title="The commit this build came from"
          >
            YAMS Live Tuner v{VERSION}
          </a>
        ) : (
          <span className="shrink-0">YAMS Live Tuner v{VERSION}</span>
        )}
      </div>
    </footer>
  )
}
