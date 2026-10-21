import type { ReactNode, SelectHTMLAttributes } from "react"
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
    <section className={cn("flex flex-col rounded-sm border border-l-[3px] border-border border-l-primary bg-card text-card-foreground", className)}>
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
            <h2 className="text-lg font-bold leading-6">
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
        "h-9 w-full rounded-sm border border-input bg-background px-2.5 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50",
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
      <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground short:truncate short:text-[10px]">{label}</span>
      <span
        className={cn(
          "font-mono text-base font-bold tabular text-primary short:whitespace-nowrap short:text-[min(0.875rem,2vw)]",
          tone === "danger" && "text-destructive",
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
        "inline-flex h-5 items-center rounded-sm border border-current/30 px-1.5 font-mono text-[11px] font-medium uppercase",
        className,
      )}
    >
      {children}
    </kbd>
  )
}

export function Notice({ tone = "info", children }: { tone?: "info" | "danger" | "warn"; children: ReactNode }) {
  return (
    <p
      role={tone === "danger" ? "alert" : "status"}
      className={cn(
        "rounded-md border px-3 py-2 text-sm leading-relaxed",
        tone === "info" && "border-border bg-background text-foreground",
        tone === "warn" && "border-hazard bg-hazard/15 text-foreground",
        tone === "danger" && "border-destructive bg-destructive/10 text-destructive",
      )}
    >
      {children}
    </p>
  )
}
