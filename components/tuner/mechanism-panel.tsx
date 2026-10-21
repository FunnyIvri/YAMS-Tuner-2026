"use client"

import { useMemo } from "react"
import { useNtVersion, useTuner } from "@/components/tuner/tuner-context"
import { Field, NativeSelect, Panel } from "@/components/tuner/panel"
import { KIND_LABELS, discoverCommands, discoverMechanisms, guessKind, type MechanismKind } from "@/lib/yams/topics"

export function MechanismPanel() {
  const {
    nt,
    status,
    session,
    starting,
    mechanismName,
    setMechanismName,
    commandName,
    setCommandName,
    kind,
    setKind,
    continuous,
    setContinuous,
    axis,
  } = useTuner()
  const version = useNtVersion()
  const busy = session !== null || starting

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const mechanisms = useMemo(() => discoverMechanisms(nt), [nt, version])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const commands = useMemo(() => discoverCommands(nt), [nt, version])

  const chooseMechanism = (name: string) => {
    if (!name) {
      setMechanismName(null)
      return
    }
    setMechanismName(name)
    setKind(guessKind(nt, name))
    const match = commands.find((c) => c === name) ?? commands.find((c) => name.startsWith(c) || c.startsWith(name))
    if (match) setCommandName(match)
    else if (commands.length === 1) setCommandName(commands[0])
  }

  return (
    <Panel
      step={1}
      title="Mechanism"
      description="Pick the YAMS mechanism and the subsystem's Live Tuning command. Changing anything here resets every safety confirmation."
      locked={status !== "connected" ? "Connect to a robot or simulation, or start the demo, to discover YAMS mechanisms." : null}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Telemetry name"
          htmlFor="mechanism"
          hint={mechanisms.length === 0 ? "None found under /Tuning/. Set telemetry verbosity to HIGH." : undefined}
        >
          <NativeSelect
            id="mechanism"
            value={mechanismName ?? ""}
            disabled={busy}
            onChange={(e) => chooseMechanism(e.target.value)}
          >
            <option value="">Select…</option>
            {mechanisms.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field
          label="Live Tuning command"
          htmlFor="command"
          hint={commands.length === 0 ? "No Live Tuning command published. Register mechanism.liveTune() on the robot." : undefined}
        >
          <NativeSelect id="command" value={commandName ?? ""} disabled={busy} onChange={(e) => setCommandName(e.target.value || null)}>
            <option value="">Select…</option>
            {commands.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Type" htmlFor="kind" hint={`Setpoints in ${axis === "linear" ? "meters" : "degrees"}.`}>
          <NativeSelect id="kind" value={kind} disabled={busy || !mechanismName} onChange={(e) => setKind(e.target.value as MechanismKind)}>
            {(Object.keys(KIND_LABELS) as MechanismKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </NativeSelect>
        </Field>
        {kind === "pivot" && (
          <Field label="Rotation" hint="Only choose continuous if the pivot can spin freely forever without wrapping wires.">
            <label className="flex h-9 items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-foreground"
                checked={continuous}
                disabled={busy}
                onChange={(e) => setContinuous(e.target.checked)}
              />
              Continuous (no range of motion)
            </label>
          </Field>
        )}
      </div>
    </Panel>
  )
}
