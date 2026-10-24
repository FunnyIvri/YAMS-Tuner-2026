import { useId, useRef, type KeyboardEvent, type ReactNode, type SelectHTMLAttributes } from "react"
import { cn } from "@/lib/utils"

export function Panel({
  step,
  title,
  description,
  aside,
  locked,
  children,
  className,
}: {
  step?: number
  title: string
  description?: ReactNode
  aside?: ReactNode
  /** Shown instead of the body when a prerequisite is missing. */
  locked?: string | null
  children?: ReactNode
  className?: string
}) {
  return (
    <section className={cn("flex flex-col rounded-sm border border-s-[3px] border-border border-s-primary bg-card text-card-foreground", className)}>
      <header className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
        <div className="flex items-start gap-3">
          {step !== undefined && (
            <span
              aria-hidden
              className={cn(
                "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-sm font-mono text-xs font-bold",
                locked ? "bg-muted text-muted-foreground" : "bg-primary text-primary-foreground",
              )}
            >
              {step}
            </span>
          )}
          <div className="flex flex-col gap-0.5">
            {/* Focusable so a new step can move focus to its title. */}
            <h2 tabIndex={-1} data-step-heading={step} className="text-balance text-lg font-bold leading-[1.3] outline-none">
              {step !== undefined && <span className="sr-only">{`Step ${step}: `}</span>}
              {title}
            </h2>
            {description && <p className="text-pretty text-sm leading-relaxed text-muted-foreground">{description}</p>}
          </div>
        </div>
        {aside}
      </header>
      {locked ? (
        <p className="px-4 py-4 text-sm leading-relaxed text-muted-foreground">{locked}</p>
      ) : (
        <div className="flex flex-col gap-4 p-4">{children}</div>
      )}
    </section>
  )
}

export function Field({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  )
}

export function NativeSelect({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "h-9 w-full rounded-sm border border-input bg-background px-2.5 text-base outline-none sm:text-sm focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  )
}

export function Readout({ label, value, tone }: { label: string; value: ReactNode; tone?: "warn" | "danger" }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-md border border-border bg-background px-3 py-2 short:px-1.5 short:py-1">
      <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground short:break-words short:leading-tight">{label}</span>
      <span
        className={cn(
          "font-mono text-base font-bold tabular text-primary-text short:whitespace-nowrap short:text-[min(0.875rem,2vw)]",
          tone === "danger" && "text-destructive-text",
          tone === "warn" && "underline decoration-hazard decoration-2 underline-offset-4",
        )}
      >
        {value}
      </span>
    </div>
  )
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 items-center rounded-sm border border-current/30 px-1.5 font-mono text-xs font-medium uppercase tracking-wider",
        className,
      )}
    >
      {children}
    </kbd>
  )
}

export function Notice({
  tone = "info",
  live = true,
  children,
}: {
  tone?: "info" | "danger" | "warn"
  /** False inside a LiveRegion, which does the announcing. */
  live?: boolean
  children: ReactNode
}) {
  return (
    <p
      role={live ? (tone === "danger" ? "alert" : "status") : undefined}
      className={cn(
        "rounded-md border px-3 py-2 text-sm leading-relaxed",
        tone === "info" && "border-border bg-background text-foreground",
        tone === "warn" && "border-hazard bg-hazard/15 text-foreground",
        tone === "danger" && "border-destructive bg-destructive/10 text-destructive-text",
      )}
    >
      {children}
    </p>
  )
}

/**
 * A live region that is always on the page, so a message that appears inside it is announced. A region that appears
 * together with its message often is not. Takes no space of its own.
 */
export function LiveRegion({ assertive = false, children }: { assertive?: boolean; children?: ReactNode }) {
  return (
    <div role={assertive ? "alert" : "status"} aria-live={assertive ? "assertive" : "polite"} className="contents">
      {children}
    </div>
  )
}

/** Arrow keys, Home and End move between a group's items, and choose the one they land on. */
function moveWithKeys<T extends string>(
  e: KeyboardEvent<HTMLElement>,
  keys: readonly T[],
  current: T,
  choose: (value: T) => void,
  focus: (value: T) => void,
) {
  const i = keys.indexOf(current)
  const rtl = getComputedStyle(e.currentTarget).direction === "rtl"
  const next =
    e.key === "Home"
      ? 0
      : e.key === "End"
        ? keys.length - 1
        : e.key === "ArrowDown" || e.key === (rtl ? "ArrowLeft" : "ArrowRight")
          ? (i + 1) % keys.length
          : e.key === "ArrowUp" || e.key === (rtl ? "ArrowRight" : "ArrowLeft")
            ? (i - 1 + keys.length) % keys.length
            : null
  if (next === null) return
  e.preventDefault()
  choose(keys[next])
  focus(keys[next])
}

const SEGMENT_GROUP =
  "grid auto-cols-fr grid-flow-col gap-1 rounded-[calc(var(--radius-sm)+5px)] border border-border p-1"
/** The chosen item is filled and underlined, so it doesn't rely on the fill's colour alone. */
const SEGMENT =
  "min-h-9 rounded-sm border-b-2 border-transparent px-3 py-1.5 text-muted-foreground transition-[background-color,color] duration-150 hover:text-foreground disabled:opacity-50"

/** Tabs inside a card: one row of buttons, the chosen one filled in and underlined. Pair with CardTabPanel. */
export function CardTabs<T extends string>({
  label,
  tabs,
  value,
  onChange,
}: {
  label: string
  tabs: readonly (readonly [T, string])[]
  value: T
  onChange: (value: T) => void
}) {
  const id = useCardTabsId(label)
  const list = useRef<HTMLDivElement>(null)
  const keys = tabs.map(([key]) => key)
  return (
    <div ref={list} role="tablist" aria-label={label} className={SEGMENT_GROUP}>
      {tabs.map(([key, text]) => (
        <button
          key={key}
          id={`${id}-tab-${key}`}
          type="button"
          role="tab"
          aria-selected={value === key}
          aria-controls={`${id}-panel`}
          tabIndex={value === key ? 0 : -1}
          onClick={() => onChange(key)}
          onKeyDown={(e) =>
            moveWithKeys(e, keys, value, onChange, (k) => list.current?.querySelector<HTMLElement>(`[id="${id}-tab-${k}"]`)?.focus())
          }
          className={cn(
            SEGMENT,
            "font-mono text-xs font-bold uppercase tracking-wider aria-selected:border-primary-text aria-selected:bg-secondary aria-selected:text-foreground",
          )}
        >
          {text}
        </button>
      ))}
    </div>
  )
}

/** The content of the chosen CardTabs tab. Give it the same label as its CardTabs. */
export function CardTabPanel<T extends string>({ label, value, children }: { label: string; value: T; children: ReactNode }) {
  const id = useCardTabsId(label)
  return (
    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${value}`} className="flex flex-col gap-4">
      {children}
    </div>
  )
}

/** CardTabs and its CardTabPanel find each other by their label. */
function useCardTabsId(label: string) {
  return `cardtabs-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
}

/** A choice of one, shown as a row of buttons: a radio group with arrow keys, the chosen one filled and underlined. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  labelledBy,
  disabled,
  className,
}: {
  options: readonly (readonly [T, ReactNode])[]
  value: T
  onChange: (value: T) => void
  label?: string
  labelledBy?: string
  disabled?: boolean
  className?: string
}) {
  const group = useRef<HTMLDivElement>(null)
  const id = useId()
  const keys = options.map(([key]) => key)
  return (
    <div ref={group} role="radiogroup" aria-label={label} aria-labelledby={labelledBy} className={cn(SEGMENT_GROUP, className)}>
      {options.map(([key, text]) => (
        <button
          key={key}
          id={`${id}-${key}`}
          type="button"
          role="radio"
          aria-checked={value === key}
          tabIndex={value === key ? 0 : -1}
          disabled={disabled}
          onClick={() => onChange(key)}
          onKeyDown={(e) => moveWithKeys(e, keys, value, onChange, (k) => group.current?.querySelector<HTMLElement>(`[id="${id}-${k}"]`)?.focus())}
          className={cn(SEGMENT, "text-sm font-medium aria-checked:border-primary-text aria-checked:bg-secondary aria-checked:text-foreground")}
        >
          {text}
        </button>
      ))}
    </div>
  )
}
