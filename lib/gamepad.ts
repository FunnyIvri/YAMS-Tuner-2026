/** Reading a game controller's sticks, through the browser's Gamepad API. */

/** Stick travel ignored around center, as a fraction of full travel. */
export const STICK_DEADBAND = 0.1

export type Stick = "left" | "right"

export interface Sticks {
  /** The controller's name, as the browser reports it. */
  id: string
  /** Each stick's vertical position, up positive, from -1 to 1, with the deadband taken out. */
  left: number
  right: number
}

/** Removes the deadband and rescales the rest, so the stick still reaches ±1 and starts from 0 just past it. */
export function applyDeadband(value: number, deadband = STICK_DEADBAND): number {
  const magnitude = Math.abs(value)
  if (magnitude <= deadband) return 0
  return (Math.sign(value) * Math.min(1, (magnitude - deadband) / (1 - deadband)))
}

/**
 * The first connected controller's sticks, or null if there is none. Browsers only report a controller once one of
 * its buttons has been pressed with the page open. In the standard layout, axis 1 is the left stick's vertical and
 * axis 3 the right's, with up negative.
 */
export function readSticks(deadband = STICK_DEADBAND): Sticks | null {
  if (typeof navigator === "undefined" || !navigator.getGamepads) return null
  const pad = Array.from(navigator.getGamepads()).find((p): p is Gamepad => !!p && p.connected)
  if (!pad) return null
  const axis = (i: number) => (pad.axes.length > i ? -pad.axes[i] : 0)
  return { id: pad.id, left: applyDeadband(axis(1), deadband), right: applyDeadband(axis(3), deadband) }
}
