"use client"

import { useEffect, useRef } from "react"
import { useAxisValues, useNtValue, useTuner } from "@/components/tuner/tuner-context"
import { Panel, Readout } from "@/components/tuner/panel"
import { axisReader, formatNumber, formatPosition, velocityUnit, yamsTopics } from "@/lib/yams/topics"

const WINDOW_MS = 10_000

export function TelemetryPanel() {
  const { mechanismName, axis, kind, stallCurrent, status } = useTuner()
  const { position, velocity, current } = useAxisValues()
  const temp = useNtValue<number>(mechanismName ? yamsTopics(mechanismName).data.temperature : null)
  const volts = useNtValue<number>(mechanismName ? yamsTopics(mechanismName).data.outputVoltage : null)
  const amps = current === undefined ? undefined : Math.abs(current)

  return (
    <Panel
      title="Telemetry"
      className="short:h-full short:[&>div]:min-h-0 short:[&>div]:flex-1 short:[&>div]:gap-2 short:[&>div]:p-2.5 short:[&>header]:hidden"
      locked={status !== "connected" || !mechanismName ? "Live position, setpoint and current appear here." : null}
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 short:grid-cols-4 short:gap-1.5">
        <Readout label="Position" value={kind === "flywheel" ? "-" : formatPosition(position, axis)} />
        <Readout label={`Velocity (${velocityUnit(axis)})`} value={formatNumber(velocity, axis === "linear" ? 3 : 0)} />
        <Readout
          label="Stator (A)"
          value={formatNumber(amps, 1)}
          tone={amps !== undefined && amps > stallCurrent ? "danger" : amps !== undefined && amps > stallCurrent * 0.7 ? "warn" : undefined}
        />
        <Readout label="Output (V)" value={formatNumber(typeof volts === "number" ? volts : undefined, 2)} />
      </div>
      <Chart />
      <p className="font-mono text-xs text-muted-foreground short:hidden">
        {`Motor temp ${typeof temp === "number" ? `${temp.toFixed(0)} °C` : "-"}`}
      </p>
    </Panel>
  )
}

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function Chart() {
  const { nt, mechanismName, axis, kind, verified, stallCurrent } = useTuner()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const config = useRef({ nt, mechanismName, axis, kind, verified, stallCurrent })
  config.current = { nt, mechanismName, axis, kind, verified, stallCurrent }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    const samples: { t: number; measured?: number; setpoint?: number; current?: number }[] = []
    const colors = { fg: cssVar("--foreground"), muted: cssVar("--muted-foreground"), grid: cssVar("--border"), sp: cssVar("--destructive"), hz: cssVar("--hazard") }
    let raf = 0
    let lastSample = 0

    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      canvas.width = canvas.clientWidth * dpr
      canvas.height = canvas.clientHeight * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw)
      const { nt, mechanismName, axis, kind, verified, stallCurrent } = config.current
      if (mechanismName && now - lastSample >= 20) {
        lastSample = now
        const reader = axisReader(nt, mechanismName, axis)
        const t = yamsTopics(mechanismName)
        const flywheel = kind === "flywheel"
        const sp = nt.getNumber(flywheel ? t.tuning.setpointVelocity : t.tuning.setpointPosition)
        samples.push({
          t: now,
          measured: flywheel ? reader.velocity() : reader.position(),
          setpoint: sp === undefined ? undefined : flywheel && Math.abs(sp) < 0.01 ? 0 : sp,
          current: (() => {
            const a = nt.getNumber(t.data.statorCurrent)
            return a === undefined ? undefined : Math.abs(a)
          })(),
        })
      }
      while (samples.length && now - samples[0].t > WINDOW_MS) samples.shift()

      const w = canvas.clientWidth
      const h = canvas.clientHeight
      ctx.clearRect(0, 0, w, h)
      const left = 48
      const right = 40
      const plotW = w - left - right
      const plotH = h - 16

      const bounds: number[] = []
      for (const s of samples) {
        if (s.measured !== undefined) bounds.push(s.measured)
        if (s.setpoint !== undefined) bounds.push(s.setpoint)
      }
      const showRange = kind !== "flywheel" && verified.lower !== null && verified.upper !== null
      if (showRange) bounds.push(verified.lower as number, verified.upper as number)
      if (bounds.length === 0) return
      let lo = Math.min(...bounds)
      let hi = Math.max(...bounds)
      const pad = Math.max((hi - lo) * 0.1, axis === "linear" ? 0.01 : 1)
      lo -= pad
      hi += pad
      const y = (v: number) => 8 + (1 - (v - lo) / (hi - lo)) * plotH
      const x = (t: number) => left + (1 - (now - t) / WINDOW_MS) * plotW

      ctx.font = "11px 'IBM Plex Mono', monospace"
      ctx.fillStyle = colors.muted
      ctx.strokeStyle = colors.grid
      ctx.lineWidth = 1
      for (let i = 0; i <= 4; i++) {
        const v = lo + ((hi - lo) * i) / 4
        const yy = y(v)
        ctx.beginPath()
        ctx.moveTo(left, yy)
        ctx.lineTo(w - right, yy)
        ctx.stroke()
        ctx.fillText(v.toFixed(axis === "linear" || Math.abs(hi - lo) < 5 ? 2 : 0), 4, yy + 4)
      }

      // Stator current bars share the plot area but use their own 0-based amp scale on the right axis.
      let peakAmps = 0
      for (const s of samples) if (s.current !== undefined && s.current > peakAmps) peakAmps = s.current
      const ampMax = Math.max(stallCurrent * 1.15, peakAmps * 1.1, 1)
      const yAmps = (a: number) => 8 + (1 - a / ampMax) * plotH
      const barW = Math.max(1, (plotW * 20) / WINDOW_MS)
      ctx.save()
      ctx.beginPath()
      ctx.rect(left, 8, plotW, plotH)
      ctx.clip()
      ctx.globalAlpha = 0.28
      for (const s of samples) {
        if (s.current === undefined || s.current <= 0) continue
        ctx.fillStyle = s.current > stallCurrent ? colors.sp : colors.hz
        const top = yAmps(s.current)
        ctx.fillRect(x(s.t) - barW, top, barW, 8 + plotH - top)
      }
      ctx.globalAlpha = 0.6
      ctx.setLineDash([2, 3])
      ctx.strokeStyle = colors.sp
      ctx.beginPath()
      ctx.moveTo(left, yAmps(stallCurrent))
      ctx.lineTo(w - right, yAmps(stallCurrent))
      ctx.stroke()
      ctx.restore()
      ctx.fillStyle = colors.hz
      ctx.textAlign = "right"
      for (let i = 0; i <= 4; i++) {
        const a = (ampMax * i) / 4
        ctx.fillText(`${a.toFixed(0)}A`, w - 4, yAmps(a) + 4)
      }
      ctx.textAlign = "left"

      if (showRange) {
        ctx.save()
        ctx.setLineDash([4, 4])
        ctx.strokeStyle = colors.fg
        for (const v of [verified.lower as number, verified.upper as number]) {
          ctx.beginPath()
          ctx.moveTo(left, y(v))
          ctx.lineTo(w - right, y(v))
          ctx.stroke()
        }
        ctx.restore()
      }
      const line = (key: "measured" | "setpoint", color: string, width: number) => {
        ctx.strokeStyle = color
        ctx.lineWidth = width
        ctx.beginPath()
        let started = false
        for (const s of samples) {
          const v = s[key]
          if (v === undefined) {
            started = false
            continue
          }
          if (!started) ctx.moveTo(x(s.t), y(v))
          else ctx.lineTo(x(s.t), y(v))
          started = true
        }
        ctx.stroke()
      }
      line("setpoint", colors.sp, 1.5)
      line("measured", colors.fg, 2)
    }
    raf = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [])

  return (
    <figure className="flex flex-col gap-2 short:min-h-0 short:flex-1 short:gap-1">
      <canvas
        ref={canvasRef}
        className="h-56 w-full rounded-md border border-border bg-background short:h-0 short:min-h-16 short:flex-1"
        role="img"
        aria-label="Measured value, setpoint and stator current over the last 10 seconds"
      />
      <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground short:gap-x-2.5 short:text-[10px]">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-0.5 w-4 bg-foreground" />
          Measured
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-0.5 w-4 bg-destructive" />
          Setpoint
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-2.5 w-4 bg-hazard/40" />
          Stator current (right axis)
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="w-4 border-t border-dotted border-destructive" />
          Current limit
        </span>
        {kind !== "flywheel" && verified.lower !== null && verified.upper !== null && (
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="w-4 border-t border-dashed border-foreground" />
            Verified range
          </span>
        )}
        <span className="ml-auto font-mono">10 s</span>
      </figcaption>
    </figure>
  )
}
