/** Reading a game controller's sticks, through the browser's Gamepad API. */

/** Stick travel ignored around center, as a fraction of full travel. */
export const STICK_DEADBAND = 0.1

export type Stick = "left" | "right"

/** The kinds of controller whose stick axes are known. Auto picks one from the controller's name. */
export type PadType = "auto" | "xbox" | "playstation" | "switch" | "generic"

export const PAD_TYPES: { value: PadType; label: string }[] = [
  { value: "auto", label: "Auto (from its name)" },
  { value: "xbox", label: "Xbox" },
  { value: "playstation", label: "PlayStation" },
  { value: "switch", label: "Switch Pro" },
  { value: "generic", label: "Generic" },
]

/**
 * The axis of each stick's vertical travel. With the browser's standard layout every controller uses axis 1 for the
 * left stick and 3 for the right. Without it (some browsers, some drivers), they differ by controller: an Xbox
 * controller reports its right stick's vertical on axis 4, a PlayStation one on axis 5.
 */
const NON_STANDARD_AXES: Record<Exclude<PadType, "auto">, { left: number; right: number }> = {
  xbox: { left: 1, right: 4 },
  playstation: { left: 1, right: 5 },
  switch: { left: 1, right: 3 },
  generic: { left: 1, right: 3 },
}

/** The controller type its name suggests, from the name or its USB vendor id. */
export function guessPadType(id: string): Exclude<PadType, "auto"> {
  const name = id.toLowerCase()
  if (/xbox|xinput|045e/.test(name)) return "xbox"
  if (/playstation|dualshock|dualsense|wireless controller|054c/.test(name)) return "playstation"
  if (/pro controller|nintendo|057e/.test(name)) return "switch"
  return "generic"
}

export interface Sticks {
  /** The controller's name, as the browser reports it. */
  id: string
  /** The type its axes are read as: the chosen one, or the guess for Auto. */
  type: Exclude<PadType, "auto">
  /** Whether the browser maps it to the standard layout. */
  standard: boolean
  /** Each stick's vertical position, up positive, from -1 to 1, with the deadband taken out. */
  left: number
  right: number
}

/** Removes the deadband and rescales the rest, so the stick still reaches ±1 and starts from 0 just past it. */
export function applyDeadband(value: number, deadband = STICK_DEADBAND): number {
  const magnitude = Math.abs(value)
  if (magnitude <= deadband) return 0
  return Math.sign(value) * Math.min(1, (magnitude - deadband) / (1 - deadband))
}

/**
 * The first connected controller's sticks, or null if there is none. Browsers only report a controller once one of
 * its buttons has been pressed with the page open. Up is negative on the axis for most controllers, so it is flipped
 * to positive; `invert` flips it back, for a controller that reads up as down.
 */
export function readSticks(type: PadType = "auto", invert = false, deadband = STICK_DEADBAND): Sticks | null {
  if (typeof navigator === "undefined" || !navigator.getGamepads) return null
  const pad = Array.from(navigator.getGamepads()).find((p): p is Gamepad => !!p && p.connected)
  if (!pad) return null
  const resolved = type === "auto" ? guessPadType(pad.id) : type
  const standard = pad.mapping === "standard"
  const axes = standard ? { left: 1, right: 3 } : NON_STANDARD_AXES[resolved]
  const sign = invert ? 1 : -1
  const axis = (i: number) => (pad.axes.length > i ? sign * pad.axes[i] : 0)
  return {
    id: pad.id,
    type: resolved,
    standard,
    left: applyDeadband(axis(axes.left), deadband),
    right: applyDeadband(axis(axes.right), deadband),
  }
}
