import { REPO_URL } from "@/lib/site"

const VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? ""
/** A build from CI has a version such as 0.1.0+12.abc1234, ending in the short hash of its commit. */
const COMMIT = /\+\d+\.([0-9a-f]{7,40})$/.exec(VERSION)?.[1]

/** The version of this build, pinned to the bottom of the page so it is always visible. */
export function VersionFooter() {
  return (
    <footer className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background/90 backdrop-blur-sm">
      <div className="mx-auto flex max-w-7xl items-center justify-end px-4 py-1 font-mono text-xs text-muted-foreground">
        {COMMIT ? (
          <a
            href={`${REPO_URL}/commit/${COMMIT}`}
            target="_blank"
            rel="noreferrer"
            className="hover:text-foreground hover:underline"
            title="The commit this build came from"
          >
            YAMS Live Tuner v{VERSION}
          </a>
        ) : (
          <span>YAMS Live Tuner v{VERSION}</span>
        )}
      </div>
    </footer>
  )
}
