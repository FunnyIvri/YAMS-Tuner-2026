import { formatPosition, type Axis } from "@/lib/yams/topics"

/** A ruler of the mechanism's travel: soft limits, verified ends, setpoint and live position. */
export function TravelGauge({
  axis,
  position,
  setpoint,
  softLower,
  softUpper,
  verifiedLower,
  verifiedUpper,
}: {
  axis: Axis
  position: number | undefined
  setpoint?: number
  softLower: number | undefined
  softUpper: number | undefined
  verifiedLower: number | null
  verifiedUpper: number | null
}) {
  const points = [position, setpoint, softLower, softUpper, verifiedLower, verifiedUpper].filter(
    (v): v is number => typeof v === "number",
  )
  if (points.length === 0) {
    return <div className="h-20 rounded-md border border-dashed border-border bg-background" aria-hidden />
  }
  let min = Math.min(...points)
  let max = Math.max(...points)
  const pad = Math.max((max - min) * 0.08, axis === "linear" ? 0.05 : 10)
  min -= pad
  max += pad
  const pct = (v: number) => `${((v - min) / (max - min)) * 100}%`

  const hasVerified = verifiedLower !== null && verifiedUpper !== null
  // Caution zones mark travel outside a defined range; with no range there is nothing to shade.
  const zoneLower = hasVerified ? verifiedLower : softLower !== undefined && softUpper !== undefined ? softLower : undefined
  const zoneUpper = hasVerified ? verifiedUpper : softLower !== undefined && softUpper !== undefined ? softUpper : undefined

  return (
    <figure className="flex flex-col gap-2">
      <div className="relative h-20 overflow-hidden rounded-md border border-border bg-background">
        {zoneLower !== undefined && (
          <div className="hazard-stripes absolute inset-y-0 left-0 opacity-25" style={{ width: pct(zoneLower) }} aria-hidden />
        )}
        {zoneUpper !== undefined && (
          <div className="hazard-stripes absolute inset-y-0 right-0 opacity-25" style={{ left: pct(zoneUpper) }} aria-hidden />
        )}
        {hasVerified && (
          <div
            className="absolute inset-y-6 border-y-2 border-foreground bg-foreground/10"
            style={{ left: pct(verifiedLower), width: `calc(${pct(verifiedUpper)} - ${pct(verifiedLower)})` }}
            aria-hidden
          />
        )}
        {[verifiedLower, verifiedUpper].map((v, i) =>
          v === null ? null : (
            <div key={i} className="absolute inset-y-3 w-0.5 bg-foreground" style={{ left: pct(v) }} aria-hidden />
          ),
        )}
        {setpoint !== undefined && (
          <div className="absolute inset-y-0 w-px border-l-2 border-dashed border-destructive" style={{ left: pct(setpoint) }} aria-hidden />
        )}
        {position !== undefined && (
          <div className="absolute inset-y-0 -translate-x-1/2" style={{ left: pct(position) }} aria-hidden>
            <div className="mx-auto h-full w-1 bg-hazard ring-1 ring-foreground" />
          </div>
        )}
      </div>
      <figcaption className="flex flex-wrap justify-between gap-x-4 gap-y-1 font-mono text-xs text-muted-foreground tabular">
        <span>
          {softLower !== undefined && softUpper !== undefined
            ? `Soft ${formatPosition(softLower, axis)} … ${formatPosition(softUpper, axis)}`
            : "No soft limits"}
        </span>
        <span className="text-foreground">{`Now ${formatPosition(position, axis)}`}</span>
        <span>
          {hasVerified
            ? `Verified ${formatPosition(verifiedLower, axis)} … ${formatPosition(verifiedUpper, axis)}`
            : "Not verified"}
        </span>
      </figcaption>
    </figure>
  )
}
