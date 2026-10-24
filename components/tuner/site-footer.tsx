import { GitHubLink } from "@/components/tuner/github-link"
import { IpkDownload } from "@/components/tuner/ipk-download"
import { ON_SYSTEMCORE, REPO_URL } from "@/lib/site"
import { cn } from "@/lib/utils"

const VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? ""
/** A build from CI has a version such as 0.1.0+12.abc1234, ending in the short hash of its commit. */
const COMMIT = /\+\d+\.([0-9a-f]{7,40})$/.exec(VERSION)?.[1]

/**
 * The footer the YASS web tools share: who made it and its source, then a download of this build as a SystemCore
 * package with how to install it, and its version.
 */
export function SiteFooter({ className }: { className?: string }) {
  const label = `YAMS Live Tuner v${VERSION}`
  return (
    <footer className={cn("border-t border-border pt-6 pb-4 md:pt-8 md:pb-5", className)}>
      <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-4 md:flex-row short:flex-col short:gap-2">
        <p className="text-center text-sm leading-loose text-muted-foreground md:text-start short:text-center">
          Made with 💚 by nstrike, Rivet, and Yet Another Software Suite
        </p>
        <GitHubLink />
      </div>
      <div className="mx-auto mt-4 flex max-w-7xl flex-col items-center justify-between gap-3 px-4 md:flex-row short:flex-col">
        {ON_SYSTEMCORE ? (
          <span className="text-xs text-muted-foreground">Served from this SystemCore.</span>
        ) : (
          <IpkDownload />
        )}
        <span className="font-mono text-xs text-muted-foreground" data-ipk="version">
          {COMMIT ? (
            <a
              href={`${REPO_URL}/commit/${COMMIT}`}
              target="_blank"
              rel="noreferrer"
              className="hover:text-foreground hover:underline"
              title="The commit this build came from"
            >
              {label}
            </a>
          ) : (
            label
          )}
        </span>
      </div>
    </footer>
  )
}
