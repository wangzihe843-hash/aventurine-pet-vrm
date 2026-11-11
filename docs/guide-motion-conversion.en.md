# Four motion pipelines: FBX / .anim / .max / VMD → app-playable clips

> Part of the “Not a modeler? Start here” series in the [English README](../README.en.md).
> Upstream: [model → VRM](guide-model-conversion.en.md) · Asset sources: [where to find them](guide-asset-sourcing.en.md) ·
> Troubleshooting: [common pitfalls](guide-asset-pitfalls.en.md)

[中文版](guide-motion-conversion.md)

## What the target format looks like

The app reads exactly one motion format: `assets/motions/<set>/<clip>.json`. Take `mate-idle`:

```jsonc
{
  "version": 1, "clip": "idle", "mood": "idle", "loop": true,
  "fps": 30, "frames": 74, "duration": 2.433,
  "space": "gltf-rh",                       // coordinate system: right-handed, Y up
  "sourceHeight": 1.66, "sourceHipsHeight": 0.95,   // used to rescale Hips translation to the target height
  "bones": {
    "Hips":        { "r": [ [x,y,z,w], ... ], "p": [ [x,y,z], ... ] },
    "LeftUpperArm":{ "r": [ ... ], "p": [ [0,0,0], ... ] }
  }
}
```

- **`r`**: per-frame quaternion for each humanoid bone (normalized rotation relative to the T-pose rest);
- **`p`**: per-frame translation; **only Hips is non-zero** (horizontal must be in-place, vertical is
  compensated by the player's grounding);
- current sets use **52 bones per clip** (30 of them fingers); the field contract lives in
  [`../src/shared/animation-contract.ts`](../src/shared/animation-contract.ts).

## The pipelines (all of them have run in this repo)

| Source | Pipeline | Entry script | Full docs |
|---|---|---|---|
| Unity `.anim` (Humanoid muscle, e.g. Mate-Engine) | Unity frame-by-frame sampling → normalized JSON | `scripts/unity-bake/convert-clips.mjs` (default `--axis x`; old VRM0 assets need `--axis z`) | [`unity-bake-report.md`](unity-bake-report.md), [`wave15-report.md`](wave15-report.md) (Chinese) |
| Game **FBX** (full skeleton, e.g. HSR's 135 takes) | Blender samples world quaternions → delta retarget against the target rest → grounding | `extract-hsr-anims.py` → `retarget-hsr.mjs` → `validate-hsr-clips.mjs` | [`vrm-motion-hsr.md`](vrm-motion-hsr.md), [`../scripts/vrm/motion/README.md`](../scripts/vrm/motion/README.md) (Chinese) |
| **3ds Max Biped** `.max` | MaxScript batch FBX export → Biped sampling → Biped→VRM mapping → retarget | `scripts/max-export/export_fbx.ms` (Windows) → `run-adv-pipeline.sh` → `retarget-adv.mjs` | [`max-anim-conversion-plan.md`](max-anim-conversion-plan.md), [`research/max-windows-routes.md`](research/max-windows-routes.md), [`user-3dsmax-export-guide.md`](user-3dsmax-export-guide.md) (Chinese) |
| Any humanoid **FBX → VMD** (Mixamo / Rokoko / Plask) | reze-rig browser/CLI retargeting into VMD | `scripts/anim-pipeline/reze/` | [`research/motion-free-pipeline.md`](research/motion-free-pipeline.md), [`research/mocap-options.md`](research/mocap-options.md) (Chinese) |
| Video / webcam | MiPo / Plask and two other pipelines produce motion directly | see docs | [`research/mocap-options.md`](research/mocap-options.md) §4 (Chinese) |

> **VMD only works with the `legacy-pmx` backend.** The VRM backend never loads VMD (`MMDLoader` only
> appears in `src/renderer/src/scene/pet-scene.ts`). To use a VMD on a VRM character, convert it to
> FBX/humanoid first and run it through a retargeting pipeline above.

## Manifest: minimal wiring vs the full pipeline

**Minimal wiring (just a few clips)** — hand-write `assets/motions/app-manifest.json`
(a private generated file, gitignored):

```json
{ "schemaVersion": 1, "clips": [
  { "id": "my-idle", "mood": "idle", "file": "my/idle.json",
    "loop": true, "timeScale": 1, "fadeInSec": 0.15, "fadeOutSec": 0.2,
    "rootMotion": "inPlace", "priority": -10 }
]}
```

**Full pipeline** — `build-app-manifest.mjs` is a *collector*: it requires
`assets/motions/mate/manifest.json` and `hsr/manifest.json` to exist (adv is optional). In other words it
serves this project's multi-source motion sets, not someone with three self-made clips.

```bash
node scripts/vrm/motion/build-app-manifest.mjs           # generate app-manifest + app-catalog
node scripts/vrm/motion/build-app-manifest.mjs --check   # verify disk matches current state (idempotent)
```

Division of labour: `app-manifest.json` holds only mood/salute slots (what plays by default);
`app-catalog.json` lists every clip (including one-shots like hide/intro/pose/skill, played by id from
events or debugging).

## Validation tools

| Tool | Purpose |
|---|---|
| `scripts/unity-bake/lib/validate-clips.mjs`, `scripts/vrm/motion/validate-hsr-clips.mjs`, `validate-adv-clips.mjs` | Data-side PASS/WARN/FAIL: bone set, quaternion normalization, loop seam, grounding residual |
| `scripts/unity-bake/preview-clips.mjs`, `preview-hsr.mjs`, `preview-adv.mjs` | Three views / hand-foot close-ups / contact sheets for eyeball acceptance |
| `scripts/vrm/motion/viewer.html`, `scripts/unity-bake/clip-viewer.html` | Step through a clip frame by frame in a browser |
| `pnpm smoke` | Load every asset in a real window and verify playback doesn't crash |

## Field semantics (easiest to get wrong when editing manifests)

- `mood`: slot name, must be in `PET_MOODS` + `salute`; a typo means the clip is never selected.
- `priority`: ordering among clips in the same slot, **more negative = earlier**; lowering it makes the
  clip win.
- `timeScale`: playback rate multiplier (use 0.4–0.6 to slow a female-body idle that plays too fast).
- `rootMotion: "inPlace"`: horizontal translation is stripped, keeping the motion in place; don't set it
  for clips that actually need to travel.
- `loop`: together with `fadeInSec/fadeOutSec` it decides whether transitions look abrupt.

## Licensing

Motions are private assets like the model: local personal use only, **never redistribute, never ship with
the `.app`**. `assets/motions/**` and anything under `dist/` fall within `.gitignore` or the
do-not-distribute rule.
