"use client"

import { useEffect, useRef, useState } from "react"
import { useAxisValues, useNtValue, useTuner } from "@/components/tuner/tuner-context"
import { Panel, Readout } from "@/components/tuner/panel"
import { WheelPicker } from "@/components/tuner/wheel-picker"
import { axisReader, formatNumber, formatPosition, velocityUnit, wheelLabels, yamsTopics } from "@/lib/yams/topics"
import { EMPTY, NBSP, num } from "@/lib/format"

const WINDOW_MS = 10_000

export function TelemetryPanel() {
  // The readouts are a double flywheel's chosen wheel's; the chart shows every wheel.
  const { wheel: name, axis, kind, stallCurrent, status } = useTuner()
  const { position, velocity, current } = useAxisValues()
  const temp = useNtValue<number>(name ? yamsTopics(name).data.temperature : null)
  const volts = useNtValue<number>(name ? yamsTopics(name).data.outputVoltage : null)
  const amps = current === undefined ? undefined : Math.abs(current)

  return (
    <Panel
      title="Telemetry"
      className="short:h-full short:[&>div]:min-h-0 short:[&>div]:flex-1 short:[&>div]:gap-2 short:[&>div]:p-2.5 short:[&>header]:hidden"
      locked={status !== "connected" || !name ? "Live position, setpoint and current appear here." : null}
    >
      <div className="short:hidden">
        <WheelPicker />
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 short:grid-cols-4 short:gap-1.5">
        <Readout label="Position" value={kind === "flywheel" ? EMPTY : formatPosition(position, axis)} />
        <Readout label={`Velocity (${velocityUnit(axis)})`} value={formatNumber(velocity, axis === "linear" ? 3 : 0)} />
        <Readout
          label="Stator (A)"
          value={formatNumber(amps, 1)}
          tone={amps !== undefined && amps > stallCurrent ? "danger" : amps !== undefined && amps > stallCurrent * 0.7 ? "warn" : undefined}
        />
        <Readout label="Output (V)" value={formatNumber(typeof volts === "number" ? volts : undefined, 2)} />
      </div>
      <Chart />
      <MotorTemp celsius={temp} />
    </Panel>
  )
}

const FAHRENHEIT_KEY = "yams-tuner.fahrenheit"

/** The motor temperature, which YAMS publishes in °C. Clicking it switches to °F and back, remembered in this browser. */
function MotorTemp({ celsius }: { celsius: number | undefined }) {
  const [fahrenheit, setFahrenheit] = useState(false)
  useEffect(() => {
    try {
      setFahrenheit(window.localStorage.getItem(FAHRENHEIT_KEY) === "true")
    } catch {
      // Storage can be unavailable; °C then.
    }
  }, [])
  const toggle = () => {
    const next = !fahrenheit
    setFahrenheit(next)
    try {
      window.localStorage.setItem(FAHRENHEIT_KEY, String(next))
    } catch {
      // Not remembered, but still switched.
    }
  }
  const value =
    typeof celsius !== "number"
      ? EMPTY
      : fahrenheit
        ? `${num((celsius * 9) / 5 + 32, 0)}${NBSP}°F`
        : `${num(celsius, 0)}${NBSP}°C`
  return (
    <p className="font-mono text-xs text-muted-foreground short:hidden">
      {"Motor temp "}
      <button
        type="button"
        onClick={toggle}
        title={fahrenheit ? "Show in Celsius" : "Show in Fahrenheit"}
        aria-label={`Motor temp ${value}. Switch to ${fahrenheit ? "Celsius" : "Fahrenheit"}`}
        className="rounded-sm underline decoration-dotted underline-offset-2 transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        {value}
      </button>
    </p>
  )
}

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function Chart() {
  const { nt, wheels, axis, kind, verified, stallCurrent } = useTuner()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const config = useRef({ nt, wheels, axis, kind, verified, stallCurrent })
  config.current = { nt, wheels, axis, kind, verified, stallCurrent }
  const labels = wheelLabels(wheels)
  const double = wheels.length > 1

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    // One measured value and setpoint per wheel: a double flywheel has two.
    const samples: { t: number; measured: (number | undefined)[]; setpoint: (number | undefined)[]; current?: number }[] = []
    // Read again when the theme changes, so the chart follows it.
    const readColors = () => ({
      fg: cssVar("--foreground"),
      muted: cssVar("--muted-foreground"),
      grid: cssVar("--border"),
      sp: cssVar("--setpoint"),
      limit: cssVar("--destructive"),
      hz: cssVar("--hazard"),
      hzText: cssVar("--hazard-text"),
      font: `12px ${cssVar("--font-jetbrains-mono") || "ui-monospace"}, monospace`,
    })
    let colors = readColors()
    const themeObserver = new MutationObserver(() => (colors = readColors()))
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
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
      const { nt, wheels, axis, kind, verified, stallCurrent } = config.current
      if (wheels.length > 0 && now - lastSample >= 20) {
        lastSample = now
        const flywheel = kind === "flywheel"
        const measured: (number | undefined)[] = []
        const setpoint: (number | undefined)[] = []
        // The current bars show the wheel drawing the most: each motor trips on its own.
        let current: number | undefined
        for (const w of wheels) {
          const reader = axisReader(nt, w, axis)
          const t = yamsTopics(w)
          const sp = nt.getNumber(flywheel ? t.tuning.setpointVelocity : t.tuning.setpointPosition)
          measured.push(flywheel ? reader.velocity() : reader.position())
          setpoint.push(sp === undefined ? undefined : flywheel && Math.abs(sp) < 0.01 ? 0 : sp)
          const a = nt.getNumber(t.data.statorCurrent)
          if (a !== undefined) current = Math.max(current ?? 0, Math.abs(a))
        }
        samples.push({ t: now, measured, setpoint, current })
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
        for (const v of s.measured) if (v !== undefined) bounds.push(v)
        for (const v of s.setpoint) if (v !== undefined) bounds.push(v)
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

      ctx.font = colors.font
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
        ctx.fillText(num(v, axis === "linear" || Math.abs(hi - lo) < 5 ? 2 : 0), 4, yy + 4)
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
        ctx.fillStyle = s.current > stallCurrent ? colors.limit : colors.hz
        const top = yAmps(s.current)
        ctx.fillRect(x(s.t) - barW, top, barW, 8 + plotH - top)
      }
      ctx.globalAlpha = 0.6
      ctx.setLineDash([2, 3])
      ctx.strokeStyle = colors.limit
      ctx.beginPath()
      ctx.moveTo(left, yAmps(stallCurrent))
      ctx.lineTo(w - right, yAmps(stallCurrent))
      ctx.stroke()
      ctx.restore()
      ctx.fillStyle = colors.hzText
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
      // A second wheel's lines are dashed, so the wheels never differ by colour alone.
      const line = (key: "measured" | "setpoint", index: number, color: string, width: number) => {
        ctx.strokeStyle = color
        ctx.lineWidth = width
        ctx.setLineDash(index === 0 ? [] : [6, 4])
        ctx.beginPath()
        let started = false
        for (const s of samples) {
          const v = s[key][index]
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
      for (let i = 0; i < wheels.length; i++) line("setpoint", i, colors.sp, 1.5)
      for (let i = 0; i < wheels.length; i++) line("measured", i, colors.fg, 2)
      ctx.setLineDash([])
    }
    raf = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      themeObserver.disconnect()
    }
  }, [])

  return (
    <figure className="flex flex-col gap-2 short:min-h-0 short:flex-1 short:gap-1">
      <canvas
        ref={canvasRef}
        className="h-56 w-full rounded-md border border-border bg-background short:h-0 short:min-h-16 short:flex-1"
        role="img"
        aria-label={
          double
            ? `Each wheel’s measured speed and setpoint, ${wheels.map((w, i) => `${labels[w]} ${i === 0 ? "solid" : "dashed"}`).join(", ")}, and the higher stator current, over the last 10 seconds`
            : "Measured value, setpoint and stator current over the last 10 seconds"
        }
      />
      <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground short:gap-x-2.5">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-0.5 w-4 bg-foreground" />
          Measured
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-0.5 w-4 bg-setpoint" />
          Setpoint
        </span>
        {double &&
          wheels.map((w, i) => (
            <span key={w} className="flex items-center gap-1.5">
              <span aria-hidden className={i === 0 ? "w-4 border-t-2 border-foreground" : "w-4 border-t-2 border-dashed border-foreground"} />
              {labels[w]}
            </span>
          ))}
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-2.5 w-4 bg-hazard/40" />
          {double ? "Higher stator current (right axis)" : "Stator current (right axis)"}
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="w-4 border-t border-dotted border-destructive" />
          Current trip
        </span>
        {kind !== "flywheel" && verified.lower !== null && verified.upper !== null && (
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="w-4 border-t border-dashed border-foreground" />
            Verified range
          </span>
        )}
        <span className="ms-auto font-mono">10{"\u00a0"}s</span>
      </figcaption>
    </figure>
  )
}
