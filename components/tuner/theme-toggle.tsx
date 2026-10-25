"use client"

import { useEffect, useState } from "react"
import { Moon, Sun } from "lucide-react"

/** Light and dark, like the YASS website's toggle. The choice is remembered in this browser. */
export function ThemeToggle() {
  const [dark, setDark] = useState(false)
  useEffect(() => setDark(document.documentElement.classList.contains("dark")), [])

  const toggle = () => {
    const next = !dark
    setDark(next)
    // Switch with every transition off, so the page's colour transitions don't all run at once and smear the change.
    const pause = document.createElement("style")
    pause.textContent = "*, *::before, *::after { transition: none !important; }"
    document.head.appendChild(pause)
    document.documentElement.classList.toggle("dark", next)
    void getComputedStyle(document.body).color
    requestAnimationFrame(() => requestAnimationFrame(() => pause.remove()))
    try {
      localStorage.setItem("theme", next ? "dark" : "light")
    } catch {
      // Storage can be unavailable in private windows; the choice just isn't remembered.
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      title={dark ? "Light mode" : "Dark mode"}
      className="rounded-sm p-2 text-muted-foreground transition-[scale,background-color,color] duration-150 ease-out motion-safe:active:scale-[0.96] hover:bg-muted hover:text-primary-text"
    >
      {dark ? <Sun className="size-5" aria-hidden /> : <Moon className="size-5" aria-hidden />}
    </button>
  )
}
