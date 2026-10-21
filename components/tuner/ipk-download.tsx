"use client"

import { useEffect, useState } from "react"
import { Download } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ON_SYSTEMCORE, REPO, REPO_URL } from "@/lib/site"

const RELEASES_URL = `${REPO_URL}/releases/latest`

interface LatestIpk {
  url: string
  version: string
}

/** Links to the .ipk attached to the latest GitHub release, or the releases page if it can't be found. */
export function IpkDownload() {
  const [ipk, setIpk] = useState<LatestIpk | null>(null)

  useEffect(() => {
    if (ON_SYSTEMCORE) return
    const controller = new AbortController()
    fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((release) => {
        const asset = release?.assets?.find((a: { name: string }) => a.name.endsWith(".ipk"))
        if (asset) setIpk({ url: asset.browser_download_url, version: release.tag_name })
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
            render={<a href={ipk?.url ?? RELEASES_URL} target={ipk ? undefined : "_blank"} rel="noreferrer" />}
          />
        }
      >
        <Download data-icon="inline-start" />
        <span className="hidden sm:inline">Download IPK</span>
        {ipk && <span className="hidden font-mono text-muted-foreground sm:inline">{ipk.version}</span>}
      </TooltipTrigger>
      <TooltipContent>Install the tuner on SystemCore: drag the .ipk onto http://robot.local</TooltipContent>
    </Tooltip>
  )
}
