// NetworkTables 4 connection built on FRC Web Components' NT4 client, adapted from the
// YAGSL config generator's Live mode so a hosted HTTPS page can reach a robot on the local network.

import type { Nt4Client as Nt4ClientLike } from "@frc-web-components/fwc/source-providers/nt4"
import type { DemoRobot } from "@/lib/demo/demo-robot"
import { DEMO_AVAILABLE, DEMO_HOST } from "@/lib/demo/host"

export type LiveTarget = { kind: "sim" } | { kind: "robot"; team: string } | { kind: "custom"; host: string } | { kind: "demo" }

export type ConnectionStatus = "idle" | "connecting" | "connected"

export type RobotMode = "unknown" | "autonomous" | "teleoperated" | "utility"

export interface RobotState {
  mode: RobotMode
  enabled: boolean
  eStop: boolean
  dsAttached: boolean
}

const APP_NAME = "YAMS_LiveTuner"
/** How far ahead of the newest server timestamp a write is stamped, in microseconds. */
const WRITE_LEAD_US = 100_000

export function teamAddress(team: string): string | null {
  const digits = team.trim()
  if (!/^\d{1,5}$/.test(digits)) return null
  const n = Number.parseInt(digits, 10)
  return `10.${Math.floor(n / 100)}.${n % 100}.2`
}

export function targetHost(target: LiveTarget): string | null {
  switch (target.kind) {
    case "sim":
      return "localhost"
    case "robot":
      return teamAddress(target.team)
    case "custom":
      return target.host.trim() || null
    case "demo":
      return DEMO_AVAILABLE ? DEMO_HOST : null
  }
}

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "")
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h)
}

/**
 * Decode the WPILib ControlWord struct at /DriverStation/ControlWord:
 * `uint64 opModeHash:56; uint64 robotMode:2; bool enabled:1; bool eStop:1; bool fmsAttached:1; bool dsAttached:1;`
 */
export function decodeControlWord(value: unknown): RobotState | null {
  // If parsing from a raw HAL buffer or NetworkTables int representation
  let flags = 0;

  if (value instanceof Uint8Array && value.length >= 1) {
    // If it's a binary byte stream buffer, extract the active byte
    flags = value[value.length - 1]; 
  } else if (typeof value === "number") {
    // If parsed directly from FMSControlData or RobotState numerical topic
    flags = value;
  } else {
    return null;
  }

  // 2026 Bitmask Breakdowns
  const enabled = (flags & 0x01) !== 0;
  const autonomous = (flags & 0x02) !== 0;
  const test = (flags & 0x04) !== 0;
  const eStop = (flags & 0x08) !== 0;
  const fmsAttached = (flags & 0x10) !== 0;
  const dsAttached = (flags & 0x20) !== 0;

  // Resolve mode string based on priority rules
  let currentMode: RobotMode;
  if (!enabled) {
    currentMode = "unknown";
  } else if (autonomous) {
    currentMode = "autonomous";
  } else if (test) {
    currentMode = "utility";
  } else {
    currentMode = "teleoperated";
  }

  return {
    mode: currentMode,
    enabled,
    eStop,
    dsAttached,
  };
}

/**
 * An HTTPS page may only open ws:// to the robot when the browser knows the target is on the local network.
 * Chrome needs `targetAddressSpace: "local"` for non-IP host names; older browsers reject the options argument.
 */
function installLocalNetworkWebSocket() {
  const w = window as unknown as { WebSocket: typeof WebSocket; __yamsLocalNetworkWebSocket?: boolean }
  if (w.__yamsLocalNetworkWebSocket) return
  const NativeWebSocket = w.WebSocket
  class LocalNetworkWebSocket extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      let host = ""
      try {
        host = new URL(String(url)).hostname
      } catch {
        // Let the native constructor report the bad URL.
      }
      if (host && !isLoopbackHost(host)) {
        try {
          const list = protocols === undefined ? [] : Array.isArray(protocols) ? protocols : [protocols]
          super(url, { protocols: list, targetAddressSpace: "local" } as unknown as string[])
          return
        } catch {
          // This browser does not take an options argument.
        }
      }
      super(url, protocols)
    }
  }
  w.WebSocket = LocalNetworkWebSocket
  w.__yamsLocalNetworkWebSocket = true
}

type Listener = () => void
export type SampleListener = (topic: string, timestampUs: number, value: unknown) => void

export class LiveNT {
  private client: Nt4ClientLike | null = null
  private values = new Map<string, unknown>()
  private types = new Map<string, string>()
  private properties = new Map<string, Record<string, unknown>>()
  private listeners = new Set<Listener>()
  private sampleListeners = new Set<SampleListener>()
  private notifyScheduled = false
  private version = 0
  private status: ConnectionStatus = "idle"
  private host: string | null = null
  private newestServerTimeUs = 0
  private demoRobot: DemoRobot | null = null

  getStatus = (): ConnectionStatus => this.status
  getHost = (): string | null => this.host
  getVersion = (): number => this.version

  /** The simulated robot while connected to the demo, otherwise null. */
  getDemo = (): DemoRobot | null => (this.host === DEMO_HOST ? this.demoRobot : null)

  get<T = unknown>(topic: string): T | undefined {
    return this.values.get(topic) as T | undefined
  }

  getNumber(topic: string): number | undefined {
    const v = this.values.get(topic)
    return typeof v === "number" && Number.isFinite(v) ? v : undefined
  }

  /** Whether the robot has announced this topic (it may not have sent a value yet). */
  isAnnounced(topic: string): boolean {
    return this.types.has(topic) || this.values.has(topic)
  }

  getProperties(topic: string): Record<string, unknown> | undefined {
    return this.properties.get(topic)
  }

  topicNames(): string[] {
    return Array.from(new Set([...this.types.keys(), ...this.values.keys()]))
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  onSample = (listener: SampleListener): (() => void) => {
    this.sampleListeners.add(listener)
    return () => {
      this.sampleListeners.delete(listener)
    }
  }

  private notify() {
    if (this.notifyScheduled) return
    this.notifyScheduled = true
    const flush = () => {
      this.notifyScheduled = false
      this.version++
      this.listeners.forEach((l) => l())
    }
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush)
    else setTimeout(flush, 16)
  }

  private setStatus(status: ConnectionStatus) {
    this.status = status
    this.notify()
  }

  async connect(host: string, prefixes: string[]): Promise<void> {
    this.disconnect()
    this.host = host
    this.setStatus("connecting")
    const onAnnounce = (topic: { name: string; type: string; properties?: Record<string, unknown> }) => {
      if (this.client !== client) return
      this.types.set(topic.name, topic.type)
      this.properties.set(topic.name, topic.properties ?? {})
      this.notify()
    }
    const onData = (topic: { name: string }, timestampUs: number, value: unknown) => {
      if (this.client !== client) return
      if (timestampUs > this.newestServerTimeUs) this.newestServerTimeUs = timestampUs
      this.values.set(topic.name, value)
      this.sampleListeners.forEach((l) => l(topic.name, timestampUs, value))
      this.notify()
    }
    const onConnect = () => {
      if (this.client !== client) return
      this.setStatus("connected")
    }
    let client: Nt4ClientLike
    if (process.env.NEXT_PUBLIC_SYSTEMCORE !== "1" && host === DEMO_HOST) {
      const { DemoNt4Client, DemoRobot } = await import("@/lib/demo/demo-robot")
      if (this.host !== host) return
      // The same robot across reconnects, so its gains and faults are kept until it is reset.
      this.demoRobot ??= new DemoRobot()
      client = new DemoNt4Client(this.demoRobot, onAnnounce, onData, onConnect) as unknown as Nt4ClientLike
      this.client = client
      client.connect()
      return
    }
    installLocalNetworkWebSocket()
    const { Nt4Client } = await import("@frc-web-components/fwc/source-providers/nt4")
    if (this.host !== host) return
    client = new Nt4Client(
      host,
      APP_NAME,
      onAnnounce,
      (topic) => {
        if (this.client !== client) return
        this.types.delete(topic.name)
        this.properties.delete(topic.name)
        this.values.delete(topic.name)
        this.notify()
      },
      onData,
      onConnect,
      () => {
        if (this.client !== client) return
        this.values.clear()
        this.types.clear()
        this.properties.clear()
        this.setStatus("connecting")
      },
    )
    this.client = client
    client.subscribePeriodic(prefixes, true, 0.02)
    client.connect()
  }

  disconnect() {
    if (this.client) {
      this.client.disconnect()
      this.client = null
    }
    this.values.clear()
    this.types.clear()
    this.properties.clear()
    this.host = null
    this.newestServerTimeUs = 0
    if (this.status !== "idle") this.setStatus("idle")
  }

  /** Publish a value. Returns false (and does nothing) unless connected. */
  set(topic: string, value: boolean | number | string): boolean {
    if (!this.client || this.status !== "connected") return false
    if (typeof value === "number" && !Number.isFinite(value)) return false
    const type =
      this.types.get(topic) ?? (typeof value === "boolean" ? "boolean" : typeof value === "number" ? "double" : "string")
    this.client.publishNewTopic(topic, type)
    // The server drops a value stamped older than its own copy, and the client's clock estimate can be far off,
    // so stamp writes slightly ahead of the newest server timestamp received.
    const base = this.newestServerTimeUs > 0 ? this.newestServerTimeUs : (this.client.getServerTime_us() ?? 0)
    this.client.addTimestampedSample(topic, base + WRITE_LEAD_US, value)
    this.values.set(topic, value)
    this.notify()
    return true
  }
}
