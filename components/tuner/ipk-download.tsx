"use client"

import { useEffect, useState } from "react"
import { Download } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ON_SYSTEMCORE, REPO, REPO_URL } from "@/lib/site"

const RELEASES_URL = `${REPO_URL}/releases/latest`

/** The .ipk the Pages deploy built from the same commit and serves beside the site. */
const BUILT_IPK_FILE = process.env.NEXT_PUBLIC_IPK_FILE
const BUILT_IPK_VERSION = process.env.NEXT_PUBLIC_IPK_VERSION
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || ""

interface Ipk {
  url: string
  version: string
}

const BUILT_IPK: Ipk | null =
  BUILT_IPK_FILE && BUILT_IPK_VERSION
    ? { url: `${BASE_PATH}/${encodeURIComponent(BUILT_IPK_FILE)}`, version: BUILT_IPK_VERSION }
    : null

/**
 * Links to the .ipk built with this copy of the site. A build without one, such as `pnpm dev`, links to the .ipk
 * attached to the latest GitHub release instead, or the releases page if it can't be found.
 */
export function IpkDownload() {
  const [latest, setLatest] = useState<Ipk | null>(null)
  const ipk = BUILT_IPK ?? latest

  useEffect(() => {
    if (ON_SYSTEMCORE || BUILT_IPK) return
    const controller = new AbortController()
    fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((release) => {
        const asset = release?.assets?.find((a: { name: string }) => a.name.endsWith(".ipk"))
        if (asset) setLatest({ url: asset.browser_download_url, version: release.tag_name })
      })
      .catch(() => {})
    return () => controller.abort()
  }, [])

  if (ON_SYSTEMCORE) return null

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            aria-label="Download the SystemCore package (.ipk)"
            render={
              <a
                href={ipk?.url ?? RELEASES_URL}
                download={BUILT_IPK ? BUILT_IPK_FILE : undefined}
                target={ipk ? undefined : "_blank"}
                rel="noreferrer"
              />
            }
          />
        }
      >
        <Download data-icon="inline-start" />
        <span className="hidden sm:inline">Download IPK</span>
        {ipk && <span className="hidden font-mono normal-case text-muted-foreground sm:inline">{ipk.version}</span>}
      </TooltipTrigger>
      <TooltipContent>Install the tuner on SystemCore: drag the .ipk onto http://robot.local</TooltipContent>
    </Tooltip>
  )
}
