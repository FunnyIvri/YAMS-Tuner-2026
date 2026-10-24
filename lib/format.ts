/** A non-breaking space, so a number and its unit never wrap apart. */
export const NBSP = " "

/** Shown where a value is not known yet. */
export const EMPTY = "—"

/** A number as text with a real minus sign (−), and no sign on a value that rounds to zero. */
export function num(value: number, digits: number) {
  const s = value.toFixed(digits)
  if (/^-0(\.0+)?$/.test(s)) return s.slice(1)
  return s.replace(/^-/, "−")
}

/** Volts, e.g. "−1.00 V". */
export function formatVolts(v: number) {
  return `${num(v, 2)}${NBSP}V`
}
