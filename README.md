# YAMS Live Tuner

A browser tool for safely live tuning [YAMS](https://github.com/Yet-Another-Software-Suite/YAMS) mechanisms (elevators, arms, pivots and flywheels) on FRC robots over NetworkTables 4.

**Live site:** https://yet-another-software-suite.github.io/YAMS-Tuner/

## Features

- Connects to a robot by team number, to the simulator on `localhost`, or to a custom host.
- Discovers YAMS mechanisms from their telemetry under `/Mechanisms/<name>` and writes tunables under `/Tuning/<name>`.
- Guided safety checklist and voltage/inversion check before anything moves.
- Range-of-motion verification that jogs the mechanism slowly toward each soft limit and aborts on inversion, stalls or overshoot.
- Setpoint control, a setpoint alternator, and live editing of gains and feedforward.
- Live telemetry: position, velocity, setpoint, voltage, current and temperature.
- A stop bar that is always visible.

## Using it

1. On the robot, publish YAMS telemetry for your mechanism and register its Live Tuning command with `mechanism.liveTune()`.
2. Open the live site (or run it locally, see below).
3. Pick **Robot** and enter your team number, or pick **Sim** for the simulator.
4. Choose the mechanism, its Live Tuning command and its type, then follow the checklist and range verification before tuning.

The page is served over HTTPS but talks to the robot with `ws://`. Chromium based browsers allow this for local network addresses, and may show a prompt asking for permission to access devices on your local network. If the connection fails, try Chrome or Edge, or run the tuner locally.

**Always keep a hand on the Driver Station disable button while tuning.**

## Development

Requires Node.js 22 and pnpm (the version is pinned in `package.json`; `corepack enable` picks it up automatically).

```bash
pnpm install
pnpm dev
```

Then open http://localhost:3000.

To produce the static site in `out/`:

```bash
pnpm build
```

## Project layout

| Path | Contents |
| --- | --- |
| `app/` | Next.js app router entry (`layout.tsx`, `page.tsx`, global styles) |
| `components/tuner/` | Tuner panels: connection, checklist, range verification, setpoints, gains, telemetry |
| `components/ui/` | shadcn/ui components |
| `lib/nt/` | NetworkTables 4 client built on FRC Web Components |
| `lib/yams/` | YAMS topic names and safety limits |

## Deployment

Every push to `main` builds the site as a static export and publishes it to GitHub Pages using `.github/workflows/deploy-pages.yml`. The workflow can also be run by hand from the **Actions** tab.

One-time setup: in the repository on GitHub, go to **Settings > Pages** and set **Source** to **GitHub Actions**.

The workflow sets `NEXT_PUBLIC_BASE_PATH` to the Pages subpath (for example `/YAMS-Tuner`) so links and assets resolve correctly. Local builds leave it empty and serve from `/`.
