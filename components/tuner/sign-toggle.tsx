"use client"

import { useEffect, useState, type RefObject } from "react"
import { Button } from "@/components/ui/button"

/** The text with its sign flipped: "-" added, or taken off. An empty field becomes "-", ready for the digits. */
export function flipSign(text: string) {
  return text.startsWith("-") ? text.slice(1) : `-${text}`
}

/**
 * Whether a field's ± button shows: on a touch screen, while the field is focused. A keyboard has a minus key, and a
 * touch keypad only opens for a focused field, so that is the only time it is needed.
 */
export function useSignToggleShown(input: RefObject<HTMLInputElement | null>) {
  const [touch, setTouch] = useState(false)
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    const query = window.matchMedia("(pointer: coarse)")
    const onQuery = () => setTouch(query.matches)
    onQuery()
    query.addEventListener("change", onQuery)
    return () => query.removeEventListener("change", onQuery)
  }, [])
  useEffect(() => {
    // Read from the document, so a field that is rendered again is still followed.
    const onFocus = () => setFocused(input.current !== null && document.activeElement === input.current)
    onFocus()
    document.addEventListener("focusin", onFocus)
    document.addEventListener("focusout", onFocus)
    return () => {
      document.removeEventListener("focusin", onFocus)
      document.removeEventListener("focusout", onFocus)
    }
  }, [input])
  return touch && focused
}

/**
 * A ± button before a number field that can be negative. The iPhone's decimal keypad has no minus key, so this is how
 * a negative number is entered there. It only shows on a touch screen while the field is focused, and pressing it
 * keeps the field focused, so the edit goes on.
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
  const shown = useSignToggleShown(input)
  if (!shown) return null
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
