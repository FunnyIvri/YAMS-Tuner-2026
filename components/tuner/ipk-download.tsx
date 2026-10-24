"use client"

import { useEffect, useState } from "react"
import { Download } from "lucide-react"
import { Button } from "@/components/ui/button"
import { REPO, REPO_URL } from "@/lib/site"

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
 * Links to the .ipk built with this copy of the site, with how to install it. A build without one, such as
 * `pnpm dev`, links to the .ipk attached to the latest GitHub release instead, or the releases page if it can't be
 * found.
 */
export function IpkDownload() {
  const [latest, setLatest] = useState<Ipk | null>(null)
  const ipk = BUILT_IPK ?? latest

  useEffect(() => {
    if (BUILT_IPK) return
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

  return (
    <div className="flex flex-col items-center gap-x-3 gap-y-1 md:flex-row short:flex-col">
      <Button
        variant="outline"
        size="sm"
        nativeButton={false}
        render={
          <a
            href={ipk?.url ?? RELEASES_URL}
            download={BUILT_IPK ? BUILT_IPK_FILE : undefined}
            target={ipk ? undefined : "_blank"}
            rel="noreferrer"
            data-ipk="download"
          />
        }
      >
        <Download data-icon="inline-start" />
        Download for SystemCore (.ipk)
      </Button>
      <span className="text-center text-xs text-muted-foreground md:text-start short:text-center" data-ipk="hint">
        Install it by dragging the .ipk onto http://robot.local, then open the yams-tuner tile.
      </span>
    </div>
  )
}
