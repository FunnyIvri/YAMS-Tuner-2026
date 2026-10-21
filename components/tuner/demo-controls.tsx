"use client"

import { useSyncExternalStore } from "react"
import { FlaskConical, Power, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { useTuner } from "@/components/tuner/tuner-context"
import { NativeSelect } from "@/components/tuner/panel"
import type { DemoFaults, DemoRobot } from "@/lib/demo/demo-robot"
import type { RobotMode } from "@/lib/nt/live-nt"

const FAULTS: { key: keyof DemoFaults; label: string }[] = [
  { key: "elevatorBackwards", label: "Elevator motor wired backwards" },
  { key: "armBlocked", label: "Arm blocked at 45°" },
]

/** The demo robot's Driver Station: enable, mode, faults to try, and a reset. Only shown in the demo. */
export function DemoControls() {
  // The SystemCore package has no demo. The check is inline so its build drops the demo entirely.
  if (process.env.NEXT_PUBLIC_SYSTEMCORE === "1") return null
  return <DemoControlsInner />
}

function DemoControlsInner() {
  const { nt, status } = useTuner()
  useSyncExternalStore(nt.subscribe, nt.getVersion, () => 0)
  const robot = status === "connected" ? nt.getDemo() : null
  if (!robot) return null
  return <DemoBar robot={robot} />
}

function DemoBar({ robot }: { robot: DemoRobot }) {
  useSyncExternalStore(robot.subscribe, robot.getVersion, () => 0)

  return (
    <div className="border-b border-border bg-muted/40">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 text-sm">
        <p className="flex items-center gap-2 font-mono text-xs font-semibold uppercase tracking-wide">
          <FlaskConical className="size-4" aria-hidden />
          Demo robot
        </p>
        <p className="text-xs text-muted-foreground">Simulated in this page. Nothing here moves a real mechanism.</p>

        <div className="flex items-center gap-2">
          <label htmlFor="demo-mode" className="text-xs text-muted-foreground">
            Mode
          </label>
          <NativeSelect
            id="demo-mode"
            className="h-8 w-auto"
            value={robot.mode}
            onChange={(e) => robot.setMode(e.target.value as RobotMode)}
          >
            <option value="teleoperated">Teleop</option>
            <option value="utility">Test</option>
            <option value="autonomous">Auto</option>
          </NativeSelect>
          <Button
            type="button"
            size="sm"
            variant={robot.enabled ? "destructive" : "default"}
            onClick={() => robot.setEnabled(!robot.enabled)}
          >
            <Power data-icon="inline-start" />
            {robot.enabled ? "Disable" : "Enable"}
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {FAULTS.map((f) => (
            <label key={f.key} className="flex items-center gap-2 text-xs">
              <Switch size="sm" checked={robot.faults[f.key]} onCheckedChange={(checked) => robot.setFault(f.key, checked)} />
              {f.label}
            </label>
          ))}
        </div>

        <Button type="button" size="sm" variant="outline" className="ml-auto" onClick={() => robot.reset()}>
          <RotateCcw data-icon="inline-start" />
          Reset robot
        </Button>
      </div>
    </div>
  )
}
