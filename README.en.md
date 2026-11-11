# Aventurine Pet (aventurine-pet-vrm)

[中文](README.md) · **English**

A transparent, always-on-top desktop pet for macOS. The character is **Aventurine · Waveflair** from
*Honkai: Star Rail* (VRM 1.0, private asset, never committed), rendered with **three.js + three-vrm**
inside an **Electron** shell. Motions come from Blender retargeting pipelines, and the app talks to
**DeepSeek Harness (DSH)** through a file bridge.

This README explains **how the codebase is organized, how data flows, and where to change things**.
If you don't do 3D work and only want to swap a model or a motion set, jump to
[「Not a modeler? Start here」](#not-a-modeler-start-here-four-guides).

Development history and per-wave acceptance records live in the
[project record](docs/archive/README-2026-11-11-wave-log.md); the implementation plan is [PLAN.md](PLAN.md).
Those documents are Chinese-only.

| Fact | Value (measured in this snapshot) |
|---|---|
| Runtime | Electron `^44.7.2` / three `0.171.0` / three-vrm `3.5.5` |
| Build | electron-vite `^6` + Vite `^8` + TypeScript `5.9` |
| Node / package manager | Node `>=22.12.0` / `pnpm@10.20.0` (pinned via `packageManager`) |
| Target | macOS 13+, `appId com.aventurine.pet`, output `dist/mac-arm64/AventurinePet.app` |
| Source size | 161 files under `src/**`; `src/main/index.ts` is 2788 lines (bootstrap + smoke + dev capture) |
| Tests | 139 test files (138 pass / 1 skipped); **2779 passed + 16 skipped (2795 cases)**, measured 2026-11-11 with local private assets present |
| Private motion set | `app-manifest.json` **40 clips** / `app-catalog.json` **181 clips** |

## Red lines (read first)

- The model is © **miHoYo**; the author's rules **forbid redistribution and commercial use**. This repo
  contains code and public resources only — model, motions, expressions and props are all local private
  assets on the maintainer's machine.
- These paths are excluded by `.gitignore` and must never appear in a public repo, a shared build or a PR:
  `assets/model/`, `assets/vrm/`, `assets/motions/`, `assets/expressions/`, `assets/props/`,
  `assets/voicelines.json`, `*.pmx`, `refs/`, `work/`.
- The `.app` under `dist/` bundles private assets and is **ad-hoc signed / not notarized**.
  **Local use only — do not distribute.**
- The v1 archive workspace (`deepseek-harness/aventurine-pet`) is read-only reference. Don't modify it.

## Quick start

```bash
pnpm install          # postinstall downloads the Electron binary
pnpm native:build     # builds native/winlist (Swift; predev/prebuild run it, idempotent)
pnpm dev              # VRM backend by default
pnpm typecheck        # both tsconfig.node and tsconfig.web
pnpm test             # vitest, tests/**/*.test.ts
pnpm build            # prebuild asset check + typecheck + electron-vite build
pnpm package:dir      # build → electron-builder --mac dir → package-check
```

Two external prerequisites for a first successful run:

1. **Private assets**: `assets/vrm/` (at least `aventurine-tpose.vrm`) and `assets/motions/`. Without them
   `prepare-assets.mjs --check` (run by `prebuild`) fails; `AVENTURINE_SKIP_ASSETS_CHECK=1 pnpm build`
   skips the **check** only — it cannot invent assets, and the result will not render.
2. **Xcode Command Line Tools**: `native/winlist` is a universal binary (arm64 + x86_64, minos 13.0)
   built with `swiftc`, used by the main process to enumerate windows.

Extra commands:

```bash
pnpm smoke            # end-to-end smoke (PET_SMOKE_TEST=1, real windows/assets/bridge)
pnpm assets:prepare   # build/verify assets/model/optimized (legacy PMX path)
pnpm dsh:canary       # bridge contract canary (temp DSH_HOME + mock LLM, never touches ~/.dsh)
pnpm package:check    # verify bundle id / app.asar / Resources / helper architecture
pnpm test:coverage    # v8 coverage, thresholds in vitest.config.mts
```

When working across several worktrees use `pnpm dev:worktree`: it derives `PET_PROFILE` from the
directory name so each worktree gets its own `userData`, config and single-instance scope
(single-instance lock is only enabled in packaged builds).

## Not a modeler? Start here: four guides

| Where you're stuck | Read this |
|---|---|
| You don't know where to get a model or motions | [Where to find assets](docs/guide-asset-sourcing.en.md) |
| You have PMX / FBX / VRM0 and need a renderable VRM | [Three model-to-VRM routes](docs/guide-model-conversion.en.md) |
| You have FBX / `.anim` / `.max` / VMD and need app-playable clips | [Four motion pipelines](docs/guide-motion-conversion.en.md) |
| Something looks like A-pose, drooping shoulders, mirrored or sliding | [Common pitfalls + prompt template](docs/guide-asset-pitfalls.en.md) |

Three rules: the model **must be a spec-compliant T-pose VRM 1.0**; motions should prefer
**same game, same character**, then same body type, then same gender; **without a mocap rig, never ask
an AI to author motion from scratch**. Every pitfall here has a deterministic fix — hand the symptom
and the error to an AI agent.

## Architecture

Three layers — **Electron main / preload / renderer (two page entries)** — plus a fully decoupled
**DSH file bridge**. The shared layer `src/shared/**` is environment-neutral TypeScript (no `electron`,
no `node:` built-ins), so all three layers share one contract.

```text
┌──────────────────────────── macOS ────────────────────────────────┐
│  DeepSeek Harness host (separate Electron app, separate process)   │
│    └─ bridge/dsh-aventurine-bridge (cordis plugin, host-only)      │
│         status.json / control.json / events.jsonl (atomic writes)  │
│                        │ files, polled every 750ms                │
│  ┌─────────────────────▼───────────────────────────────────────┐  │
│  │ AventurinePet.app (Electron 44)                             │  │
│  │                                                             │  │
│  │ main      overlay × N (one transparent window per display)   │  │
│  │           tray / settings window                            │  │
│  │           pet-asset:// protocol / config store / hardening   │  │
│  │           dsh-watch → dsh-event (broadcast only when online) │  │
│  │           dsh-lifecycle (keep-alive / die-together state)    │  │
│  │           winlist helper (Swift, 250ms CGWindowList)         │  │
│  │ preload   window.api = whitelisted PetApi forwarding         │  │
│  │ renderer  index.html (transparent overlay: three-vrm + runtime) │
│  │           settings.html (normal settings window, 2nd entry)  │  │
│  └─────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
```

Key boundary decisions:

- **The renderer sees one restricted API**: `window.api` (`PetApi`). No `window.electron`, no raw
  `ipcRenderer`, no `process.env`; preload throws immediately if `contextIsolation` is off (fail-fast).
- **Assets never use `file://`**: everything goes through the custom `pet-asset://model/...` and
  `pet-asset://assets/...` protocols, with main-process path validation, root confinement and
  symlink-race protection.
- **DSH never communicates over a port**: the bridge only writes files into a fixed directory and the
  pet polls them. If DSH crashes the pet survives; if the pet quits DSH is unaffected
  unless strong coupling is explicitly enabled.

## Code map

| Path | Responsibility |
|---|---|
| `src/shared/` | **Frozen contracts**: `ipc.ts` (channels + `PetApi`), `types.ts`, `config.ts` (defaults / `sanitizeConfig`), `bridge-schema.ts` (bridge file validation), `vrm.ts` / `animation-contract.ts` / `expression-contract.ts`, `peek.ts` |
| `src/main/index.ts` | Bootstrap wiring, single instance, hardening, crash recovery, smoke report, dev pose capture; **not a thin entry** — change with care |
| `src/main/app-context.ts` | Process-level overlay registry + typesafe `broadcast()` |
| `src/main/windows/` | `overlay-manager` (multi-display sync/rebuild/visibility), `settings-window`, `mouse-gate`, `layout`, `crash-recovery` |
| `src/main/ipc/` | Domain handlers: `window` / `config` / `desktop` / `settings` / `dsh` |
| `src/main/desktop/` | `winlist.ts` (helper call + fallback), `dsh-watch.ts` (file tailing), `dsh-version.ts` + `dsh-compat.ts` (compatibility), `dsh-process.ts` (process ops), `dsh-lifecycle.ts` (strong-coupling state machine), `dsh-bridge-state.ts` |
| `src/main/protocol.ts` / `protocol-path.ts` | `pet-asset://` protocol and pure path validation (unit-tested) |
| `src/main/config-store.ts` | Atomic `userData/config.json` read/write + sanitize (Electron-free, injectable dir) |
| `src/main/logger.ts` / `tray.ts` / `login-item.ts` / `security/` | File logger, menu-bar tray, launch-at-login, navigation and network guards |
| `src/main/peek/` | **Reserved stub** for screen-peeking interactions: types and a fail-closed gate only, off by default, zero capture |
| `src/preload/index.ts` | Whitelisted `PetApi` forwarding (pure forwarding, no business logic) |
| `src/renderer/src/main.ts` | Overlay boot, layout, rAF loop, debug surface, teardown |
| `src/renderer/src/core/` | `pet-runtime.ts` (composes desktop sensing / behavior / physics / DSH reactions into per-frame output), `wave2-contract.ts` (render-layer frozen contract), `bubble.ts`, `voicelines.ts` |
| `src/renderer/src/behavior/` | Behavior state machine + weighted activity scheduler (pure logic) |
| `src/renderer/src/physics/` | Gravity / collision / throw / surface landing (pure logic; feet point is the single authority) |
| `src/renderer/src/desktop/` | Window list → desktop surfaces (`DesktopSensor`: coordinate conversion, filtering, transitions) |
| `src/renderer/src/interaction/` | Drag / head-pat / poke / gaze / context menu (logic and DOM strictly separated) |
| `src/renderer/src/scene/` | `PetView` abstraction + legacy PMX scene + shared render utilities (fps limiter, outline, pixel ratio) |
| `src/renderer/src/vrm/` | VRM scene, clip player, animation composition, expression layer, look-at, foot-lock, held prop, upper-chest fold |
| `src/renderer/src/animation/` | legacy (v1 VMD/procedural) animation; `index.ts` is a facade, used only by the `legacy-pmx` fallback |
| `src/renderer/src/reactions/` | DSH event → one-shot performance; DSH reply bubble state machine; idle/work micro-motions |
| `src/renderer/src/settings/` | Settings page model and DOM (all slider/toggle math lives in `settings-model.ts`) |
| `bridge/dsh-aventurine-bridge/` | DSH-side host-only plugin (ESM, no build step) |
| `native/winlist/` | Swift window-enumeration helper source and notes |
| `scripts/` | Build/package/asset/motion/acceptance scripts (`vrm/`, `unity-bake/`, `anim-pipeline/`, `max-export/`, `props/`, `wave3-e2e/`) |
| `tests/` | 139 vitest files; `tests/tmp/` holds local evidence and is never collected |

## Startup chain (main process)

`src/main/index.ts` has order-dependent steps. Read it in this sequence:

1. **Before `app.whenReady()`**: `applyDevProfile()` (`PET_PROFILE` changes `userData`) and
   `registerPetAssetScheme()` (Electron requires schemes to be registered up front).
2. `bootstrap()`: set macOS to `accessory` (no Dock icon, not in Cmd+Tab), `hardenSession()`,
   create the file logger, install crash recovery, `registerPetAssetProtocol()`, `registerIpcHandlers()`.
3. `createOverlayWindowsManager({ getDisplays, loadContents, hardenWebContents })`:
   `manager.sync(getDisplayInfos())` → **one overlay per display**; then `startDisplayWatchers()` watches
   topology/workArea changes (debounced rebuild + `screens-updated` broadcast).
4. Tray (show/hide, settings, quit); on `will-quit`, release recovery policy, settings window and overlays.
5. Quit semantics: the tray is permanent, hiding is not quitting; only tray "Quit", `pet:quit`, or
   running without a tray exits the app.

## Renderer: boot and per-frame pipeline

`boot()` creates the bubble, the DSH reply state machine and the interaction controller, subscribes to
`config-changed` / `screens-updated` / `windows-updated` / `dsh-event`, fetches the initial config and
window geometry **in parallel**, then `updateLayout()`. The scene is created only after layout confirms
the pet should be visible (`ensureScene`; VRM by default, `legacy-pmx` uses the old scene).

Every rAF frame (`frame()`) runs in a fixed order:

```text
interaction.drainEvents()            # consume interaction events for this frame
interaction.getSnapshot()            # pointer/hover/drag/pat progress/gaze target
forwardDragEvents()                  # push drag events to physics immediately (keeps it attached)
runtime.frame({ nowMs, dt, ... })    # see below
  ├─ 1 desktopSensor.snapshot()      # desktop surfaces + transitions
  ├─ 2 dshReactionTracker.reactionAt()
  ├─ 3 behaviorDirector.update()     # behavior decision (B1)
  ├─ 4 physics.setCommand + step()   # physics step (B2) → feet
  └─ 5 assemble animation input (mood/facing/thrown·landed events)
applyRuntimeOutput()                 # bubble arbitration → setAnimationInput → placePet → hit gate → debug
scene.step(nowMs)                    # render + animation layers
```

Notes:

- **Bubble arbitration**: the DSH dialogue layer (`DshDialogue`) outranks behavior lines; skipped when
  `dshBubbleSync=false`.
- **The hit rectangle follows the visuals**: foot-lock hip shift and sit sinking move the visual pose away
  from the physics `petRect`; hits and bubbles use `pointerRect` to correct that offset without changing
  physics semantics.
- **The fps cap lives inside the scene** (`fps-limiter`): skipping frames doesn't affect behavior or
  physics because they advance on real `nowMs`/`dt`.
- **After 3 consecutive scene errors updates stop** but rAF keeps running, so
  `window.__aventurineDebug` stays readable.

VRM animation layer order (documented at the top of `vrm/animator.ts`):

```text
clip-player.update()      # humanoid bones + Hips translation + grounding
expression-layer.update() # expressionManager
look-at.update()          # head/eye additive
humanoid.update()         # sync raw bones
vrm.update(dt)            # spring bones / materials / built-in lookAt
```

## Key subsystems

### Behavior (`behavior/`)

Priority, high to low: **drag > pat/poke reaction > fall > DSH external reaction > autonomous > idle**.
Autonomous behavior is a scheduler of weighted random picks with minimum duration, per-activity cooldowns
and context multipliers. Activities cover idle fidgets (flipping chips, coin toss, collar fix, stretch,
staring, salute), walking, sitting on window ledges, sleeping, hopping down and following windows.
`climb` is **debug-only** (`schedulable=false`, reachable only via `triggerActivity('climb')`).
All lines are official in-game voice lines; the data itself is **private**, stored in
`assets/voicelines.json` (kept locally, gitignored — the repo only keeps the loader and the pet stays
silent when the file is missing). **Never invent or rewrite them.**
The full activity table, weights and scheduling rules are in
[`behavior/README.md`](src/renderer/src/behavior/README.md) (Chinese).

### Physics (`physics/`)

- **The feet point `motion.feet` is the only position authority**; `petRect` is derived from the size.
- Coordinates are overlay-local CSS pixels (x→right, y→down); gravity is positive downward.
- Handles side walls/floor, landing on window top edges, surface adhesion, smooth drag following and
  throw-velocity estimation. A slow release while over a sittable ledge becomes "place and sit" instead
  of a free fall.

### Desktop sensing (`desktop/`)

Input is a window list in **global screen** logical pixels; output is **overlay-local** coordinates
(`local = global − overlayOrigin`, **never hardcode the 30/24px menu bar**). Surface id convention:

```text
win-<windowId>-top|left|right   menubar   dock-bottom|left|right   screen-bottom
```

Filtering: `layer===0`, `alpha>0.01`, `height>80`, positive-area overlap with the current display,
excluding the pet's own overlay process. A "vanished" window has a 600ms grace period (minimizing or
switching Spaces is not a close); during grace the surface stays but `sittable=false`. The menu-bar
surface exists but is **never a sit/climb target** (`top=0` would render into the viewport).

### Interaction (`interaction/`)

Pure logic (hit regions, drag state machine, circular head-pat detector, gaze smoothing, context-menu
state machine) is strictly separated from the DOM layer (`controller.ts` / `menu-view.ts`). `PointerGate`
decides when clicks pass through and when they are captured; dragging and open menus always capture.

### Rendering (`scene/` + `vrm/`)

- `PetView` is the scene abstraction; `scene/pet-scene.ts` is the legacy PMX implementation,
  `vrm/pet-scene-vrm.ts` is the main path.
- The VRM side includes humanoid retargeting/clip playback, five-layer expression composition (emotion /
  one-shot / expression clip / procedural blink / lip-sync), look-at (with side-localisation), foot-lock
  (planted feet + hips alignment + step convergence), held prop (water gun), screen-space outline,
  upper-chest fold and context-loss recovery.
- Renderer and camera use an orthographic metric projection; textures and VRMs are read through
  `pet-asset://` with a retrying loader.

## IPC and configuration

`src/shared/ipc.ts` is a frozen contract: **14 invoke channels + 4 main→renderer events**.

| Direction | Channels |
|---|---|
| invoke | `pet:get-config`, `pet:set-config`, `pet:screen-info`, `pet:windows`, `pet:set-ignore-mouse`, `pet:window-info`, `pet:accessibility-status`, `pet:open-accessibility-settings`, `pet:move-window`*, `pet:dsh-status`, `pet:notify`*, `pet:show-settings`, `pet:quit`, `pet:set-visible` |
| events | `windows-updated`, `dsh-event`, `config-changed`, `screens-updated` |

`*` two channels are **contract placeholders**: the keys are frozen by `tests/shared-contract.test.ts`
but the main process registers no handler and the renderer never calls them, so invoking rejects with
`No handler registered`. Don't "complete" them for appearance, and don't delete the keys.

Configuration lives in `<userData>/config.json` shaped `{ version, config }`:

- any read error falls back to `DEFAULT_CONFIG` and never blocks startup;
- every input passes through `sanitizeConfig` (clamping, enum whitelists, unknown-key dropping,
  own-property-only reads);
- writes are "merge + sanitize + atomic `rename` from a sibling tmp file".

Main keys: `sizePercent` (10–100, default 50), `opacity` (0.3–1), `clickThrough`, `autonomous`,
`autonomousLevel` (low/normal/high), `mischief`, `dshLink`, `dshCoupling`, `dshBubbleSync`,
`fpsCap` (5–60), `launchAtLogin`, `position` (corner/free), `sound`, `modelBackend`, `animBackend`,
`motionSet`. The settings page is the second renderer entry (`settings.html`); all field math lives in
`settings-model.ts`.

## DSH two-way integration

Four capabilities: **state reactions** (busy/done/error → motion + official lines), **bubble sync**
(thinking → streamed text → 96-char chunks → hold → next), **strong coupling** (mutual keep-alive /
die-together) and a **reserved screen-peek interface** (not wired).

File contract (`~/.dsh/aventurine-pet/`, bridge version `4`):

| File | Writer | Purpose |
|---|---|---|
| `status.json` | bridge, overwritten every 5s heartbeat | `running/agents/lastEventAt/lastType/offline/compat` |
| `control.json` | bridge, only on state change | `action: attached/detached`, `dshPid`, `bridgeVersion` |
| `events.jsonl` | bridge, NDJSON append | `task/start · task/end · task/error · session/event` (5MB rotation, two segments kept) |
| `bridge-error.json` | bridge, only when apply fails | `phase/message` diagnostics |
| `install.json` | activation script | install manifest |

Online rule (consumers must implement exactly this):

```text
online = (offline !== true) && (now >= ts) && (now - ts < 30000)
```

`dsh-event` is broadcast to the renderer **only while online**; tailing polls every 750ms and reopens
after rotation/truncation. `detached` in `control.json` **does not prove DSH exited** (an HMR reload
detaches then re-attaches), so strong coupling has a 1.5s grace: a fresh `attached` inside the window
cancels the exit decision.

Core safety semantics of die-together (`dsh-lifecycle.ts`):

- When the pet explicitly quits, **only a healthy handshake (`PAIRED`)** triggers SIGTERM (SIGKILL after
  ≤5s) for DSH; `UNPAIRED` / `DEGRADED` / `DISABLED` always let DSH live, so DSH can still be opened to
  repair the pet.
- DSH explicitly exits → the pet follows, **never restarting it**; DSH crashes → restart with cooldown,
  ≤2 attempts (5s apart), then stay `DEGRADED` instead of cascading suicide.
- `PAIRED` requires four gates at once: process alive, fresh heartbeat (30s), the latest `control.json`
  frame says attached, and the compatibility check passes. A stale handshake must not enter `PAIRED`
  (otherwise it kills or restarts the wrong thing).
- `~/.dsh/aventurine-pet/safe-mode` (file exists) = coupling off (hot-applied);
  `PET_DSH_COUPLING_DISABLE=1` wins over everything; **unpackaged dev builds need explicit
  `PET_DSH_COUPLING=1`**.

Activate and roll back (HMR, no DSH restart):

```bash
node scripts/activate-dsh-bridge.mjs --pet-app "$PWD/dist/mac-arm64/AventurinePet.app" --dry-run
node scripts/activate-dsh-bridge.mjs --pet-app "$PWD/dist/mac-arm64/AventurinePet.app"
node scripts/activate-dsh-bridge.mjs --rollback   # restore the cordis.patch.yml backup
```

HMR **will not re-evaluate the same module path** (Node ESM cache), so the script writes a new live copy
`work/live-bridge/rev-<ts>/` (keeping the last 5) and verifies `control.json.bridgeVersion`.
Full bridge contract, version guardrails and canary groups are in
[`bridge/.../README.md`](bridge/dsh-aventurine-bridge/README.md); wiring and troubleshooting in
[docs/wave3-dsh-integration-design.md](docs/wave3-dsh-integration-design.md) and
[docs/pet-dsh-coupling-runbook.md](docs/pet-dsh-coupling-runbook.md).

## Assets and motion pipelines

All model/motion data are **private assets** (not in git, distributed separately). The repo builds and
tests without them, but the pet cannot render.

```text
assets/
├── vrm/          # target VRM (manifest currently points at aventurine-tpose.vrm) + canary
├── motions/      # app-manifest.json (40) / app-catalog.json (181); mate/ hsr/ adv/
├── expressions/  # 17 expression clips + manifest (mate 7 / hsr 10)
├── model/        # PMX fallback model and optimized/ (20 textures + 1 PMX copy + manifest)
├── props/        # held props (water gun, etc.)
└── icons/        # tray/app icons (tracked)
```

Pipeline split:

- **Motion**: Unity Humanoid `.anim` sampling (`scripts/unity-bake/`), HSR official FBX full-skeleton
  retargeting (`scripts/vrm/motion/retarget-hsr.mjs`), Adv motion retargeting (`retarget-adv.mjs`);
  finalized into runtime manifests by `build-app-manifest.mjs --check`.
- **Expressions**: Mate face `.anim` parsing + Unity Hermite sampling, HSR face-bone sampling + OMP/NNLS
  decoding, mapped onto the model's own VRM 1.0 presets.
- **VRM conversion**: Blender 4.2 toolchain (VRM Add-on for Blender / MMD Tools); T-pose normalization
  uses VRMify (pure Python, prepared outside the repo). See [vrm-toolchain.md](docs/vrm-toolchain.md)
  and [vrm-tpose-repair.md](docs/vrm-tpose-repair.md).
- **Prop extraction**: 3ds Max scene FBX → single-hand anchor
  (`scripts/props/` + `src/renderer/src/vrm/watergun-attach.json`).

> `src/shared/motion-manifest.json` is an **empty W0-3 placeholder** (private assets are not committed),
> not a bug; the runtime reads `assets/motions/app-manifest.json`.

**Swapping a model or motion set yourself**: skip this repo-specific pipeline and read
[model conversion](docs/guide-model-conversion.en.md), [motion pipelines](docs/guide-motion-conversion.en.md)
and [common pitfalls](docs/guide-asset-pitfalls.en.md).

## Tests and quality gates

- `pnpm test`: 139 files, **2779 passed + 16 skipped** (measured 2026-11-11 with local private assets present). Most skips depend on private
  assets / `tests/tmp` fixtures and are expected on a clean clone; a few are platform/worktree conditions
  (win32, `IS_MAIN_WORKTREE`).
- `pnpm typecheck`: `tsconfig.node` (main/preload/shared) + `tsconfig.web` (renderer/shared); both must pass.
- `pnpm test:coverage`: v8, `src/**` only; thresholds lines/statements/functions 20, branches 15; the two
  bootstrap entries (`src/main/index.ts`, `src/renderer/src/main.ts`) are excluded — they are covered by
  `SMOKE_TEST` / dev capture, not unit tests.
- Contract regressions: `tests/shared-contract.test.ts` (IPC/PetApi key sets) and
  `tests/bridge-plugin.test.ts` (bridge constant parity + apply shape + failure isolation).
- `pnpm smoke`: real windows run API probes, VRM asset loading, pose/foot error, gaze, settings window,
  click-through and geometry refresh, then print `SMOKE_OK {json}`.

## Where to change what

| Goal | Where |
|---|---|
| Add an IPC capability | `src/shared/ipc.ts` (channel + types) → `src/preload/index.ts` (whitelist method) → `src/main/ipc/<domain>.ts` (`ipcMain.handle`); add contract tests |
| Add an autonomous activity | `renderer/src/behavior/activities.ts` (weight/duration/cooldown/needs) + matching `tests/behavior-*.test.ts` |
| Add a motion clip | asset directory + `scripts/vrm/motion/build-app-manifest.mjs --check`; confirm `motionSet` |
| Add a config key | `shared/types.ts` → `shared/config.ts` (default + sanitize) → `settings/settings-model.ts` → settings DOM |
| Change desktop surface rules | `renderer/src/desktop/filter.ts` / `geometry.ts` / `transitions.ts` (pure functions; test first) |
| Change window/multi-display behavior | `main/windows/overlay-manager.ts`; keep packaged resource mapping in sync with `electron-builder.yml` + `docs/packaging.md` |
| Change the bridge file contract | `shared/bridge-schema.ts` **and** `bridge/.../lib/constants.js`, parity tests must pass |
| Tune behavior/pose feel | `window.__aventurineDebug` (`debugTriggerActivity`, `debugSetPose`, `debugSetGaze`), or `PET_DEV_CAPTURE_DIR` for dev screenshots |

## Known limitations (quick list)

Full list in [docs/known-issues.md](docs/known-issues.md). The most likely ones:

- `pet:move-window` / `pet:notify` are contract placeholders with no handler (see the IPC table).
- Packaging is `--mac dir` + ad-hoc signing only; no Developer ID/notarization/dmg, the `.app` must not be
  distributed; the `.icns` icon is missing (one `package:check` warning).
- Launch-at-login is rejected by macOS for an ad-hoc `.app` run from `dist/` (default
  `launchAtLogin=false`, no user-visible effect).
- legacy PMX animation is a static import and lands in the renderer bundle; no size analysis yet
  (tree-shaking effect unknown).
- `onScreen` is currently always true; window closing relies on list presence + a 600ms grace period.
- Screen-peek interaction is types plus a fail-closed stub only: off by default, zero capture, zero TCC,
  not shown in settings.
- The bridge's `status.json` assumes a single writer (multiple DSH instances = last-writer-wins).

## Documentation

> Deep design/acceptance/research documents are currently **Chinese-only**; the guide series above has
> English versions. Titles are kept in their original form.

**Plans and contracts**

- [PLAN.md](PLAN.md) (implementation plan / Wave 0–3)
- [docs/vrm-contract.md](docs/vrm-contract.md) (W0-3 frozen contracts), [docs/reuse-audit.md](docs/reuse-audit.md) (v1 reuse audit)
- [docs/wave2-vrm-runtime-design.md](docs/wave2-vrm-runtime-design.md), [docs/wave3-dsh-integration-design.md](docs/wave3-dsh-integration-design.md)

**Acceptance and baselines**

- [docs/wave0-report.md](docs/wave0-report.md), [docs/wave2-acceptance.md](docs/wave2-acceptance.md),
  [docs/wave3-acceptance.md](docs/wave3-acceptance.md) (includes activation/rollback matrix)
- [docs/wave3-packaging-report-2026-11-11.md](docs/wave3-packaging-report-2026-11-11.md),
  [docs/wave3-e2e-report-2026-11-11.md](docs/wave3-e2e-report-2026-11-11.md),
  [docs/wave3-perf-baseline-2026-11-11.md](docs/wave3-perf-baseline-2026-11-11.md)
- Wave 1.5: [Unity-baked motions](docs/wave15-report.md) / [finger completion](docs/wave15-fingers-report.md),
  [HSR official motions](docs/vrm-motion-hsr.md), [Adv motions](docs/wave4-adv-report.md)

**Assets and format conversion (start here if you don't model)**

- Guides in English: [asset sourcing](docs/guide-asset-sourcing.en.md) ·
  [model conversion](docs/guide-model-conversion.en.md) · [motion pipelines](docs/guide-motion-conversion.en.md) ·
  [common pitfalls](docs/guide-asset-pitfalls.en.md)
- Research notes: [motion-assets](docs/research/motion-assets.md), [mocap-options](docs/research/mocap-options.md),
  [motion-free-pipeline](docs/research/motion-free-pipeline.md), [wave1-15-pitfalls](docs/research/wave1-15-pitfalls.md)
- Conversion details: [max-anim-conversion-plan](docs/max-anim-conversion-plan.md),
  [max-windows-routes](docs/research/max-windows-routes.md), [user-3dsmax-export-guide](docs/user-3dsmax-export-guide.md),
  [unity-bake-report](docs/unity-bake-report.md),
  [female→male joints](docs/research/mate-female-to-male-joint-plan-2026-11-11.md),
  [proportion retargeting](docs/research/proportion-retarget-prototype-2026-11-11.md),
  [male motion tuning](docs/research/wave15-male-motion-tune.md),
  [water gun sourcing](docs/research/watergun-asset-sourcing.md)

**Asset pipeline**

- [docs/vrm-toolchain.md](docs/vrm-toolchain.md), [docs/vrm-tpose-repair.md](docs/vrm-tpose-repair.md),
  [docs/expression-mapping.md](docs/expression-mapping.md), [docs/anim-strategy.md](docs/anim-strategy.md)
- [scripts/vrm/motion/README.md](scripts/vrm/motion/README.md)

**Runtime and operations**

- [docs/packaging.md](docs/packaging.md), [docs/pet-asset-protocol.md](docs/pet-asset-protocol.md),
  [docs/pet-dsh-coupling-runbook.md](docs/pet-dsh-coupling-runbook.md), [docs/known-issues.md](docs/known-issues.md)
- [docs/peek-interface.md](docs/peek-interface.md) (reserved interface list)

**Module notes** (next to the code)

- [behavior](src/renderer/src/behavior/README.md), [physics](src/renderer/src/physics/README.md),
  [desktop](src/renderer/src/desktop/README.md), [interaction](src/renderer/src/interaction/README.md),
  [reactions](src/renderer/src/reactions/README.md), [animation](src/renderer/src/animation/README.md),
  [native/winlist](native/winlist/README.md), [bridge](bridge/dsh-aventurine-bridge/README.md)

**Design and research archive**: [docs/research/](docs/research/), [docs/archive/](docs/archive/)
(includes the v1 PLAN and the historical README)

## Project record

This README replaces the earlier wave-by-wave progress README; the original text is preserved in
[`docs/archive/README-2026-11-11-wave-log.md`](docs/archive/README-2026-11-11-wave-log.md) as the
development record and acceptance index for 2026-11-07 … 2026-11-11 (test-baseline evolution, packaging
status, activation steps and remaining to-dos).
