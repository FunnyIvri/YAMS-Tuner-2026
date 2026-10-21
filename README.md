# YAMS Live Tuner

A browser tool for safely live tuning [YAMS](https://github.com/Yet-Another-Software-Suite/YAMS) mechanisms (elevators, arms, pivots and flywheels) on FRC robots over NetworkTables 4.

**Live site:** https://tuning.yassrobotics.com/

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

## Demo mode

Pick **Demo (no robot)** and press **Start demo**, or open the site with `?demo` (for example https://tuning.yassrobotics.com/?demo), to try the tuner without a robot or a simulation. A simulated robot runs in the page with four YAMS mechanisms: an elevator, an arm, a turret with no motion profile, and a two-motor shooter flywheel. Their physics come from [YAMG](https://github.com/Yet-Another-Software-Suite/yamg)'s simulation: NEO motors with stator and supply current limits, gravity, hard stops and battery sag.

The demo bar under the header stands in for the Driver Station: pick the mode, enable or disable the robot, and reset it. It can also break the robot on purpose, so the safety checks can be tried:

- **Elevator motor wired backwards**: the inversion check sees the elevator move the wrong way.
- **Arm blocked at 45°**: range verification and Live Tuning run into it.

Every mechanism starts inside its range of motion, and holds where it is while nothing drives it, as a geared mechanism in brake mode does. The arm starts stowed on its lower hard stop, which is also its lower soft limit, so gravity can't pull it out of its range while it is driven at 0 V. The elevator's and arm's kG, and the flywheel's kV, start too low, so there is something to tune.

Demo mode is only on the hosted site. The SystemCore package is built without it.

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

## Running on SystemCore

The tuner can be installed on SystemCore as a package, so it is served from the robot itself at `http://<systemcore>:5812/`. A web server starts on the first request (socket activation) and serves the static site.

Press **Download IPK** on https://tuning.yassrobotics.com/ for `yams-tuner_<version>.ipk` built from the same commit as the site, or download it from the [latest release](https://github.com/Yet-Another-Software-Suite/YAMS-Tuner/releases/latest) or the **Build SystemCore IPK** workflow run artifacts. Open the SystemCore web interface at http://robot.local and drag the `.ipk` onto the home page or the **Package Manager** tab.

To build the package yourself (Linux or WSL, needs `tar`, `ar` and `gzip`):

```bash
pnpm install
systemcore/build-ipk.sh
```

The `.ipk` is written to `dist/`. Set `PORT`, `VERSION` or `PACKAGE_NAME` to override the defaults, and pass `--skip-site-build` to reuse an existing `out/` folder (it must be built with `NEXT_PUBLIC_SYSTEMCORE=1` and without `NEXT_PUBLIC_BASE_PATH`).

Package sources live in `systemcore/`: `control/` holds the package metadata and install scripts, `overlay/` holds the files installed onto the device (systemd units and `server.py`), and `assets/icon.png` is the 845x480 tile shown in the SystemCore UI. `@PACKAGE@`, `@VERSION@` and `@PORT@` placeholders are filled in at build time.

## Project layout

| Path | Contents |
| --- | --- |
| `app/` | Next.js app router entry (`layout.tsx`, `page.tsx`, global styles) |
| `components/tuner/` | Tuner panels: connection, checklist, range verification, setpoints, gains, telemetry |
| `components/ui/` | shadcn/ui components |
| `lib/nt/` | NetworkTables 4 client built on FRC Web Components |
| `lib/demo/` | Demo mode: the simulated robot, and the physics ported from YAMG |
| `lib/yams/` | YAMS topic names and safety limits |
| `systemcore/` | SystemCore package sources and `build-ipk.sh` |

## Deployment

Every push to `main` builds the site as a static export and publishes it to GitHub Pages using `.github/workflows/deploy-pages.yml`. The workflow can also be run by hand from the **Actions** tab.

One-time setup: in the repository on GitHub, go to **Settings > Pages** and set **Source** to **GitHub Actions**.

The workflow sets `NEXT_PUBLIC_BASE_PATH` to the Pages subpath (for example `/YAMS-Tuner`) so links and assets resolve correctly. Local builds leave it empty and serve from `/`.

https://tuning.yassrobotics.com/ is an nginx reverse proxy in front of the GitHub Pages site (https://yet-another-software-suite.github.io/YAMS-Tuner/). It serves the tuner from `/` and passes the `/YAMS-Tuner/` asset paths through, so every Pages deploy shows up there with no extra step.

The **Build SystemCore IPK** workflow (`.github/workflows/build-ipk.yml`) builds the `.ipk` on every push and pull request and uploads it as a workflow artifact. The **Deploy to GitHub Pages** workflow (`.github/workflows/deploy-pages.yml`) also builds it on every push to `main` and publishes it beside the site, where the **Download IPK** button links to it. A build without it, such as `pnpm dev`, links to the latest release instead.

To publish a release, open **Actions > Release > Run workflow** and enter a version such as `1.2.0`. The **Release** workflow (`.github/workflows/release.yml`) builds the `.ipk` with that version, tags the commit as `v1.2.0`, and creates a GitHub release with the `.ipk` attached. The release description lists the commits since the previous release, install steps for SystemCore and the file's SHA-256 checksum (see `.github/scripts/release-notes.sh`).
