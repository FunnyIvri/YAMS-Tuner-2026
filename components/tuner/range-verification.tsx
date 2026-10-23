"use client"

import { useState } from "react"
import { SkipForward, TriangleAlert, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { useAxisValues, useTuner } from "@/components/tuner/tuner-context"
import { Notice, Panel } from "@/components/tuner/panel"
import { VerificationBody } from "@/components/tuner/range-verification-body"
import { axisReader } from "@/lib/yams/topics"

export function RangeVerification() {
  const {
    requiresRangeVerification,
    checklistConfirmed,
    mechanismName,
    commandName,
    kind,
    continuous,
    axis,
    rangeSkipped,
    setRangeSkipped,
    session,
    inversionCheck,
  } = useTuner()
  if (requiresRangeVerification && rangeSkipped) {
    return (
      <Panel step={4} title="Range of motion" description="Verification was skipped. Only the robot's soft limits, if configured, bound travel.">
        <Notice tone="danger">
          Range of motion is NOT verified. Nothing in this tool will stop the mechanism before a hard stop unless the robot has soft limits.
        </Notice>
        <Button variant="outline" className="self-start" disabled={session !== null} onClick={() => setRangeSkipped(false)}>
          Verify range instead
        </Button>
      </Panel>
    )
  }
  if (!requiresRangeVerification) {
    return (
      <Panel
        step={4}
        title="Range of motion"
        description={
          kind === "flywheel"
              ? "Flywheels spin continuously, so there is no range to verify. Speed is capped instead."
              : "Continuous pivots have no end of travel, so there is no range to verify."
        }
      />
    )
  }
  return (
    <Panel
      step={4}
      title="Verify range of motion"
      description="Drive to each end of travel with a small voltage, or enter a range and drive to each end. A stall or current fault marks that end. Tuning is then limited to this range."
      locked={
        !mechanismName || !commandName
          ? "Choose a mechanism first."
          : !checklistConfirmed
            ? "Complete the pre-motion checklist first."
            : inversionCheck === "pending"
              ? "Check the inversions first. Driving with a reversed motor or encoder drives the mechanism the wrong way."
              : null
      }
    >
      <VerificationBody key={`${mechanismName}|${kind}|${continuous}|${axis}`} skipControl={<SkipRangeDialog />} />
    </Panel>
  )
}

function SkipRangeDialog() {
  const { setRangeSkipped, lowerLimitSet, session, stop } = useSkipContext()
  const [agreed, setAgreed] = useState(false)
  const skip = () => {
    if (session !== null) stop("Range of motion verification skipped")
    setRangeSkipped(true)
  }
  return (
    <AlertDialog onOpenChange={(open) => !open && setAgreed(false)}>
      <AlertDialogTrigger render={<Button variant="ghost" className="ml-auto text-destructive hover:text-destructive" />}>
        <SkipForward data-icon="inline-start" />
        Skip verification
      </AlertDialogTrigger>
      <AlertDialogContent className="border-l-[3px] border-l-destructive">
        <AlertDialogCancel
          variant="ghost"
          size="icon"
          aria-label="Close"
          className="absolute top-2 right-2 z-10"
        >
          <X />
        </AlertDialogCancel>
        <AlertDialogHeader className="pr-8">
          <AlertDialogTitle className="flex items-center gap-2">
            <TriangleAlert className="size-5 shrink-0 text-destructive" aria-hidden />
            Skip range-of-motion verification?
          </AlertDialogTitle>
          <AlertDialogDescription render={<div />} className="flex flex-col gap-2 text-left">
            <p>Without a verified range, this tool cannot keep setpoints inside the mechanism&apos;s real travel. If you continue:</p>
            <ul className="flex list-disc flex-col gap-1 pl-5">
              <li>Setpoints can drive the mechanism into hard stops, frame members or other mechanisms at full closed-loop effort.</li>
              <li>A wrong motor or encoder inversion will not be caught before the mechanism runs away.</li>
              <li>
                {lowerLimitSet
                  ? "Travel is only bounded by the robot's soft limits, which have not been checked against the real mechanism."
                  : "The robot publishes no soft limits, so travel is not bounded at all."}
              </li>
              <li>Damaged gearboxes, belts, wiring and injuries are possible. Keep a hand on the Driver Station disable.</li>
            </ul>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <label className="flex items-start gap-3 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm leading-relaxed">
          <Checkbox checked={agreed} onCheckedChange={(v) => setAgreed(v === true)} className="mt-0.5" />
          I understand the risks and take responsibility for the mechanism&apos;s travel.
        </label>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={!agreed} onClick={skip}>
            Skip and continue
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function useSkipContext() {
  const { setRangeSkipped, nt, mechanismName, axis, session, stop } = useTuner()
  useAxisValues()
  const reader = mechanismName ? axisReader(nt, mechanismName, axis) : null
  return { setRangeSkipped, session, stop, lowerLimitSet: reader?.lowerLimit() !== undefined }
}
