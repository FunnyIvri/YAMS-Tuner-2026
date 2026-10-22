"use client"

import { useSyncExternalStore } from "react"

/** A tablet on its side: a touch screen in landscape that is taller than a phone (see the short: variant). */
export const TABLET_LANDSCAPE = "(orientation: landscape) and (pointer: coarse) and (min-height: 541px)"

/** Whether a media query matches, kept up to date. False while prerendering. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = matchMedia(query)
      media.addEventListener("change", onChange)
      return () => media.removeEventListener("change", onChange)
    },
    () => matchMedia(query).matches,
    () => false,
  )
}
