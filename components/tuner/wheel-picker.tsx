"use client"

import { useId } from "react"
import { useTuner } from "@/components/tuner/tuner-context"
import { Segmented } from "@/components/tuner/panel"
import { wheelLabels } from "@/lib/yams/topics"

/**
 * Chooses which wheel of a double flywheel the controls beside it work on. Every picker shares the one choice, so the
 * gains, the voltage drive and the telemetry readouts always show the same wheel. Nothing for one wheel.
 */
export function WheelPicker({ disabled }: { disabled?: boolean }) {
  const { wheels, wheel, setWheel } = useTuner()
  const labelId = useId()
  if (wheels.length < 2 || !wheel) return null
  const labels = wheelLabels(wheels)
  return (
    <div className="flex flex-col gap-1.5">
      <span id={labelId} className="text-xs uppercase tracking-wider text-muted-foreground">
        Wheel
      </span>
      <Segmented labelledBy={labelId} options={wheels.map((w) => [w, labels[w]] as const)} value={wheel} onChange={setWheel} disabled={disabled} />
    </div>
  )
}
