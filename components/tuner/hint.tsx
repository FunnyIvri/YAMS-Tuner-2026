import { ChevronRight } from "lucide-react"
import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/** A longer explanation, folded away under a one-line summary until it is opened. */
export function Hint({ summary, children, className }: { summary: string; children: ReactNode; className?: string }) {
  return (
    <details className={cn("hint group rounded-md border border-border text-xs text-muted-foreground", className)}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 font-medium select-none hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 shrink-0 transition-transform duration-200 group-open:rotate-90" aria-hidden />
        {summary}
      </summary>
      <div className="px-3 pb-3 leading-relaxed">{children}</div>
    </details>
  )
}
