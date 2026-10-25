"use client"

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from "react"
import { ChevronLeft, ChevronRight, Play } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { useAxisValues, useNtValue, useTuner } from "@/components/tuner/tuner-context"
import { Kbd, LiveRegion, Notice, Segmented } from "@/components/tuner/panel"
import { TravelGauge } from "@/components/tuner/travel-gauge"
import { EditableBound } from "@/components/tuner/setpoint-panel"
import { axisReader, formatPosition, yamsTopics } from "@/lib/yams/topics"
import { formatVolts } from "@/lib/format"
import { jogParams } from "@/lib/yams/safety"
import { SignToggle, flipSign, useSignToggleShown } from "@/components/tuner/sign-toggle"
import { nextText, parseFormatted, type NumberFormat } from "@/lib/number-format"

type Dir = -1 | 1
/** What letting go of a drive button does: cut the voltage to 0 at once, or ramp it down to 0. */
type Release = "cut" | "ramp"

/** Battery voltage: nothing above this can be applied anyway. */
const HARD_LIMIT_VOLTS = 12
const LOOP_MS = 20
/** A held drive button ramps from 0 to its voltage over this long, so a press never slams the mechanism. */
const BUTTON_RAMP_MS = 400
/** The gravity hold voltage stays within this, in volts: it only has to balance the mechanism's weight. */
const MAX_GRAVITY_VOLTS = 3
const GRAVITY_STEP_VOLTS = 0.02

export interface VoltageSettings {
  /** The voltage slider's ends, in volts: at most 0 and at least 0. The drive buttons drive at these. */
  minVolts: number
  maxVolts: number
  /** Letting go of the voltage slider goes back to 0 V. Off, the voltage holds until changed. */
  springBack: boolean
  release: Release
  /** Volts per second, when the release ramps down. */
  rampDownRate: number
  /** An elevator's or arm's gravity hold voltage, added to every drive and sent between presses (kG for an arm). */
  gravityVolts: number
  /**
   * During Live Tuning, stay in voltage mode between presses (at the gravity hold voltage, or 0 V) until the Live tune
   * card goes back to Setpoints or this is turned off. Off, letting go hands back to the closed loop at once.
   */
  stayInVoltage: boolean
}

const DEFAULT_SETTINGS: VoltageSettings = {
  minVolts: -2,
  maxVolts: 2,
  springBack: true,
  release: "cut",
  rampDownRate: 4,
  gravityVolts: 0,
  stayInVoltage: true,
}

export type LiveTab = "setpoints" | "voltage"

interface LiveTuneApi {
  /** The Live tune card's tab. On Voltage, the Settings card gets a Voltage tab with these settings. */
  tab: LiveTab
  setTab: (tab: LiveTab) => void
  settings: VoltageSettings
  update: (next: Partial<VoltageSettings>) => void
}

const LiveTuneContext = createContext<LiveTuneApi | null>(null)

/** Shared by the Live tune and Settings cards. Starts over for each mechanism. */
export function LiveTuneProvider({ children }: { children: ReactNode }) {
  const [tab, setTab] = useState<LiveTab>("setpoints")
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const update = useCallback((next: Partial<VoltageSettings>) => setSettings((s) => ({ ...s, ...next })), [])
  return <LiveTuneContext.Provider value={{ tab, setTab, settings, update }}>{children}</LiveTuneContext.Provider>
}

export function useLiveTune(): LiveTuneApi {
  const api = useContext(LiveTuneContext)
  if (!api) throw new Error("useLiveTune must be used inside LiveTuneProvider")
  return api
}


/** The voltage that holds an elevator up, or an arm at an angle (0° is level), when a gravity hold voltage is set. */
function holdVolts(kind: string, gravity: number, pos: number | undefined) {
  if (gravity === 0 || pos === undefined || (kind !== "elevator" && kind !== "arm")) return 0
  const v = kind === "arm" ? gravity * Math.cos((pos * Math.PI) / 180) : gravity
  return Math.round(v * 1000) / 1000
}

/**
 * The Live tune card's Voltage tab. Drives the mechanism with voltage while a button is held or the slider is dragged
 * (its ends are the buttons' voltages and can be changed), like finding the range of
 * motion but with nothing to mark. It stops at the ends of the verified range (or the soft limits). During Live Tuning,
 * letting go hands back to the closed loop, which holds where it stopped. Otherwise the motor gets 0 V (or the gravity
 * hold voltage) between presses. The settings are in the Settings card's Voltage tab.
 */
export function VoltageDrive() {
  // A double flywheel drives the wheel chosen with the wheel picker.
  const { nt, wheel: name, axis, kind, session, starting, startLiveTuning, stop, verified, positional, tuningUnlocked } =
    useTuner()
  const { settings, update } = useLiveTune()
  const { position, lower: softLower, upper: softUpper } = useAxisValues()
  const topics = name ? yamsTopics(name) : null
  // Subscribing re-renders when the topic is announced by a YAMS version that supports it.
  useNtValue<boolean>(topics?.tuning.voltageEnabled ?? null)
  const supported = !!topics && nt.isAnnounced(topics.tuning.voltageEnabled) && nt.isAnnounced(topics.tuning.voltageSetpoint)

  const [driving, setDriving] = useState<Dir | null>(null)
  /** The voltage slider's position. It goes back to 0 whenever a drive ends. */
  const [sliderVolts, setSliderVolts] = useState(0)
  const [rampingDown, setRampingDown] = useState(false)
  /** During Live Tuning: staying in voltage control between presses, with the closed loop off. */
  const [held, setHeld] = useState(false)
  const [applied, setApplied] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const flywheel = kind === "flywheel"
  const [negLabel, posLabel] = kind === "elevator" ? ["down", "up"] : ["reverse", "forward"]
  const active = session === "tune" || session === "jog"
  const verifiedBounded = verified.lower !== null && verified.upper !== null
  // The verified range bounds travel; with none (skipped, or a continuous pivot) the robot's soft limits do.
  const bounds: [number, number] | null = !positional
    ? null
    : verifiedBounded
      ? [verified.lower as number, verified.upper as number]
      : softLower !== undefined && softUpper !== undefined
        ? [softLower, softUpper]
        : null
  const boundLabel = verifiedBounded ? "verified range" : "soft limits"

  const timer = useRef<number | null>(null)
  const sessionRef = useRef(session)
  sessionRef.current = session
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  /** The voltage last sent, which a ramp down starts from. */
  const sentVolts = useRef(0)
  /** The voltage asked for right now, signed: a held button's end of the slider, or the slider itself. 0 just holds. */
  const command = useRef(0)
  const rampingDownRef = useRef(false)
  rampingDownRef.current = rampingDown
  /** A flywheel's velocity setpoint before the drive, restored when Live Tuning takes back over. */
  const heldVelocity = useRef<number | null>(null)
  const holdAt = useCallback(
    (pos: number | undefined) => holdVolts(kind, settingsRef.current.gravityVolts, pos),
    [kind],
  )

  /** During Live Tuning: leaves voltage control and hands back to the closed loop where the mechanism is now. */
  const handBack = useCallback(() => {
    setHeld(false)
    if (!name) return
    const t = yamsTopics(name)
    // Seed the closed loop before releasing voltage, so it holds where the mechanism is instead of jumping back.
    if (flywheel) {
      if (heldVelocity.current !== null) nt.set(t.tuning.setpointVelocity, heldVelocity.current)
    } else {
      const pos = axisReader(nt, name, axis).position()
      if (pos !== undefined) nt.set(t.tuning.setpointPosition, pos)
    }
    nt.set(t.tuning.voltageSetpoint, 0)
    nt.set(t.tuning.voltageEnabled, false)
    heldVelocity.current = null
  }, [nt, name, axis, flywheel])

  const endDrive = useCallback(() => {
    if (timer.current !== null) {
      clearInterval(timer.current)
      timer.current = null
    }
    setDriving(null)
    setRampingDown(false)
    setApplied(0)
    setSliderVolts(0)
    sentVolts.current = 0
    command.current = 0
    if (!name) return
    const t = yamsTopics(name)
    const pos = axisReader(nt, name, axis).position()
    if (sessionRef.current === "tune" && !settingsRef.current.stayInVoltage) {
      handBack()
      return
    }
    if (sessionRef.current === "tune" || sessionRef.current === "jog") {
      // Stay in voltage mode at the gravity hold voltage, or 0 V: with voltage only, the closed loop may not be tuned
      // yet; during Live Tuning, until the card goes back to Setpoints.
      const hold = holdAt(pos)
      nt.set(t.tuning.voltageSetpoint, hold)
      nt.set(t.tuning.voltageEnabled, true)
      setApplied(hold)
      if (sessionRef.current === "tune") setHeld(true)
      return
    }
    heldVelocity.current = null
  }, [nt, name, axis, holdAt, handBack])

  useEffect(() => {
    if (!active && timer.current !== null) endDrive()
    if (!active) {
      heldVelocity.current = null
      setHeld(false)
    }
  }, [active, endDrive])
  // Leaving the Voltage tab (back to Setpoints) hands back to the closed loop.
  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearInterval(timer.current)
        timer.current = null
      }
      if (sessionRef.current === "tune") handBack()
    },
    [handBack],
  )
  // Turning off staying in voltage mode hands back at once.
  useEffect(() => {
    if (!settings.stayInVoltage && held && timer.current === null && sessionRef.current === "tune") handBack()
  }, [settings.stayInVoltage, held, handBack])

  // Between presses in voltage mode, keep sending the gravity hold voltage: an arm's changes with its angle.
  useEffect(() => {
    const between = session === "jog" || (session === "tune" && held)
    if (!between || settings.gravityVolts === 0 || !name) return
    const reader = axisReader(nt, name, axis)
    const t = yamsTopics(name)
    let last: number | null = null
    const id = window.setInterval(() => {
      if (timer.current !== null || (sessionRef.current !== "jog" && sessionRef.current !== "tune")) {
        last = null
        return
      }
      const v = holdAt(reader.position())
      if (v === last) return
      last = v
      nt.set(t.tuning.voltageSetpoint, v)
      nt.set(t.tuning.voltageEnabled, true)
    }, LOOP_MS)
    return () => clearInterval(id)
  }, [session, held, settings.gravityVolts, name, nt, axis, holdAt])

  const boundsRef = useRef(bounds)
  boundsRef.current = bounds

  const endOf = (d: Dir) => {
    const b = boundsRef.current
    return b ? (d > 0 ? b[1] : b[0]) : undefined
  }
  /** At, or past, the end of the range in that direction, so no voltage should push that way. Never for a flywheel. */
  const atEnd = (d: Dir, pos: number | undefined) => {
    const end = endOf(d)
    return !flywheel && end !== undefined && pos !== undefined && (end - pos) * d <= jogParams(axis).reachTolerance
  }

  /**
   * Drives with a voltage, signed: from a held button (which ramps up) or from the slider (which doesn't, since it is
   * moved by hand). While a drive runs, a new voltage just replaces the old one. It stops at the ends of the range.
   */
  const startDrive = (volts: number, fromButton: boolean) => {
    if (!active || !name || !supported || volts === 0) return
    const reader = axisReader(nt, name, axis)
    const t = yamsTopics(name)
    const dir: Dir = volts > 0 ? 1 : -1
    const startPos = reader.position()
    setNote(null)
    setError(null)
    if (!flywheel && startPos === undefined) {
      setError("No position telemetry. Set the telemetry verbosity to HIGH on the robot.")
      return
    }
    if (atEnd(dir, startPos)) {
      const end = endOf(dir) as number
      command.current = 0
      setSliderVolts(0)
      setNote(`Already at the ${dir > 0 ? "upper" : "lower"} end of the ${boundLabel} (${formatPosition(end, axis)}).`)
      return
    }
    command.current = volts
    if (fromButton) setDriving(dir)
    if (timer.current !== null && !rampingDownRef.current) return
    if (timer.current !== null) clearInterval(timer.current)
    setRampingDown(false)
    // Kept from the first press, so handing back after several goes back to the setpoint from before them.
    if (heldVelocity.current === null && flywheel) heldVelocity.current = nt.getNumber(t.tuning.setpointVelocity) ?? null
    nt.set(t.tuning.voltageSetpoint, holdAt(startPos))
    nt.set(t.tuning.voltageEnabled, true)

    const rampFrom = fromButton ? performance.now() : null
    let sent = 0
    timer.current = window.setInterval(() => {
      if (sessionRef.current !== "tune" && sessionRef.current !== "jog") {
        endDrive()
        return
      }
      const pos = reader.position()
      if (!flywheel && pos === undefined) {
        endDrive()
        return
      }
      const target = command.current
      const d = Math.sign(target) as Dir | 0
      if (d !== 0 && atEnd(d, pos)) {
        const end = endOf(d) as number
        endDrive()
        setNote(`Stopped at the ${d > 0 ? "upper" : "lower"} end of the ${boundLabel} (${formatPosition(end, axis)}).`)
        return
      }
      const ramp = rampFrom === null ? 1 : Math.min(1, (performance.now() - rampFrom) / BUTTON_RAMP_MS)
      // On top of the gravity hold voltage, so driving up and down feel the same.
      const out = Math.round((holdAt(pos) + target * ramp) * 1000) / 1000
      if (out !== sent) {
        sent = out
        sentVolts.current = out
        nt.set(t.tuning.voltageSetpoint, out)
        setApplied(out)
      }
    }, LOOP_MS)
  }
  const beginDrive = (dir: Dir) => startDrive(dir > 0 ? settingsRef.current.maxVolts : settingsRef.current.minVolts, true)

  /** The slider: a new position drives at that voltage, 0 just holds. */
  const slide = (v: number) => {
    setSliderVolts(v)
    if (!active || !supported) return
    if (v === 0) {
      // Back at 0 with no button held: the same as letting go.
      if (driving === null) releaseDrive()
      else command.current = 0
      return
    }
    startDrive(v, false)
  }

  /** Letting go: cut at once, or ramp down to the hold voltage first. Reaching an end always cuts at once. */
  const releaseDrive = () => {
    if (timer.current === null || rampingDown) return
    const { release, rampDownRate } = settingsRef.current
    if (release === "cut" || !name) {
      endDrive()
      return
    }
    clearInterval(timer.current)
    const reader = axisReader(nt, name, axis)
    const t = yamsTopics(name)
    const params = jogParams(axis)
    const dir = (Math.sign(command.current) || null) as Dir | null
    let out = sentVolts.current
    command.current = 0
    setSliderVolts(0)
    setDriving(null)
    setRampingDown(true)
    timer.current = window.setInterval(() => {
      if (sessionRef.current !== "tune" && sessionRef.current !== "jog") {
        endDrive()
        return
      }
      const pos = reader.position()
      const end = dir === null ? undefined : boundsRef.current?.[dir > 0 ? 1 : 0]
      if (!flywheel && dir !== null && end !== undefined && pos !== undefined && (end - pos) * dir <= params.reachTolerance) {
        endDrive()
        return
      }
      const goal = holdAt(pos)
      const step = (rampDownRate * LOOP_MS) / 1000
      out = Math.abs(out - goal) <= step ? goal : out - Math.sign(out - goal) * step
      if (out === goal) {
        endDrive()
        return
      }
      const v = Math.round(out * 1e6) / 1e6
      sentVolts.current = v
      nt.set(t.tuning.voltageSetpoint, v)
      setApplied(v)
    }, LOOP_MS)
  }

  const holdProps = (dir: Dir) => ({
    disabled: !active || !supported || (dir > 0 ? settings.maxVolts <= 0 : settings.minVolts >= 0),
    onPointerDown: (e: React.PointerEvent) => {
      e.currentTarget.setPointerCapture(e.pointerId)
      beginDrive(dir)
    },
    onPointerUp: () => releaseDrive(),
    onPointerCancel: () => releaseDrive(),
    onLostPointerCapture: () => releaseDrive(),
    // From the keyboard, holding Enter drives and letting go stops. Space stays the stop key.
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.repeat) {
        e.preventDefault()
        beginDrive(dir)
      }
    },
    onKeyUp: (e: React.KeyboardEvent) => {
      if (e.key === "Enter") releaseDrive()
    },
    onBlur: () => {
      if (driving === dir) releaseDrive()
    },
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  })
  const holdClass =
    "flex min-h-14 touch-none select-none items-center justify-center gap-2 rounded-md border border-border bg-background px-3 text-center font-medium enabled:hover:border-foreground disabled:opacity-50 data-[active=true]:border-foreground data-[active=true]:bg-hazard data-[active=true]:text-hazard-foreground"

  return (
    <>
      <p className="text-sm leading-relaxed text-muted-foreground">
        {bounds
          ? `Hold a button, or drag the slider, to move the mechanism with voltage. It stops at the ends of the ${boundLabel}.`
          : "Hold a button, or drag the slider, to move the mechanism with voltage."}
      </p>
      {!supported && <Notice tone="warn">This YAMS version can’t drive with voltage. Update YAMS on the robot.</Notice>}
      {positional && (
        <TravelGauge
          axis={axis}
          position={position}
          softLower={softLower}
          softUpper={softUpper}
          verifiedLower={verified.lower}
          verifiedUpper={verified.upper}
        />
      )}
      <div className="grid grid-cols-2 gap-2">
        <button type="button" {...holdProps(-1)} className={holdClass} data-active={driving === -1}>
          <ChevronLeft className="size-5" strokeWidth={2} absoluteStrokeWidth aria-hidden />
          {`Hold: drive ${negLabel} (${formatVolts(settings.minVolts)})`}
        </button>
        <button type="button" {...holdProps(1)} className={holdClass} data-active={driving === 1}>
          {`Hold: drive ${posLabel} (+${formatVolts(settings.maxVolts)})`}
          <ChevronRight className="size-5" strokeWidth={2} absoluteStrokeWidth aria-hidden />
        </button>
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex justify-between gap-2 text-xs uppercase tracking-wider text-muted-foreground">
          <span>Voltage</span>
          <span className="font-mono normal-case tabular text-foreground" aria-live="off">
            {rampingDown ? `Ramping down ${formatVolts(applied)}` : `Applied ${formatVolts(applied)}`}
          </span>
        </div>
        {/* Drag for any voltage in between. It stops at the ends of the range like the buttons do. */}
        <Slider
          aria-label="Voltage"
          min={settings.minVolts}
          max={settings.maxVolts}
          step={0.05}
          disabled={!active || !supported}
          value={Math.min(settings.maxVolts, Math.max(settings.minVolts, sliderVolts))}
          onValueChange={(raw) => slide(Math.round((Array.isArray(raw) ? raw[0] : raw) * 100) / 100)}
          onValueCommitted={() => {
            if (settingsRef.current.springBack) {
              command.current = 0
              releaseDrive()
            }
          }}
        />
        <div className="flex items-center justify-between gap-2 font-mono text-xs text-muted-foreground tabular">
          <EditableBound
            label="Minimum voltage"
            value={settings.minVolts}
            digits={2}
            step={0.1}
            format={formatVolts}
            onSubmit={(v) => {
              const next = Math.max(-HARD_LIMIT_VOLTS, Math.min(0, v))
              if (next >= settings.maxVolts) return `Minimum must be below ${formatVolts(settings.maxVolts)}.`
              update({ minVolts: next })
              return next !== v ? `Limited to ${formatVolts(next)}.` : null
            }}
          />
          <label htmlFor="voltage-spring-back" className="flex items-center gap-2 font-sans">
            <Switch
              id="voltage-spring-back"
              size="sm"
              checked={settings.springBack}
              onCheckedChange={(v) => update({ springBack: v === true })}
            />
            Back to 0{"\u00a0"}V on release
          </label>
          <EditableBound
            label="Maximum voltage"
            value={settings.maxVolts}
            digits={2}
            step={0.1}
            format={formatVolts}
            align="end"
            onSubmit={(v) => {
              const next = Math.min(HARD_LIMIT_VOLTS, Math.max(0, v))
              if (next <= settings.minVolts) return `Maximum must be above ${formatVolts(settings.minVolts)}.`
              update({ maxVolts: next })
              return next !== v ? `Limited to ${formatVolts(next)}.` : null
            }}
          />
        </div>
      </div>
      {!active && (
        <div className="flex flex-col gap-2">
          <Button
            variant="outline"
            className="self-start"
            disabled={!tuningUnlocked || starting || session !== null}
            onClick={async () => setError(await startLiveTuning("jog"))}
          >
            <Play data-icon="inline-start" />
            Start voltage control
          </Button>
          <p className="text-sm text-muted-foreground">Or start Live Tuning on the Setpoints tab, then drive here.</p>
        </div>
      )}
      {session === "jog" && (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => stop("Voltage control stopped")}>
            Stop voltage control
          </Button>
          <p className="text-sm text-muted-foreground">
            {flywheel
              ? "Between presses the motor gets 0 V and the flywheel coasts."
              : settings.gravityVolts !== 0
                ? "Between presses the motor gets the gravity hold voltage."
                : "Between presses the motor gets 0 V, so gravity can move it. Set a gravity hold voltage, or start Live Tuning to hold it with the closed loop."}
          </p>
        </div>
      )}
      {(session === "tune" || !active) && (
        <div className="flex items-start gap-3 rounded-md border border-border p-3">
          <Switch
            id="stay-in-voltage"
            checked={settings.stayInVoltage}
            onCheckedChange={(v) => update({ stayInVoltage: v === true })}
            aria-describedby="stay-in-voltage-hint"
            className="mt-0.5"
          />
          <div className="flex flex-col gap-0.5 text-sm">
            <label htmlFor="stay-in-voltage" className="font-medium">
              Stay in voltage control
            </label>
            <span id="stay-in-voltage-hint" className="text-muted-foreground">
              {settings.stayInVoltage
                ? `During Live Tuning, letting go keeps voltage control at ${
                    settings.gravityVolts !== 0 && !flywheel ? "the gravity hold voltage" : "0 V"
                  }. Going back to Setpoints, or turning this off, hands back to the closed loop${flywheel ? " at the setpoint it had" : ", which holds where the mechanism is"}.`
                : flywheel
                  ? "Letting go hands back to Live Tuning at the setpoint it had."
                  : "Letting go hands back to Live Tuning, which holds where it stopped."}
            </span>
          </div>
        </div>
      )}
      {session === "tune" && held && (
        <p className="font-mono text-xs uppercase tracking-wider text-hazard-text">In voltage control. The closed loop is off.</p>
      )}
      <LiveRegion>{note && <Notice live={false}>{note}</Notice>}</LiveRegion>
      <LiveRegion assertive>{error && <Notice tone="danger" live={false}>{error}</Notice>}</LiveRegion>
      <p className="text-xs text-muted-foreground">
        Hold <Kbd>Enter</Kbd> on a drive button to drive from the keyboard. Select either end of the slider to change it.
        What happens when you let go, and the gravity hold voltage, are in the Settings card’s Voltage tab. Space stops
        everything.
      </p>
    </>
  )
}

/** The Settings card's Voltage tab, shown while the Live tune card is on its Voltage tab: the drive's settings. */
export function VoltageSettingsPanel() {
  const { nt, mechanismName, kind } = useTuner()
  const { settings, update } = useLiveTune()
  const { maxVolts, release, rampDownRate, gravityVolts } = settings
  const gravityLoaded = kind === "elevator" || kind === "arm"
  const kGTopic = mechanismName ? `${yamsTopics(mechanismName).tuningPrefix}closedloop/feedforward/kG` : null
  const robotKG = useNtValue<number>(kGTopic)
  const gravityInput = useRef<HTMLInputElement>(null)
  // While its ± shows, − and + would read as the sign too, so they step aside.
  const gravitySignShown = useSignToggleShown(gravityInput)

  return (
    <>
      <Group label="When the voltage is let go">
        <Segmented
          label="When the voltage is let go"
          options={[["cut", "Cut to 0 V"], ["ramp", "Ramp to 0 V"]] as const}
          value={release}
          onChange={(v) => update({ release: v })}
        />
        {release === "ramp" && (
          <>
            <NumberField
              id="ramp-down"
              label="Ramp down rate"
              unit="V/s"
              value={rampDownRate}
              min={0.01}
              max={100}
              onCommit={(v) => update({ rampDownRate: v })}
            />
            <p className="text-xs leading-relaxed text-muted-foreground">
              {`From ${formatVolts(maxVolts)} that takes ${((maxVolts / rampDownRate) * 1000).toFixed(0)}\u00a0ms, and the mechanism keeps moving meanwhile. Reaching an end still cuts at once.`}
            </p>
          </>
        )}
      </Group>

      {gravityLoaded && (
        <Group label="Gravity hold voltage">
          <div className="flex flex-wrap items-center gap-2">
            {!gravitySignShown && (
              <Button
                variant="outline"
                size="sm"
                aria-label="Lower the gravity hold voltage"
                onClick={() => update({ gravityVolts: clampGravity(gravityVolts - GRAVITY_STEP_VOLTS) })}
              >
                −
              </Button>
            )}
            <NumberField
              id="gravity-volts"
              inputRef={gravityInput}
              label="Gravity hold voltage"
              hideLabel
              unit="V"
              value={gravityVolts}
              min={-MAX_GRAVITY_VOLTS}
              max={MAX_GRAVITY_VOLTS}
              onCommit={(v) => update({ gravityVolts: clampGravity(v) })}
            />
            {!gravitySignShown && (
              <Button
                variant="outline"
                size="sm"
                aria-label="Raise the gravity hold voltage"
                onClick={() => update({ gravityVolts: clampGravity(gravityVolts + GRAVITY_STEP_VOLTS) })}
              >
                +
              </Button>
            )}
            {typeof robotKG === "number" && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={gravityVolts === clampGravity(robotKG)}
                  onClick={() => update({ gravityVolts: clampGravity(robotKG) })}
                >
                  {`Use robot kG (${formatVolts(robotKG)})`}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!kGTopic || gravityVolts === clampGravity(robotKG)}
                  onClick={() => kGTopic && nt.set(kGTopic, gravityVolts)}
                >
                  Set kG to this
                </Button>
              </>
            )}
            <Button variant="outline" size="sm" disabled={gravityVolts === 0} onClick={() => update({ gravityVolts: 0 })}>
              Set to 0 V
            </Button>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {`${kind === "arm" ? "Holds the arm level, like kG, scaled by the cosine of the angle (0° is level)." : "Holds the elevator up, like kG."} Drives add to it, and with voltage only it is sent between presses. Starts at 0 V; up to ${MAX_GRAVITY_VOLTS} V.`}
          </p>
        </Group>
      )}
    </>
  )
}

const clampGravity = (v: number) => Math.max(-MAX_GRAVITY_VOLTS, Math.min(MAX_GRAVITY_VOLTS, Math.round(v * 1000) / 1000))

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</h3>
      {children}
    </div>
  )
}

/** A number that applies on Enter or when you click away, and goes back to the last value if it isn't valid. */
function NumberField({
  id,
  label,
  hideLabel,
  unit,
  value,
  min,
  max,
  onCommit,
  inputRef,
}: {
  id: string
  label: string
  hideLabel?: boolean
  unit: string
  value: number
  min: number
  max: number
  onCommit: (v: number) => void
  /** The field, for a caller that follows its focus. */
  inputRef?: RefObject<HTMLInputElement | null>
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const ownInput = useRef<HTMLInputElement>(null)
  const input = inputRef ?? ownInput
  const format: NumberFormat = { negative: min < 0 }
  const shown = draft ?? String(value)
  const commit = (text = draft) => {
    if (text === null) return
    const v = parseFormatted(text, format)
    if (v !== null) onCommit(Math.min(max, Math.max(min, v)))
    setDraft(null)
  }
  return (
    <div className="flex items-center gap-2 text-sm">
      {!hideLabel && (
        <label htmlFor={id} className="text-muted-foreground">
          {label}
        </label>
      )}
      {format.negative && (
        <SignToggle
          label={`the ${label.toLowerCase()}`}
          input={input}
          onFlip={(editing) => (editing ? setDraft(flipSign(shown)) : commit(flipSign(shown)))}
        />
      )}
      <Input
        ref={input}
        id={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        aria-label={hideLabel ? label : undefined}
        className="h-8 w-24 font-mono"
        value={shown}
        onChange={(e) => setDraft(nextText(shown, e.target.value, format))}
        onBlur={() => commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            commit()
          } else if (e.key === "Escape") {
            e.preventDefault()
            setDraft(null)
          }
        }}
      />
      <span className="text-muted-foreground">{unit}</span>
    </div>
  )
}
