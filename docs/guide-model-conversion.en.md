# Three model-to-VRM routes: PMX / FBX / VRM0 → a renderable asset

> Part of the “Not a modeler? Start here” series in the [English README](../README.en.md).
> Upstream: [where to find assets](guide-asset-sourcing.en.md) · Downstream: [motion pipelines](guide-motion-conversion.en.md) ·
> Troubleshooting: [common pitfalls](guide-asset-pitfalls.en.md)

[中文版](guide-model-conversion.md)

The project accepts exactly one model shape: **VRM 1.0 + spec-compliant T-pose + facing +Z / left hand +X**.
You probably start from one of three source formats, each with its own route. Picking the wrong route adds
a constant error on top of *every* motion you play later.

## Route comparison

| Source | Recommended route | Why | Full steps |
|---|---|---|---|
| **PMX (MMD model)** | **VRMify** (pure Python, one command) | Lifts A-pose arms into a spec T-pose, merges weighted helper bones (足D etc.) into their driver bone, converts MMD physics to SpringBone, cleans control bones | [`vrm-tpose-repair.md`](vrm-tpose-repair.md) §2.1 (Chinese) |
| **PMX / FBX / GLB (any DCC)** | **Blender 4.2 LTS + MMD Tools + VRM Add-on 4.10.4** | Controllable and scriptable headless; lets you bind humanoid, add springs, fix materials by hand | [`vrm-toolchain.md`](vrm-toolchain.md) §6 (script skeleton); prop baking example [`research/watergun-bake-vrm.md`](research/watergun-bake-vrm.md) (both Chinese) |
| **VRM 0.x / an already-converted VRM** | **Re-export with the Blender VRM Add-on** + runtime `rotateVRM0` fallback | VRM 0 vs 1 is decided by the armature's `spec_version`, not by an export flag | [`vrm-toolchain.md`](vrm-toolchain.md) §4.7; manifest example [`../src/shared/vrm-manifest.json`](../src/shared/vrm-manifest.json) (Chinese doc) |

### Route 1: PMX → VRM (VRMify)

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/JiGuang283/VRMify.git /tmp/vrmify
python3 /tmp/vrmify/convert/pmx2vrm.py "assets/model/your-model.pmx" \
  -o "assets/vrm/your-model.vrm" --spec 1.0 --scale <factor> \
  --title "Character name" --author "original author / local conversion"
```

`--scale` converts PMX units to meters (this project used `0.0799777`). If unsure, measure the source
height in Blender and compute `target height / source-unit height`. VRMify levels A-pose arms into a
T-pose by default, which is exactly what we want.

### Route 2: Blender (controllable, also handles FBX/GLB)

```bash
# one-time: install the VRM Add-on (idempotent, pinned version + sha256)
scripts/vrm/install-vrm-addon.sh

# headless import → bind humanoid / spring / expressions → export (skeleton in vrm-toolchain §6.2)
BL="/path/to/Blender.app/Contents/MacOS/Blender"
"$BL" --background --factory-startup --python scripts/vrm/export-dummy-vrm.py   # verify the environment
```

Key points: PMX needs the **MMD Tools** extension before it can be imported; a VRM 1.0 export requires the
mandatory humanoid bones, a T-pose, and minimum expression/material requirements (`vrm-toolchain.md` §4.8
lists them one by one).

### Route 3: VRM 0.x → spec VRM 1.0

In Blender, change the armature's `spec_version` to `1.0`, re-export, and fill in the VRM 1.0 required
fields. The runtime also has a fallback: `avatar-loader.ts` calls `VRMUtils.rotateVRM0` for 0.x assets and
expressions go through three-vrm's v0compat normalization (`joy→happy`, `blink_l→blinkLeft`, etc.).
The canary uniform model is a ready-made sample of this **runtime fallback** path.

## Two gates every conversion must pass

1. **T-pose compliance**: arms horizontal along X, palms facing -Y, fingers straight, thumb 45° between
   X and +Z. An A-pose (arms angled down) adds a **constant offset** to the whole arm during playback
   (measured on the old asset: 39.6°); the symptom is “hands clip into the body when close, arm-extended
   motions look fine”.
2. **Orientation / handedness**: VRM 1.0 faces +Z with the left hand on +X. This also decides whether
   motion data needs `--axis x` or `--axis z`; the symptom of choosing wrong is a **left-right mirror**
   (idle raises both hands over the head).

Self-check without knowing bone math:
- play `idle`; if arms sink into the torso, the T-pose was never lifted;
- if the character faces away from the camera, orientation is wrong — fix the model or set
  `yawOffsetDeg` in the manifest;
- if motions are mirrored, handedness is wrong — go back and check the `--axis` flag in the motion pipeline.

> **Not having `upperChest` is the norm** for target models (VRMify output included). The player folds
> `UpperChest` tracks into `chest`, so you don't need to add a bone just to “have them all”.

## Wire it into the app (two edits)

1. Put the `.vrm` into `assets/vrm/` (subdirectories are fine).
2. Add an entry to [`../src/shared/vrm-manifest.json`](../src/shared/vrm-manifest.json) and point
   `defaultAvatarId` at it:

| Field | Meaning |
|---|---|
| `id` | Internal identifier used by motion manifests and debugging |
| `file` | Path **relative to the `assets/` root**, e.g. `vrm/your-model.vrm` (served over `pet-asset://`) |
| `specVersion` | `"1.0"` or `"0.x"` |
| `heightMeters` | Drives grounding and scale; wrong values float or sink the pet |
| `expressions` | Business name → the model's own VRM expression name; missing presets fall back |
| `lookAt` | `mode` (`vrm`/`procedural`/`none`) plus yaw/pitch limits |
| `yawOffsetDeg` | Orientation correction (180 means “turn around”) |
| `springChains` | Hair/cloth chain count, recorded only |

## Validation

```bash
# three views + diagnostics (launches Electron to capture; evidence lands in tests/tmp)
node scripts/vrm/capture-vrm.mjs --vrm assets/vrm/your-model.vrm --tag mymodel \
  --views front,side,threeQuarter

# validate existing artifacts only, no window (CI / re-runs)
node scripts/vrm/capture-vrm.mjs --vrm assets/vrm/your-model.vrm --tag mymodel --check

# end to end: real window + assets + bridge
pnpm smoke
```

## Common failures

| Symptom | Likely cause | Where to look |
|---|---|---|
| Model all black / materials grey | MToon materials not converted, wrong texture `alphaMode` | [`vrm-toolchain.md`](vrm-toolchain.md) §4.8; [`known-issues.md`](known-issues.md) (Chinese) |
| Missing textures / garbled | Texture path case, files not shipped, `pet-asset://` root confinement | [`pet-asset-protocol.md`](pet-asset-protocol.md) (Chinese) |
| Floating / sinking / wrong size | `heightMeters` doesn't match reality, bad `--scale` | [`vrm-tpose-repair.md`](vrm-tpose-repair.md) §2.1 (Chinese) |
| Facing away from the camera | Source model faces -Z (old VRM0 style) | “Two gates” above |
| Arms clip through the chest | Rest pose isn't a T-pose | “Two gates” above; [`guide-asset-pitfalls.en.md`](guide-asset-pitfalls.en.md) |
