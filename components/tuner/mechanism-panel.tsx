"use client"

import { useMemo } from "react"
import { Button } from "@/components/ui/button"
import { useNtVersion, useTuner } from "@/components/tuner/tuner-context"
import { Field, NativeSelect, Panel } from "@/components/tuner/panel"
import { KIND_LABELS, discoverCommands, discoverMechanisms, guessKind, type MechanismKind } from "@/lib/yams/topics"

export function MechanismPanel({ onContinue }: { onContinue: () => void }) {
  const {
    nt,
    status,
    session,
    starting,
    mechanismName,
    setMechanismName,
    commandName,
    setCommandName,
    secondWheel,
    setSecondWheel,
    kind,
    setKind,
    continuous,
    setContinuous,
    axis,
    setMechanismConfirmed,
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
    const matches = (m: string, c: string) => m === c || m.startsWith(c) || c.startsWith(m)
    const match = commands.find((c) => c === name) ?? commands.find((c) => matches(name, c))
    // Otherwise the one command no mechanism is named after, if there is just one: a subsystem whose mechanisms
    // are named apart from it, such as a double flywheel's two wheels.
    const unclaimed = commands.filter((c) => !mechanisms.some((m) => matches(m, c)))
    if (match) setCommandName(match)
    else if (commands.length === 1) setCommandName(commands[0])
    else if (unclaimed.length === 1) setCommandName(unclaimed[0])
  }

  return (
    <Panel
      step={1}
      title="Mechanism"
      description="Pick the YAMS mechanism and the subsystem’s Live Tuning command. Changing anything here resets every safety confirmation."
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
        {kind === "flywheel" && (
          <Field
            label="Second flywheel"
            htmlFor="second-wheel"
            hint="For a double flywheel: another flywheel in the same subsystem, sharing its Live Tuning command. Both wheels are tuned together."
          >
            <NativeSelect
              id="second-wheel"
              value={secondWheel ?? ""}
              disabled={busy || !mechanismName}
              onChange={(e) => setSecondWheel(e.target.value || null)}
            >
              <option value="">None</option>
              {mechanisms
                .filter((m) => m !== mechanismName)
                .map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
            </NativeSelect>
          </Field>
        )}
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
      <Button
        className="self-start"
        disabled={!mechanismName || !commandName}
        onClick={() => {
          setMechanismConfirmed(true)
          onContinue()
        }}
      >
        Continue
      </Button>
    </Panel>
  )
}
