"use client"

import { useState } from "react"
import { Plug, Unplug } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useRobotState, useTuner } from "@/components/tuner/tuner-context"
import { NativeSelect } from "@/components/tuner/panel"
import { IpkDownload } from "@/components/tuner/ipk-download"
import { GitHubLink } from "@/components/tuner/github-link"
import yamsLogo from "@/components/tuner/yams-logo.png"
import { cn } from "@/lib/utils"
import type { LiveTarget } from "@/lib/nt/live-nt"

type TargetKind = LiveTarget["kind"]

const MODE_LABEL = { unknown: "—", autonomous: "Auto", teleoperated: "Teleop", utility: "Test" } as const

export function ConnectionBar() {
  const { status, host, team, setTeam, connect, disconnect } = useTuner()
  const robot = useRobotState()
  const [kind, setKind] = useState<TargetKind>("robot")
  const [custom, setCustom] = useState("")
  const [error, setError] = useState<string | null>(null)

  const onConnect = async () => {
    const target: LiveTarget = kind === "sim" ? { kind } : kind === "robot" ? { kind, team } : { kind, host: custom }
    setError(await connect(target))
  }

  const connected = status === "connected"

  return (
    <header className="border-b border-border bg-card">
      <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3">
          <img src={yamsLogo.src} alt="" aria-hidden width={42} height={28} className="h-7 w-auto shrink-0" />
          <div className="flex flex-col">
            <h1 className="font-mono text-sm font-semibold uppercase tracking-wider">YAMS Live Tuner</h1>
            <p className="text-xs text-muted-foreground">Elevators, arms, pivots and flywheels over NT4</p>
          </div>
          <div className="ml-auto flex items-center gap-1 lg:ml-2">
            <IpkDownload />
            <GitHubLink />
          </div>
        </div>

        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (status === "idle") onConnect()
          }}
        >
          <label htmlFor="target-kind" className="sr-only">
            Connection target
          </label>
          <NativeSelect
            id="target-kind"
            className="h-8 w-auto"
            value={kind}
            disabled={status !== "idle"}
            onChange={(e) => setKind(e.target.value as TargetKind)}
          >
            <option value="robot">Robot (team)</option>
            <option value="sim">Simulation</option>
            <option value="custom">Custom host</option>
          </NativeSelect>
          {kind === "robot" && (
            <>
              <label htmlFor="team" className="sr-only">
                Team number
              </label>
              <Input
                id="team"
                className="h-8 w-24 font-mono"
                inputMode="numeric"
                placeholder="Team #"
                value={team}
                disabled={status !== "idle"}
                onChange={(e) => setTeam(e.target.value.replace(/\D/g, "").slice(0, 5))}
              />
            </>
          )}
          {kind === "custom" && (
            <>
              <label htmlFor="host" className="sr-only">
                Host
              </label>
              <Input
                id="host"
                className="h-8 w-40 font-mono"
                placeholder="10.TE.AM.2"
                value={custom}
                disabled={status !== "idle"}
                onChange={(e) => setCustom(e.target.value)}
              />
            </>
          )}
          {status === "idle" ? (
            <Button type="submit" size="sm">
              <Plug data-icon="inline-start" />
              Connect
            </Button>
          ) : (
            <Button type="button" size="sm" variant="outline" onClick={disconnect}>
              <Unplug data-icon="inline-start" />
              Disconnect
            </Button>
          )}

          <div className="flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1 font-mono text-xs">
            <span
              aria-hidden
              className={cn(
                "size-2 rounded-full",
                connected ? "bg-foreground" : status === "connecting" ? "animate-pulse bg-hazard" : "bg-border",
              )}
            />
            <span>{connected ? host : status === "connecting" ? `Connecting ${host ?? ""}` : "Offline"}</span>
            {connected && robot && (
              <span className={cn("border-l border-border pl-2", robot.eStop && "text-destructive")}>
                {robot.eStop ? "E-STOP" : `${MODE_LABEL[robot.mode]} · ${robot.enabled ? "Enabled" : "Disabled"}`}
              </span>
            )}
          </div>
          {error && (
            <p role="alert" className="w-full text-xs text-destructive">
              {error}
            </p>
          )}
        </form>
      </div>
    </header>
  )
}
