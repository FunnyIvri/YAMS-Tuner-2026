/** The host name LiveNT connects to for the demo robot. */
export const DEMO_HOST = "demo"

/**
 * The demo is left out of the SystemCore package, which only ever talks to the robot it runs on.
 * Checked inline with process.env so that build drops the demo code entirely.
 */
export const DEMO_AVAILABLE = process.env.NEXT_PUBLIC_SYSTEMCORE !== "1"
