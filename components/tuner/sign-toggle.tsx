"use client"

import type { RefObject } from "react"
import { Button } from "@/components/ui/button"

/** The text with its sign flipped: "-" added, or taken off. An empty field becomes "-", ready for the digits. */
export function flipSign(text: string) {
  return text.startsWith("-") ? text.slice(1) : `-${text}`
}

/**
 * A ± button beside a number field that can be negative. The iPhone's decimal keypad has no minus key, so this is how
 * a negative number is entered there. Pressing it keeps the field focused while it is being edited, so the edit goes
 * on; pressed on its own, the caller applies the flipped value at once.
 */
export function SignToggle({
  label,
  input,
  disabled,
  onFlip,
}: {
  /** What the field is, for the button's name: "kG" gives "Make kG negative or positive". */
  label: string
  input: RefObject<HTMLInputElement | null>
  disabled?: boolean
  /** Called with whether the field was being edited, so the caller can apply the flip at once when it wasn't. */
  onFlip: (editing: boolean) => void
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      disabled={disabled}
      aria-label={`Make ${label} negative or positive`}
      title="Change the sign"
      className="shrink-0 font-mono"
      // Keep the focus in the field, so pressing this doesn't end its edit.
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => onFlip(document.activeElement === input.current)}
    >
      ±
    </Button>
  )
}
