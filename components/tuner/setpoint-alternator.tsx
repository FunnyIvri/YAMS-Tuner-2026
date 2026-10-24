"use client"

import { useEffect, useRef, useState } from "react"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"

export const ALTERNATE_PERIOD_MS = 5000

type Props = {
  id: string
  active: boolean
  unit: string
  step: number
  defaultA: number
  defaultB: number
  clamp: (value: number) => number
  write: (value: number) => void
  confirmMessage?: (a: number, b: number) => string | null
}

export function SetpointAlternator({ id, active, unit, step, defaultA, defaultB, clamp, write, confirmMessage }: Props) {
  const [a, setA] = useState(String(defaultA))
  const [b, setB] = useState(String(defaultB))
  const [enabled, setEnabled] = useState(false)
  const [pendingConfirm, setPendingConfirm] = useState<string | null>(null)
  const [onB, setOnB] = useState(false)
  const [remaining, setRemaining] = useState(ALTERNATE_PERIOD_MS / 1000)

  const valueA = clamp(Number(a))
  const valueB = clamp(Number(b))
  const valid = Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && a !== "" && b !== ""

  const writeRef = useRef(write)
  writeRef.current = write
  const targetsRef = useRef({ a: valueA, b: valueB })
  targetsRef.current = { a: valueA, b: valueB }

  const running = enabled && active && valid

  useEffect(() => {
    if (!active) {
      setEnabled(false)
      setPendingConfirm(null)
    }
  }, [active])

  useEffect(() => {
    if (!running) return
    let useB = false
    let nextAt = Date.now() + ALTERNATE_PERIOD_MS
    writeRef.current(targetsRef.current.a)
    setOnB(false)
    setRemaining(ALTERNATE_PERIOD_MS / 1000)
    const tick = setInterval(() => {
      const now = Date.now()
      if (now >= nextAt) {
        useB = !useB
        nextAt = now + ALTERNATE_PERIOD_MS
        writeRef.current(useB ? targetsRef.current.b : targetsRef.current.a)
        setOnB(useB)
      }
      setRemaining(Math.max(0, Math.ceil((nextAt - now) / 1000)))
    }, 200)
    return () => clearInterval(tick)
  }, [running])

  const toggle = (next: boolean) => {
    if (!next) {
      setEnabled(false)
      setPendingConfirm(null)
      return
    }
    const warning = confirmMessage?.(valueA, valueB) ?? null
    if (warning) {
      setPendingConfirm(warning)
      return
    }
    setEnabled(true)
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-background p-3">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={`${id}-toggle`} className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">Alternate setpoints</span>
          <span className="text-xs text-muted-foreground">Switches between A and B every 5 seconds.</span>
        </label>
        <Switch
          id={`${id}-toggle`}
          checked={enabled}
          disabled={!active || !valid}
          onCheckedChange={(checked) => toggle(checked)}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        {(
          [
            ["A", a, setA, !onB],
            ["B", b, setB, onB],
          ] as const
        ).map(([label, value, set, current]) => (
          <div key={label} className="flex flex-col gap-1">
            <label htmlFor={`${id}-${label}`} className="flex items-center gap-2 text-xs text-muted-foreground">
              {`Setpoint ${label} (${unit})`}
              {running && current && <span className="font-mono text-primary-text">{`active · ${remaining}s`}</span>}
            </label>
            <Input
              id={`${id}-${label}`}
              type="number"
              step={step}
              className="font-mono"
              value={value}
              disabled={running}
              onChange={(e) => set(e.target.value)}
            />
          </div>
        ))}
      </div>
      {pendingConfirm && (
        <div className="flex flex-col gap-2 rounded-md border border-hazard bg-hazard/15 p-3">
          <p className="text-sm leading-relaxed">{pendingConfirm}</p>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => {
                setPendingConfirm(null)
                setEnabled(true)
              }}
            >
              Start alternating
            </Button>
            <Button size="sm" variant="outline" onClick={() => setPendingConfirm(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
