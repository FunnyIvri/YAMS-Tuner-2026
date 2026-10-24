/** What a number field accepts. With none of these set, any number. */
export interface NumberFormat {
  /** Whole numbers only. */
  integer?: boolean
  /** At most this many digits after the decimal point. */
  decimals?: number
  /** At most this many significant digits. */
  significant?: number
  /** A minus sign is allowed. */
  negative?: boolean
}

/**
 * Significant digits in a typed number: every digit after the leading zeros, except a whole number's trailing zeros
 * ("12000" has 2, "0.0120" has 3).
 */
export function significantDigits(text: string) {
  const unsigned = text.replace(/^-/, "")
  const digits = unsigned.replace(".", "").replace(/^0+/, "")
  return unsigned.includes(".") ? digits.length : digits.replace(/0+$/, "").length
}

/** A decimal comma, as the keypad types it in much of the world, as a decimal point. */
export function normalizeDecimal(text: string) {
  return text.replace(",", ".")
}

/** Whether the text fits the format so far: a number, or the start of one ("", "-", "1."), within its limits. */
export function fitsFormat(text: string, f: NumberFormat) {
  if (!(f.integer ? /^-?\d*$/ : /^-?\d*\.?\d*$/).test(text)) return false
  if (!f.negative && text.startsWith("-")) return false
  const decimals = text.split(".")[1]?.length ?? 0
  if (f.decimals !== undefined && decimals > f.decimals) return false
  if (f.significant !== undefined && significantDigits(text) > f.significant) return false
  return true
}

/** A finished number in the format, or null: "", "-" and "1." with nothing after the point are not. */
export function parseFormatted(text: string, f: NumberFormat): number | null {
  if (!fitsFormat(text, f) || !/\d/.test(text) || text.endsWith(".")) return null
  const v = Number(text)
  return Number.isFinite(v) ? v : null
}

/**
 * The next text for a field as it is typed into: the new text if it fits, otherwise the old one, so a key that would
 * break the format does nothing. Deleting is always allowed, so a value from the robot that is longer than the format
 * can be shortened.
 */
export function nextText(previous: string, typed: string, f: NumberFormat) {
  typed = normalizeDecimal(typed)
  if (fitsFormat(typed, f)) return typed
  return typed.length < previous.length ? typed : previous
}

/** A short description of the format, for a field's hint or error. */
export function describeFormat(f: NumberFormat) {
  if (f.integer) return f.negative ? "A whole number." : "A whole number, 0 or more."
  const parts = [f.decimals !== undefined ? `up to ${f.decimals} decimal places` : null, f.significant !== undefined ? `up to ${f.significant} significant digits` : null].filter(Boolean)
  const sign = f.negative ? "" : ", 0 or more"
  return parts.length > 0 ? `A number${sign}, ${parts.join(" and ")}.` : `A number${sign}.`
}

/** The keyboard a phone shows for the format. */
export function inputModeFor(f: NumberFormat): "numeric" | "decimal" {
  return f.integer && !f.negative ? "numeric" : "decimal"
}
