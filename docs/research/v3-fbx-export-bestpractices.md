# V3 — 3ds Max Biped → FBX batch export: best practices and pitfalls

**Scope.** Research note for the 138-file, 3ds Max 2027.2 + Biped → FBX batch (Windows) feeding a macOS/Blender sampling + VRM retargeting pipeline. Web research only (Autodesk docs, FBX SDK reference, community); local facts from the 6-scene/12-FBX pilot are marked **[local]** and were not re-researched.

**Status.** Research note, not an implementation spec. Several recommendations call for a pilot on one scene before the full batch.

**Evidence grading.** `official` = Autodesk help / FBX SDK reference; `official-legacy` = Autodesk help archived for 2012 but still the most explicit text on the topic; `community` = forum / OSS commit / vendor doc; `inference` = derived from documented facts or local observations, no direct source.

---

## 0. Bottom line

1. **Bake range is the #1 correctness risk, not Biped support.** `BakeFrameStart/End/Step` are *integer* script parameters, are *not saved in presets*, and default to the scene timeline. Always set them explicitly, read them back, and log the raw timeline ticks plus the effective integers.
2. **A fractional end (`0–83.5`) has no documented rounding rule.** The honest engineering answer is: pick a policy (`P = round(end − start)`; if the end is fractional bake `P` keys from `start`, if it is integral bake `start..end` inclusive), prove it with an A/B pilot on `StandBy`, and optionally resample at 2× fps (60 fps, `0..167`) to keep the exact `2.7833 s` duration.
3. **Native Biped export without `Bip2FBX` is expected to have per-file node rest transforms.** FBX skin binding lives in the skin clusters / bind pose, not in the node static transforms. Sampling absolute armature-space poses and using a separate `Tpose` FBX as the canonical rest is the right design; keep it.
4. **Re-import self-checks are only trustworthy if key reduction is disabled.** By default the importer may resample and apply the Constant Key Reducer; Autodesk explicitly documents that this removes keys at the end of the animation. `PostSamplingKeyReducer=false`, `Resampling=1`, `TakeIndex=1` are mandatory for verification.
5. **138 files: one `3dsmaxbatch.exe` process per file, hard timeout, retry once, quarantine.** Max can run out of memory over long batches (community: restart every ~20 files; one session per file). Turn on `-log`, `-listenerlog`, `-dm on`, and report status through `quitMAX exitCode:`.

---

## 1. Findings

### 1.1 Bake animation, frame range, and what is actually documented

Autodesk's export documentation is explicit that **Biped is resampled into animation curves through the Bake Animation path**:

> "When you activate this option all unsupported constraints and controllers, including the 3ds Max Biped, are resampled into animation curves."
> — Autodesk, *Animation* (3ds Max FBX export), 2019 help
> <https://help.autodesk.com/cloudhelp/2019/ENU/3DSMax-Data-Exchange/files/GUID-31EA2A4F-A126-498B-96E8-31811522738A.htm>

The same page defines how Start/End are chosen and the one trap that matters for a 138-file batch:

> "The plug-in takes the Start and End values automatically from the 'timeline' current settings of the host application."
> "Bake Animation Start/End/Step values cannot be saved in presets. The 3ds Max FBX plug-in always derives these values from the scene being exported."

A legacy page makes the inclusive convention concrete:

> "For example, if the animation in the scene is 102 frames long, the Start value will be 1, the End value will be 102, and the Step value will be 1, regardless of what values you may have stored in the preset for this setting."
> — Autodesk, *Preset Bake Animation settings* (2012 help)
> <https://download.autodesk.com/us/3DSmax/2012help/files/GUID-BE1E8432-5ACC-4B89-B058-73B9BF2DC78-2799.htm>

So for a whole-frame range `S..E` with `Step=1`, keys are at `S, S+1, …, E` → `E − S + 1` keys. This matches the pilot's 85 keys for an 85-frame clip.

The script API exposes the range as integers (the MAXScript table lists `BakeFrameStart`, `BakeFrameEnd`, and `BakeFrameStep`, each with value type "Integer value."):
— Autodesk, *FBX Export Dialog Access* (MAXScript), 2024 help, <https://help.autodesk.com/cloudhelp/2024/ENU/MAXScript-Tools-and-Interaction/Interacting-with-the-3ds-Max/FBX-Import-and-Export-Dialog/GUID-54B1F140-B304-48A2-9829-C68B345E2044.html>

Two more range facts from official docs:

- Animation controllers with an undefined time range are silently clamped to the scene interval: *"if the plug-in detects that an animation controller has an undefined time range, it automatically adjusts it to use the scene animation interval."* — *Animation controllers* (2012 help), <https://download.autodesk.com/us/3DSmax/2012help/files/GUID-819E165C-BBA6-4452-AEF0-7AD6E888D0B-2798.htm>
- `Resample All` samples at the host frame rate: *"The Resample all option resamples animation using the frame rate of the host application."* — *Resample all*, <https://download.autodesk.com/us/fbx/20112/3dsmax/files/WS73099cc142f487554b4b33fa12487091099-68c2.htm>

There is **no documented "Use Scene FPS" toggle** in the 3ds Max FBX exporter among the options reviewed. The fps is the scene's fps; `Resample All` uses it. Treat "export uses scene fps" as the model, and set the scene fps explicitly before every export.

### 1.2 The fractional end frame (0–83.5)

3ds Max time is tick-based and can represent fractional frames exactly:

> "Resolution is in ticks, with 4800 ticks per second. … numbers are always interpreted as frame counts, with floating point numbers specifying fractional frames. The numbers are always converted to tick-based time values internally…"
> — Autodesk, *Time Values* (MAXScript), 2016 help
> <https://help.autodesk.com/cloudhelp/2016/ENU/MAXScript-Help/files/GUID-51429B01-2FC6-4746-9E88-5EB5D93056CC.htm>

At 30 fps, `83.5` frames = `13,360` ticks = `2.78333… s`. But the bake parameters are integers, and **no Autodesk page states whether a fractional timeline end is floored, rounded, or ceiled**. Passing `83.5` into `FbxExporterSetParam "BakeFrameEnd"` may coerce in MAXScript before it ever reaches the plugin, and MAXScript only documents that number types are freely converted "as necessary" (no rounding rule):
<https://help.autodesk.com/cloudhelp/2015/ENU/MAXScript-Help/files/GUID-B57EA575-DCDE-42F5-9D30-88E3EB41F350.htm>

Consequences for this project:

| Option | Bake | Keys | Effective loop period | Error vs 2.78333 s |
|---|---|---|---|---|
| Floor | `0..83` | 84 | 84 frames @30 | +0.0167 s (+0.60 %) |
| Ceil / round-half-up | `0..84` | 85 | 85 frames, or 84 if last is a duplicate | +0.05 s (+1.8 %) if counted as 85; +0.0167 s if duplicate trimmed |
| 2× fps resample (pilot) | 60 fps `0..167` (or `0..166` for loops) | 168 / 167 | 167 frames @60 | exact |

The 2× option is defensible because 3ds Max keys are stored in ticks (absolute time): changing fps changes the frame *numbering*, not the absolute times of existing keys, and `Resample All` then samples at 60 Hz. It must still be piloted: Biped, the FBX exporter's timing, and any constraints may react to `frameRate`.

**Loop arithmetic.** If a clip is a closed loop, the clean model is: period `P` frames, keys at `0..P−1`, wrap at `P`. If the authored end is `83.5`, `P = round(83.5) = 84`; bake `0..83` (84 keys). Baking `0..84` gives 85 keys and, if frame 84 repeats frame 0, a 1-frame (33 ms) hold per cycle depending on the player. For a one-shot clip with a fractional end, the same `P`-key rule avoids sampling past the authored end; only an integral end should be baked inclusively (`0..E`). This is pipeline convention, not an Autodesk rule.

### 1.3 Loop closure and the duplicated last frame

**No official Autodesk guidance was found** on excluding a duplicated final frame from a loop bake. The closest official statement is the opposite kind of warning — Autodesk's Constant Key Reducer can delete end keys on export:

> "If you are missing keyframes at the end of your animation in an exported FBX file, they may have been cleaned by the 3ds Max FBX plug-in Constant Key Reducer filter. When this filter is enabled, the plug-in removes any consecutive keys that have the same value."
> — Autodesk, *Where did my constant keys go?* (2012 help)
> <https://download.autodesk.com/us/3DSmax/2012help/files/GUID-117BB3DD-98F0-4D9A-AC8F-DEEF04C90BA-2793.htm>

Practical rule for this pipeline:

- Detect closure by comparing the sampled pose at `start` and at the intended wrap frame (or at `end` after bake); if `max |Δ| < ε`, mark `loop=true`.
- For loops, ship `P` keys (`start .. start+P−1`) and store `periodFrames=P`, `durationSeconds=(rawEnd−rawStart)/fps`.
- Do **not** rely on first-pose == last-pose to infer a loop downstream; store it as metadata. A one-shot clip can legitimately start and end near the same pose.

### 1.4 30 vs 60 fps: how FBX stores key timing

FBX animation key times are `FbxTime` values, and `FbxTime` is an absolute time class used by all animation classes:

> "FbxTime can measure time in hour, minute, second, frame, field, residual… currently, it is used in FbxGlobalSettings, FbxGlobalTimeSettings, FbxCache, all curve filters and all animation-related classes."
> — Autodesk, *FbxTime Class Reference*
> <https://help.autodesk.com/cloudhelp/2018/ENU/FBX-Developer-Help/cpp_ref/class_fbx_time.html>

The internal unit is a 64-bit tick count; one second is `46,186,158,000` ticks (`FBXSDK_TC_MILLISECOND 46186158 × 1000`):
<https://help.autodesk.com/cloudhelp/2018/ENU/FBX-Developer-Help/cpp_ref/fbxtimecode_8h_source.html>

Therefore:

- 30 fps key spacing = `1,539,538,600` ticks; 60 fps = `769,769,300` ticks.
- Key times are absolute and fps-independent. The file separately carries a time mode / frame rate (`FbxTime::eFrames30`, `eFrames60`, … in the SDK; the class lists both modes).
- Consequence: importing a 60 fps clip into a 30 fps scene, or sampling it at 30 fps, **decimates** it; importing a 30 fps clip into a 60 fps scene duplicates/interpolates keys. A mixed-fps batch is fine only if per-clip fps is carried in the manifest and the consumer is told which fps to use.
- 3ds Max's own importer exposes `KeepFrameRate` and `Resampling`, which is the official acknowledgement that file fps vs scene fps is a real conversion step: <https://help.autodesk.com/cloudhelp/2024/ENU/MAXScript-Tools-and-Interaction/Interacting-with-the-3ds-Max/FBX-Import-and-Export-Dialog/GUID-77CE3E5A-7AB1-4048-BD80-B127E0231FFA.html>

### 1.5 Rest / bind pose when exporting Biped without `Bip2Fbx`

**What FBX guarantees.** The bind pose is a separate data block, not the node's current local transform:

> "The Bind Pose holds the transformation (translation, rotation and scaling) matrix of all the nodes implied in a link deformation. This includes the geometry being deformed, the links deforming the geometry, and recursively all the ancestors nodes of the link. The Bind Pose gives you the transformation of the nodes at the moment of the binding operation when no deformation occurs."
> "In 'Bind Pose' mode, the matrix is assumed to be defined in the global space…"
> — Autodesk, *FbxPose Class Reference*
> <https://help.autodesk.com/cloudhelp/2018/ENU/FBX-Developer-Help/cpp_ref/class_fbx_pose.html>

Skinning is driven by clusters, whose link node is the bone node:

> "The cluster's link node specifies the node (FbxNode) that influences the control points of the cluster. If the node is animated, the control points will move accordingly."
> — Autodesk, *FbxCluster Class Reference*
> <https://help.autodesk.com/cloudhelp/2018/ENU/FBX-Developer-Help/cpp_ref/class_fbx_cluster.html>

A node has static `Lcl Translation/Rotation/Scaling` properties plus animation curves connected to those properties; at a given time the curves drive the property values, and the skin deformer uses the bind data to compute deformation. So a consumer that builds a rest skeleton from the static node transforms is using a different data path than the one that deforms the mesh.

**Why per-file rest is normal for native Biped export.** 3ds Max Biped is a controller-driven rig; without `Bip2FBX` conversion, and with Bake Animation on, the FBX contains bone nodes plus baked curves. The exporter writes node static transforms from the scene state at export; the skin/Physique modifier carries the actual bind. This explains the pilot observation **[local]**: per-bone node local transforms differ per file and look like the scene pose at export, while skinned meshes still deform correctly.

No Autodesk page was found that documents this Biped-specific behavior; it is an inference from FBX semantics plus the 6-file pilot. Confidence: high that bind data is separate from node transforms; medium-high that the exporter writes the current scene pose (needs the slider-position experiment in §5 Q2). Autodesk forum threads on "Biped FBX bind pose" were not retrievable during this research (HTTP 403), so community evidence is limited to the FBX SDK reference, the Godot bind-pose change, and the Chinese exporter article below.

**`Bip2FBX`.** It is a real but legacy/undocumented exporter flag, present only in the old parameter table as `Bip2FBX | True or false`, with no description:
<https://download.autodesk.com/us/fbx/3dsMax_online/files/WS644c7983f449f2df-53d205c5113e574e97c-8000.htm>

In this pipeline `true` was verified to drop all baked Biped curves **[local]**, so it is a hard exclusion, not a rest-pose fix. Its original intended role is not documented in public help; likely a MotionBuilder-era "convert Biped to plain FBX skeleton" switch. Treat it as poison until proven otherwise.

**Canonical rest for consumers.** Biped's own rest pose is Figure Mode:

> "Use Figure mode to change the biped structure in its rest pose."
> "Define the default pose of the biped before animation is applied to it…"
> — Autodesk, *Posing the Biped* (2012 help)
> <https://download.autodesk.com/us/3DSmax/2012help/files/GUID-7DB3BD2D-C14E-4E23-834D-23B4B7115E5-1443.htm>

So a canonical bind FBX can be produced per character by entering Figure Mode, setting the scene to the bind pose, and exporting with `Animation=false` (skeleton/mesh only). Whether the exported node transforms then equal the Figure Mode pose must be verified against the `Tpose` FBX.

A downstream caveat worth knowing: Godot moved from FBX `Pose` objects to skin-cluster bind matrices because Pose data is unreliable, and notes the root bone limitation:

> "Turns out that the information in FBX Pose objects is relatively often broken. Using skin cluster bind poses seems more reliable, but cannot capture the bind pose of the root bone."
> — Godot commit `0955690`, *Resolve bind poses from FBX clusters instead of FBX poses*
> <https://github.com/godotengine/godot/commit/095569011c6afd7baab44fac0a8a1850af3217e3>

That is consistent with keeping an explicit `Tpose` FBX as the canonical rest reference rather than trusting any single file's node rest or Pose element.

**Physique vs Skin nuance [community, Chinese].** A 2009 exporter article explains that Physique exposes an explicit Init Pose (`GetOffsetVector`, `GetBoneInitTM`), while Skin only exposes frame 0 geometry and derives the init pose from bone matrices. This is the same conceptual split: the modifier, not the exported node transform, defines binding.
<https://www.gameres.com/forum/t/139938>

### 1.6 Self-check by re-import: what is documented and what bites

Useful official facts:

- Default take name is `Take 001` unless `UseSceneName` is enabled: *"Normally, the 3ds Max FBX plug-in saves the 3ds Max scene animation in the FBX file as Take 001."* — export Animation page (2019), URL above.
- The importer handles **one take at a time**: *"You can only select and import a single take of animation at a time."* — *Animation Take* (2012 help), <https://download.autodesk.com/us/3DSmax/2012help/files/GUID-E189734A-DAC8-4924-9761-6F0A8B6D6FF-2731.htm>
- `FillTimeline` sets the scene range from the file's first/last keys: *"The term 'Animation range' refers to the first and last keys of animation contained in the file."* — *Fill timeline* (2012 help), <https://download.autodesk.com/us/3DSmax/2012help/files/GUID-A8AE05FF-BAF7-4302-977D-B5C90E556A5-2732.htm>
- Import key reduction is **on by default** and can lose subtle data: *"By default this setting is true… can in some situations result in the loss of information… Setting this option to False turns off the post-sampling key reducer, preserving all position, rotation and scaling animation keys."* — `PostSamplingKeyReducer`, import dialog page above.
- Re-import may also resample and auto-apply the Constant Key Reducer, which can remove end keys:
  *"During import, the plug-in may resample some animation curves. If this resampling occurs, the 3ds Max FBX plug-in automatically applies the Constant Key Reducer filter…"* — *Where did my constant keys go?* URL above.

Pitfalls specific to this pipeline:

1. **Key count mismatch is usually the checker, not the exporter.** With reducer on, a perfectly good 85-key clip can come back with fewer keys, especially at the end.
2. **+1 frame in Blender** is a numbering convention (frame 1 = time 0), not a bake error. Normalize when comparing; verify time in seconds.
3. **Imported "bones" are not Biped.** FBX import creates bones/dummies (`ImportBoneAsDummy` option exists); do not compare controller types, and count by hierarchy/name.
4. **Axis/scale conversions** can change absolute transforms. Check relative/hierarchical poses or set `ConvertUnit`/`UpAxis` identically on export and import.
5. **Take names.** `Take 001` is expected; if `UseSceneName` is enabled, expect the scene name instead. Import `TakeIndex=1`.
6. **`FillTimeline` masks offsets** by resetting the scene range; compare key times explicitly, not just the timeline display.

### 1.7 Batch reliability (138 files)

Official 3ds Max Batch facts:

- `-dm on` watches for plugin dialogs and closes them; `-log` is the session log; `-listenerlog` is the Listener log; `-v 0..5` sets batch verbosity; `-sceneFile` loads a scene; `loadMaxFile()` gives control over missing plugins.
  *"Dialog Monitor state. When on, the dialog monitor watches for dialogs from plug-ins, and closes them."*
  *"We recommend you always turn on the Listener Log…"*
  — Autodesk, *Using 3ds Max Batch*
  <https://help.autodesk.com/cloudhelp/2024/ENU/3DSMax-Batch/files/GUID-48A78515-C24B-4E46-AC5F-884FBCF40D59.htm>

- Exit codes are documented: `0` success, `-100` bad arguments, `-110` Max cannot start, `-120` communication failure, `-130` Max reported an error, plus `-1..-9` crash/OOM/license codes. `quitMAX exitCode:` passes a user code; negative codes print only at `-v 5`.
  Same page, plus *Exiting and Resetting 3ds Max*:
  <https://help.autodesk.com/cloudhelp/2024/ENU/MAXScript-Tools-and-Interaction/Miscellaneous-Functions/GUID-92E4150E-0AD4-430C-A852-783A45276D23.html>

- `resetMaxFile #noPrompt` and `clearUndoBuffer()` / `setSaveRequired false` exist specifically for batch scripts (same page).

- `loadMaxFile` supports `quiet:true`, `allowPrompts:false` (default false), and `missingDLLsAction: #logmsg`, `missingExtFilesAction: #logmsg`, `missingXRefsAction: #logmsg`; `exportFile` supports `selectedOnly:true`.
  — Autodesk, *3ds Max File Loading and Saving*
  <https://help.autodesk.com/cloudhelp/2024/ENU/MAXScript-Tools-and-Interaction/File-Access/3ds-Max-Scene-Files-Access/GUID-624D3D05-B15D-4A97-9F15-DA35CDB0DDD2.html>

Community experience (2010, still representative):

> "Max sometimes just gets 'tired' and needs a restart - I've made our batch export process to quit after exporting 20 times just to be sure."
> "Yes, Max can easily run out of memory. We ended up creating a .NET system for this that will open up a session of Max for each file. It has a fuse on the process, and will kill it after the fuse winds down. Any files it got hung up on are logged (along with errors if possible), skipped, and then re-tried at the end…"
> — Tech-Artists.Org, *3DS Max Batch processing help*
> <https://www.tech-artists.org/t/3ds-max-batch-processing-help/1018>

Also relevant: Biped animation **layers**. Autodesk's own troubleshooting says bake is required to get all layers, otherwise only the top layer exports:

> "As long as you are at the uppermost (top) layer, and use the Bake animation option in the FBX exporter, you can export all animation from the top down on the layers that reside beneath the top layer."
> "If you do not activate Bake Animation, only the top layer of animation is exported."
> "Tip: You can also avoid this problem by collapsing all your layers into one before export."
> — Autodesk, *Where are my animation layers?* (2012 help)
> <https://download.autodesk.com/us/3DSmax/2012help/files/GUID-21B5781D-5D3D-40E7-8620-587BEC650C5-2790.htm>

If any of the 138 scenes uses Biped layers, `BakeAnimation=true` (already in the recipe) is what saves you; verify key counts on those files specifically.

### 1.8 Slimming (skeleton-only)

Official options:

- **`ExportAnimationOnly`** — script-only, no UI, 2019.1+:
  *"ExportAnimationOnly | True or False. This parameter is exposed only in MAXScript, it does not appear on the UI. Available in 3ds Max 2019.1 Update and higher."*
  — FBX export dialog page (2024), URL above. Semantics (mesh suppressed? bones kept?) are **not documented**; verify bone count and key count on one pilot.
- **`selectedOnly:true`** — *"If the selectedOnly keyword parameter is set to true, only selected nodes are exported."* — *3ds Max File Loading and Saving*, URL above. This is the riskiest option: non-selected parents/skin bones/helpers are simply not exported, and skin clusters reference bone nodes. If used, select the full Biped hierarchy (root + all 65 bones), not just the root, then assert 65 bones and `P` keys.
- **In-memory delete of meshes, then export all** is the safest "skeleton only" route: load read-only, delete mesh objects (never save), keep the Biped, export. It avoids selection-dependency surprises; the risk is deleting a node class that includes bones, so filter by "has a Skin/Physique modifier" or by explicit Biped hierarchy membership.
- A third-party exporter documents the same concepts (`TimeSegment #Active`, integer `StartFrame`/`EndFrame`, `SubSamples`) and states that the native exporter does not support stretched bones — useful as a sanity check, not as an Autodesk source:
  <https://smartanim.com/documentation/maxscript/fbx.php>

---

## 2. (a) Numbered practical recommendations

Each recommendation is followed by its rationale. "Pilot" means: prove it on one scene before the batch.

### A. Frame range, loops, fps

**R1. Define a per-file export contract and log the raw timeline before conversion.**
Read `animationRange.start.ticks`, `.end.ticks`, `.start.frame`, `.end.frame` (floats) and the scene `frameRate`; record them in the manifest. *Rationale:* `BakeFrameStart/End` are integers and the plugin's default is "whatever the timeline says"; without the raw values you cannot explain a key-count discrepancy later.

**R2. Set `BakeFrameStart`, `BakeFrameEnd`, `BakeFrameStep` explicitly on every file, after `ResetExport`, then read them back.**
Use `FbxExporterGetParam` to confirm the stored integers; do not trust that `83.5` became `83` or `84`. *Rationale:* presets cannot store bake range, and the coercion rule for a float passed to an integer parameter is undocumented (see Q1). Explicit + read-back converts an unknown into a logged fact.

**R3. Normalize fractional ranges with an explicit policy.**
Recommended default: if `end` is integral, bake `start..end` inclusive (`end−start+1` keys, the FBX default convention). If `end` is fractional, compute `P = round(end − start)` and bake `start..start+P−1` (`P` keys) — this is the nearest whole-frame period and never samples beyond the authored end. Record `durationSeconds = (rawEnd − rawStart)/fps`; let loop-closure detection (R8) decide `periodFrames`. *Rationale:* whole-frame sampling cannot represent `83.5`; `P=84` is the nearest whole-frame period, avoids a duplicate endpoint for loops, and (for `83.5`) gives a ≤0.6 % duration error.

**R4. Pilot the `StandBy` 83.5 case as an A/B, not a guess.**
Export three variants: (a) `BakeFrameEnd=83`, (b) `BakeFrameEnd=84`, (c) bake range left at the scene default (to observe the exporter's own rounding). Compare key counts per animated bone, the pose delta between the last key and the intended wrap pose, and the loop seam in Blender. Choose per clip type (loop vs one-shot) and record the decision. *Rationale:* this is the only way to learn what the exporter actually does with the fractional timeline, since Autodesk does not document it.

**R5. If exact duration matters, pilot a 2× fps resample for the fractional clip.**
Set scene fps to 60 (3ds Max keys are tick-based, so absolute times of existing keys are preserved), bake `0..167` (one-shot) or `0..166` (period 167) at step 1, **export while the scene is still at 60 fps** so the file carries 60 fps metadata, then restore the scene fps. *Rationale:* `83.5 × 2 = 167` makes the half-frame an integer frame and preserves `2.78333 s` exactly; `Resample All` will sample at the host rate. Must be piloted because Biped/FBX timing may react to the fps change.

**R6. Keep `BakeFrameStep=1` for game clips.**
Do not use step 2+ to "thin" clips. *Rationale:* downstream sampling and loop math assume per-frame keys; step >1 turns frame counts into multiples and complicates retiming. (Sketchfab's community guide even suggests raising Step to fix a baking "vibration" bug — do not adopt that here without evidence.)

**R7. Turn off every key reducer/remover for the archive export.**
`FilterKeyReducer=false`, `Removesinglekeys=false`, and do not enable the Constant Key Reducer filter. *Rationale:* Autodesk documents that the Constant Key Reducer removes consecutive equal keys and can remove keys at the end of the animation; for a 1:1 bake you want dense linear keys.

**R8. Add loop metadata and trim duplicate endpoints by policy.**
Detect first/last pose equality (ε), store `loop=true`, `periodFrames`, `durationSeconds`; ship `P` keys for loops rather than `P+1` with a duplicate. *Rationale:* a duplicated final key gives a 1-frame hold per cycle in players that include both endpoints; and downstream should not have to guess loop-ness from poses.

**R9. Carry per-file fps through the whole pipeline; never mix 30 and 60 fps clips in one Blender scene without an explicit conversion.**
Record source fps and target sampling fps; if the target is 30 fps, resample 60 fps clips deliberately and log the decimation. *Rationale:* FBX key times are absolute ticks; consumer frame indices depend on the scene fps. `Resample All` uses the host fps, and 3ds Max's importer exposes `KeepFrameRate` precisely because this conversion is lossy.

### B. Rest / bind pose

**R10. Keep sampling absolute armature-space pose matrices; never use a per-file node rest as the canonical rest.**
*Rationale:* the FBX bind pose/cluster data is the deformation source; node static transforms are a separate, exporter-state-dependent representation. The 6-file pilot already showed per-file rest with correct deformation.

**R11. Keep the `Tpose` FBX as the canonical rest reference and validate it against every file's skeleton.**
Check 65 bone names/order, parent hierarchy, and rest matrix hash; reject a file whose skeleton does not match. *Rationale:* Godot's bind-pose work shows Pose data can be unreliable and cluster bind poses cannot recover the root bone; an explicit rest asset covers both gaps.

**R12. If a consumer genuinely needs a per-file canonical bind pose, generate a separate bind FBX — do not mutate the animation FBX.**
Enter Biped Figure Mode (official rest pose), set the scene to the bind state, export with `Animation=false` (and skins as needed), then compare its bone matrices with the `Tpose` FBX. *Rationale:* isolates bind from animation, avoids `Bip2FBX`, and gives a verifiable artifact.

**R13. Hard-code `Bip2FBX=false` (absent) and add a regression check after every 3ds Max/FBX plugin update.**
Export one known clip with and without it and compare curve counts. *Rationale:* the flag is undocumented, and `true` silently dropped all baked Biped curves in this pipeline; it is the highest-severity poison parameter found so far.

**R14. Document for downstream: use bind pose / cluster matrices for skinning, and the explicit rest asset for retargeting.**
If Blender builds bone rest from node transforms, treat that rest as per-file scaffolding and rely on absolute pose sampling; do not compare raw `matrix_local` across files. *Rationale:* `FbxPose` stores global bind matrices, and `FbxCluster` links bones to points; node transforms are not the bind.

**R15. Optionally inspect one FBX at the data level (ASCII export or a parser) for `Pose`/`BindPose` and cluster `TransformLink` matrices.**
Record presence/absence and counts in the manifest. *Rationale:* cheap, no DCC required, and it converts the "native Biped export" assumption into evidence.

### C. 138-file batch orchestration

**R16. Run one `3dsmaxbatch.exe` process per `.max` file, with a hard timeout and process-tree kill.**
Retry failures once in a fresh process; quarantine after two failures. *Rationale:* Max can run out of memory or hang on a single bad scene; process isolation prevents one file from poisoning the remaining 137 (community practice: one session per file + fuse).

**R17. Always run with `-log`, `-listenerlog`, `-dm on`, and `-v 5`.**
Use `quitMAX quiet:true exitCode:<n>` to report per-file status; parse both the exit code and the listener log. *Rationale:* `-dm on` closes plugin dialogs (missing Corona/V-Ray, missing maps), `-listenerlog` is the only place your `format`/`print` output lands, and negative exit codes distinguish OOM/crash from a script error.

**R18. Load with `loadMaxFile ... quiet:true allowPrompts:false missingDLLsAction:#logmsg missingExtFilesAction:#logmsg missingXRefsAction:#logmsg`, or use `-sceneFile` and parse its console output.**
Never save the source scene; never allow a "Save changes?" prompt. *Rationale:* official batch guidance says this is how you react to missing plugins/xrefs; `-sceneFile` prints the same information but gives the script less control.

**R19. If you must reuse a process, call `resetMaxFile #noPrompt` between files, clear undo, and clear the save flag.**
`resetMaxFile #noPrompt`, `clearUndoBuffer()`, `setSaveRequired false`. *Rationale:* avoids memory growth from undo/scene state and prevents prompts on quit; official batch docs provide these for exactly this use.

**R20. Write outputs atomically and record a manifest per file.**
Temp file → rename; record source path, fps, raw ticks/floats, effective bake range, expected keys, actual keys, bone count, bytes, sha256, wall time, exit code, log paths. *Rationale:* 138 files need resumability and an audit trail; a truncated FBX that still imports is worse than a missing one.

**R21. Stage the run: 3-file smoke (30 fps, 60 fps, fractional) → 10-file sample → full 138; watch peak memory and per-file time.**
Stop and fix if memory grows monotonically or p95 time is far above the pilot. *Rationale:* catches leaks and one-off plugin failures before spending hours.

**R22. Limit parallelism (2–4 processes) unless you have measured memory; do not run 138 in parallel.**
*Rationale:* each Max process loads the full scene and the FBX plugin; memory and disk I/O dominate, and license/plugin contention is possible. This is general engineering judgment, not an Autodesk rule.

### D. Self-check / validation

**R23. Configure the re-import checker explicitly.**
`FBXImporterSetParam "ResetImport"`, `"Mode" #create`, `"Animation" true`, `"TakeIndex" 1`, `"Resampling" 1.0`, `"PostSamplingKeyReducer" false`, `"KeepFrameRate" true`, `"FillTimeline" true`, then `importFile ... #noPrompt using:FBXIMP`. *Rationale:* default import can resample and reduce keys; a checker that silently thins curves cannot validate a dense bake.

**R24. Assert, per file: animated bone count, per-bone key count == expected `P` (or `P+1` for one-shots), first/last key times, interpolation, animation presence, skin modifier count, FBX bytes.**
Use `numKeys`/`getKeyTime` on position/rotation/scale controllers, not only on the PRS controller. *Rationale:* these are the failure modes seen so far (dropped Biped curves, truncated end keys, wrong range), and they are cheap to check.

**R25. Add a pose-parity check at first/middle/last frames against the source scene, then against the Blender sample.**
Compare root-relative world matrices for a few bones (hips, spine, head, both hands/feet) with a tolerance; fail on time-offset or axis/scale regressions. *Rationale:* key counts can be right while transforms are wrong (axis conversion, scale, +1 offset); pose comparison catches that.

**R26. Normalize the Blender +1 frame offset and compare in seconds, not frame numbers.**
Store `t = frame/fps` for both sides; assert `|t_source − t_blender| < 1/(2·fps)`. *Rationale:* Blender's frame 1 = time 0; a naive frame-index diff will report a systematic off-by-one that is not an export error.

**R27. Treat the re-import as a smoke test, not proof.**
Pair it with (a) the data-level FBX check (R15) and (b) the Blender sample parity (R25). *Rationale:* reducer, resampling, axis and unit conversions can all make a broken file "import fine"; conversely, a good file can look wrong under a bad checker.

### E. Slimming

**R28. Default to full export (skeleton + skinned mesh); only slim if a consumer proves it needs it.**
*Rationale:* the full FBX is the archival artifact and the self-check reference; slimming is a derived deliverable and should be reproducible from the full file.

**R29. If skeleton-only is required, try options in this order: `ExportAnimationOnly=true` → delete mesh objects in memory then export all → `selectedOnly:true` with the full Biped hierarchy.**
For each, verify 65 bones, `P` keys per animated bone, no skin clusters, and a much smaller file. *Rationale:* `ExportAnimationOnly` is official but semantically undocumented; delete-then-export avoids selection dependencies; `selectedOnly` is the most likely to drop required parent/skin nodes. Never assume "selected only" keeps unselected bones that the skin references.

---

## 3. (b) Evidence table

| # | Claim | Type | URL | Short quote / observation | Confidence |
|---|---|---|---|---|---|
| 1 | Bake Animation is what converts Biped into FBX curves | official | <https://help.autodesk.com/cloudhelp/2019/ENU/3DSMax-Data-Exchange/files/GUID-31EA2A4F-A126-498B-96E8-31811522738A.htm> | "all unsupported constraints and controllers, including the 3ds Max Biped, are resampled into animation curves" | High |
| 2 | Bake Start/End come from the scene timeline by default | official | same as #1 | "takes the Start and End values automatically from the 'timeline'" | High |
| 3 | Bake Start/End/Step cannot be stored in presets | official | same as #1; legacy detail at <https://download.autodesk.com/us/3DSmax/2012help/files/GUID-BE1E8432-5ACC-4B89-B058-73B9BF2DC78-2799.htm> | "always derives these values from the scene being exported" | High |
| 4 | Range is inclusive: 1..102 for a 102-frame scene | official-legacy | <https://download.autodesk.com/us/3DSmax/2012help/files/GUID-BE1E8432-5ACC-4B89-B058-73B9BF2DC78-2799.htm> | "Start value will be 1, the End value will be 102, and the Step value will be 1" | High (for the default path) |
| 5 | Script bake params are integers | official | <https://help.autodesk.com/cloudhelp/2024/ENU/MAXScript-Tools-and-Interaction/Interacting-with-the-3ds-Max/FBX-Import-and-Export-Dialog/GUID-54B1F140-B304-48A2-9829-C68B345E2044.html> | "BakeFrameStart \| Integer value." (same for End/Step) | High |
| 6 | No documented rounding rule for a fractional timeline end | inference (absence of docs) | — | No Autodesk page states floor/round/ceil for this case | Medium (absence of evidence) |
| 7 | 3ds Max time is 4800 ticks/s and supports fractional frames | official | <https://help.autodesk.com/cloudhelp/2016/ENU/MAXScript-Help/files/GUID-51429B01-2FC6-4746-9E88-5EB5D93056CC.htm> | "4800 ticks per second"; "floating point numbers specifying fractional frames" | High |
| 8 | Animation controllers with undefined ranges are clamped to the scene interval | official-legacy | <https://download.autodesk.com/us/3DSmax/2012help/files/GUID-819E165C-BBA6-4452-AEF0-7AD6E888D0B-2798.htm> | "automatically adjusts it to use the scene animation interval" | High |
| 9 | Constant Key Reducer can remove end keys; import may auto-apply it | official-legacy | <https://download.autodesk.com/us/3DSmax/2012help/files/GUID-117BB3DD-98F0-4D9A-AC8F-DEEF04C90BA-2793.htm> | "If you are missing keyframes at the end… may have been cleaned by… Constant Key Reducer" | High |
| 10 | Import key reduction is on by default and can lose data | official | <https://help.autodesk.com/cloudhelp/2024/ENU/MAXScript-Tools-and-Interaction/Interacting-with-the-3ds-Max/FBX-Import-and-Export-Dialog/GUID-77CE3E5A-7AB1-4048-BD80-B127E0231FFA.html> | "By default this setting is true… can… result in the loss of information" | High |
| 11 | Importer handles one take; default take is Take 001 | official | <https://download.autodesk.com/us/3DSmax/2012help/files/GUID-E189734A-DAC8-4924-9761-6F0A8B6D6FF-2731.htm>; export page #1 | "You can only select and import a single take"; "saves… as Take 001" | High |
| 12 | Fill Timeline sets the range from first/last keys | official-legacy | <https://download.autodesk.com/us/3DSmax/2012help/files/GUID-A8AE05FF-BAF7-4302-977D-B5C90E556A5-2732.htm> | "refers to the first and last keys of animation contained in the file" | High |
| 13 | Resample All samples at host frame rate | official | <https://download.autodesk.com/us/fbx/20112/3dsmax/files/WS73099cc142f487554b4b33fa12487091099-68c2.htm> | "resamples animation using the frame rate of the host application" | High |
| 14 | FBX key times are absolute FbxTime; time modes include 30/60 fps | official | <https://help.autodesk.com/cloudhelp/2018/ENU/FBX-Developer-Help/cpp_ref/class_fbx_time.html> | "used in… all animation-related classes"; EMode lists eFrames30/eFrames60 | High |
| 15 | One second = 46,186,158,000 FBX ticks | official | <https://help.autodesk.com/cloudhelp/2018/ENU/FBX-Developer-Help/cpp_ref/fbxtimecode_8h_source.html> | `FBXSDK_TC_MILLISECOND 46186158`, `TC_SECOND = MILLISECOND*1000` | High |
| 16 | Bind pose is separate global-space matrices; clusters link bones to points | official | <https://help.autodesk.com/cloudhelp/2018/ENU/FBX-Developer-Help/cpp_ref/class_fbx_pose.html>; <https://help.autodesk.com/cloudhelp/2018/ENU/FBX-Developer-Help/cpp_ref/class_fbx_cluster.html> | "Bind Pose… at the moment of the binding operation"; "If the node is animated, the control points will move" | High |
| 17 | Pose data can be unreliable; cluster bind matrices preferred; root bone gap | community (OSS commit) | <https://github.com/godotengine/godot/commit/095569011c6afd7baab44fac0a8a1850af3217e3> | "the information in FBX Pose objects is relatively often broken… cannot capture the bind pose of the root bone" | Medium-High |
| 18 | Biped Figure Mode is the rest pose | official-legacy | <https://download.autodesk.com/us/3DSmax/2012help/files/GUID-7DB3BD2D-C14E-4E23-834D-23B4B7115E5-1443.htm> | "change the biped structure in its rest pose"; "default pose… before animation" | High |
| 19 | `Bip2FBX` exists as an old true/false export flag with no description | official-legacy | <https://download.autodesk.com/us/fbx/3dsMax_online/files/WS644c7983f449f2df-53d205c5113e574e97c-8000.htm> | param table row "Bip2FBX \| True or false" | High (existence); Low (semantics) |
| 20 | Without Bake, only the top Biped layer exports; with Bake, layers top-down | official-legacy | <https://download.autodesk.com/us/3DSmax/2012help/files/GUID-21B5781D-5D3D-40E7-8620-587BEC650C5-2790.htm> | "only the top layer of animation is exported"; "export all animation from the top down" | High |
| 21 | Batch supports -dm/-log/-listenerlog/-v and documented exit codes | official | <https://help.autodesk.com/cloudhelp/2024/ENU/3DSMax-Batch/files/GUID-48A78515-C24B-4E46-AC5F-884FBCF40D59.htm> | "dialog monitor… closes them"; exit-code table 0/-100/-110/-120/-130/-1..-9 | High |
| 22 | quitMAX supports a user exit code; resetMaxFile for batch | official | <https://help.autodesk.com/cloudhelp/2024/ENU/MAXScript-Tools-and-Interaction/Miscellaneous-Functions/GUID-92E4150E-0AD4-430C-A852-783A45276D23.html> | "useful for batch processing scripts using 3dsmaxbatch.exe" | High |
| 23 | loadMaxFile can suppress prompts and log missing plugins; exportFile has selectedOnly | official | <https://help.autodesk.com/cloudhelp/2024/ENU/MAXScript-Tools-and-Interaction/File-Access/3ds-Max-Scene-Files-Access/GUID-624D3D05-B15D-4A97-9F15-DA35CDB0DDD2.html> | "allowPrompts… default is false"; missingDLLsAction; "only selected nodes are exported" | High |
| 24 | Max memory degrades over long batches; one process per file, fuse, log, retry | community | <https://www.tech-artists.org/t/3ds-max-batch-processing-help/1018> | "Max can easily run out of memory… open up a session of Max for each file… fuse" | Medium-High |
| 25 | `ExportAnimationOnly` is script-only, 2019.1+ | official | <https://help.autodesk.com/cloudhelp/2024/ENU/MAXScript-Tools-and-Interaction/Interacting-with-the-3ds-Max/FBX-Import-and-Export-Dialog/GUID-54B1F140-B304-48A2-9829-C68B345E2044.html> | "exposed only in MAXScript, it does not appear on the UI" | High (existence); Low (semantics) |
| 26 | 3ds Max Game Exporter fixes the static pose at frame 0 | community (vendor help) | <https://help.sketchfab.com/en/articles/16152844-3ds-max-animation> | "the 'static pose' will always be the '0' frame" | Medium (different exporter) |
| 27 | Physique has an explicit Init Pose; Skin is bound from frame-0 data | community (CN) | <https://www.gameres.com/forum/t/139938> | Physique `GetBoneInitTM` vs Skin frame 0; modifier, not node, defines init pose | Medium |
| 28 | A third-party exporter exposes `TimeSegment #Active` and integer start/end | community (vendor) | <https://smartanim.com/documentation/maxscript/fbx.php> | "#Active - Exports the active scene timeline range"; "StartFrame Integer" | Medium (corroboration only) |

---

## 4. (c) Known pitfalls to check before the full batch

- [ ] **Fractional range identified** for all 138 files; policy chosen (`round`, loop `P` keys) and recorded per file.
- [ ] **A/B pilot done** on `StandBy` 83.5 (`0..83` vs `0..84`), with key counts and loop-seam comparison.
- [ ] **`BakeFrameStart/End/Step` read back** after setting; `Step=1`; no reliance on timeline defaults or presets.
- [ ] **Key reducers off**: `FilterKeyReducer=false`, `Removesinglekeys=false`, no Constant Key Reducer.
- [ ] **`Bip2FBX` absent/false**; regression export with/without on one clip shows the expected difference.
- [ ] **`BakeAnimation=true`, `BakeResampleAnimation=true`** (or an explicit decision to use `Resample All`).
- [ ] **Per-file fps recorded**; 60 fps files are not silently sampled at 30 fps; mixed-fps Blender import policy defined.
- [ ] **Loop metadata** (`loop`, `periodFrames`, `durationSeconds`) emitted and duplicate end frames handled by policy.
- [ ] **`Tpose` rest asset validated** against all 65 bone names/order/parents for every file; hash mismatch fails the file.
- [ ] **Bind-pose export in Figure Mode** tested (if any consumer needs per-file bind), compared to `Tpose`.
- [ ] **Biped layers audit**: any scene with layers is checked for key counts; layers collapsed or bake confirmed.
- [ ] **Missing-plugin scene tested** (Corona/V-Ray materials): `-dm on` closes dialogs; `loadMaxFile` returns true/false as expected.
- [ ] **One process per file**, timeout, process-tree kill, one retry, quarantine list, resumable manifest.
- [ ] **Logs on** (`-log`, `-listenerlog`, `-v 5`), exit codes parsed, `quitMAX exitCode` used.
- [ ] **Re-import checker disables reducer** (`PostSamplingKeyReducer=false`, `Resampling=1`) and imports Take 1.
- [ ] **Assertions pass**: expected keys per animated bone, first/last key times, 65 bones, skin present, bytes > 0.
- [ ] **Pose parity** at 3 frames vs source and vs Blender sample; Blender +1 offset normalized; time compared in seconds.
- [ ] **Data-level FBX check** (Pose/BindPose/cluster presence) on one pilot file.
- [ ] **Slimming option chosen and verified** (65 bones, `P` keys, no skin) if a skeleton-only deliverable is needed.
- [ ] **Staged rollout** 3 → 10 → 138 with memory/time monitoring and disk-space check.

---

## 5. (d) Open questions

1. **How does the exporter actually round a fractional timeline end?** Test: `FbxExporterSetParam "BakeFrameEnd" 83.5` then `FbxExporterGetParam "BakeFrameEnd"`; separately export explicit 83 and 84 and compare keys. Also test `(83.5 as integer)` semantics in MAXScript.
2. **What is the node static transform at export: current slider time, frame 0, or bake start?** Test by setting the slider to three different frames, exporting the same scene, and diffing node `Lcl Translation/Rotation` in ASCII FBX.
3. **Does Figure Mode export produce a rest matching the `Tpose` FBX?** Compare bone matrices; if not, the canonical rest must remain the `Tpose` asset only.
4. **What does `ExportAnimationOnly` do in 2027.2?** Does it keep the 65 bones and all `P` keys, and drop only mesh/skin? Undocumented; pilot required.
5. **What is `Bip2FBX`'s intended role, and why does `true` drop baked curves?** No public docs; avoid, but record the behavior for future Max versions.
6. **Does Blender's FBX importer use node rest or bind pose for the armature, and can it be forced to the `Tpose` rest?** This determines whether per-file rest leaks into the VRM skeleton; test with two files with different rest poses.
7. **Does Blender's importer convert key times using scene fps or file fps?** Test a 60 fps clip in a 30 fps scene and inspect key times/duplication.
8. **Is `0–83.5` a 60 fps artifact** (e.g., 167 frames at 60 seen through a 30 fps scene) or a genuinely half-frame-authored range? Inspect the source `.max` ticks, scene fps, and Biped keys.
9. **Does 3ds Max FBX export write a `Pose`/`BindPose` element for Biped at all**, and are cluster `TransformLink` matrices present and consistent? One ASCII export answers this.
10. **Should the archive use `UseSceneName=true`** (per-file take names) or keep `Take 001` for downstream simplicity? Decide before the batch, because renaming later touches every file.

---

## 6. Sources actually fetched

All URLs below were successfully fetched during this research (some Autodesk `view/` pages and PDFs were not usable and are excluded). Autodesk links use the language/version that rendered server-side content.

### Autodesk — FBX export / import

1. <https://help.autodesk.com/cloudhelp/2019/ENU/3DSMax-Data-Exchange/files/GUID-31EA2A4F-A126-498B-96E8-31811522738A.htm>
2. <https://help.autodesk.com/cloudhelp/2024/ENU/MAXScript-Tools-and-Interaction/Interacting-with-the-3ds-Max/FBX-Import-and-Export-Dialog/GUID-54B1F140-B304-48A2-9829-C68B345E2044.html>
3. <https://help.autodesk.com/cloudhelp/2024/ENU/MAXScript-Tools-and-Interaction/Interacting-with-the-3ds-Max/FBX-Import-and-Export-Dialog/GUID-77CE3E5A-7AB1-4048-BD80-B127E0231FFA.html>
4. <https://download.autodesk.com/us/fbx/3dsMax_online/files/WS644c7983f449f2df-53d205c5113e574e97c-8000.htm>
5. <https://download.autodesk.com/us/fbx/3ds_max_help/fbx_3dsmax_online/files/WS1a9193826455f5ff-6d855556117c4584e5420a5.htm>
6. <https://download.autodesk.com/us/fbx/20112/3dsmax/files/WS73099cc142f487554b4b33fa12487091099-68c2.htm>
7. <https://download.autodesk.com/us/3DSmax/2012help/files/GUID-FC53925F-6995-4AEF-9D75-24FFCFD8301-2692.htm>
8. <https://download.autodesk.com/us/3DSmax/2012help/files/GUID-BE1E8432-5ACC-4B89-B058-73B9BF2DC78-2799.htm>
9. <https://download.autodesk.com/us/3DSmax/2012help/files/GUID-3244D879-2DCF-46FE-92D9-DC8AD88CE83-2693.htm>
10. <https://download.autodesk.com/us/3DSmax/2012help/files/GUID-A4BE0193-F0A2-4249-AE91-994904FC887-2729.htm>
11. <https://download.autodesk.com/us/3DSmax/2012help/files/GUID-76A8493D-ADD6-4DD8-8239-6E690DF25BF-2730.htm>
12. <https://download.autodesk.com/us/3DSmax/2012help/files/GUID-E189734A-DAC8-4924-9761-6F0A8B6D6FF-2731.htm>
13. <https://download.autodesk.com/us/3DSmax/2012help/files/GUID-A8AE05FF-BAF7-4302-977D-B5C90E556A5-2732.htm>
14. <https://download.autodesk.com/us/3DSmax/2012help/files/GUID-40EFEF4D-27C7-4320-9BC8-4A5A396B6B4-2733.htm>
15. <https://download.autodesk.com/us/3DSmax/2012help/files/GUID-117BB3DD-98F0-4D9A-AC8F-DEEF04C90BA-2793.htm>
16. <https://download.autodesk.com/us/3DSmax/2012help/files/GUID-21B5781D-5D3D-40E7-8620-587BEC650C5-2790.htm>
17. <https://download.autodesk.com/us/3DSmax/2012help/files/GUID-6C4472B1-F5AF-47BA-B1E1-D9AB47E871D-2809.htm>
18. <https://download.autodesk.com/us/3DSmax/2012help/files/GUID-819E165C-BBA6-4452-AEF0-7AD6E888D0B-2798.htm>
19. <https://download.autodesk.com/us/3DSmax/2012help/files/GUID-511AE209-156C-4406-85B1-4266FEA5783-2797.htm>
20. <https://download.autodesk.com/us/3DSmax/2012help/files/GUID-C3389EE9-18A9-47EC-8222-EA94BD665FF-2767.htm>
21. <https://download.autodesk.com/us/3DSmax/2012help/files/GUID-7ECD378E-5A3F-4722-B32B-8A0EB581824-2783.htm>
22. <https://download.autodesk.com/us/3DSmax/2012help/files/GUID-7DB3BD2D-C14E-4E23-834D-23B4B7115E5-1443.htm>
23. <https://download.autodesk.com/us/fbx/2012/jpn/files/GUID-377B0ACE-CEC8-4D13-81E9-E8C9425A8B6-147.htm> (Maya `FBXExportAnimationOnly`, adjacent concept)

### Autodesk — batch / MAXScript / time

24. <https://help.autodesk.com/cloudhelp/2024/ENU/3DSMax-Batch/files/GUID-48A78515-C24B-4E46-AC5F-884FBCF40D59.htm>
25. <https://help.autodesk.com/cloudhelp/2024/ENU/3DSMax-Batch/files/GUID-0968FF0A-5ADD-454D-B8F6-1983E76A4AF9.htm>
26. <https://help.autodesk.com/cloudhelp/2024/ENU/MAXScript-Tools-and-Interaction/Miscellaneous-Functions/GUID-92E4150E-0AD4-430C-A852-783A45276D23.html>
27. <https://help.autodesk.com/cloudhelp/2024/ENU/MAXScript-Tools-and-Interaction/File-Access/3ds-Max-Scene-Files-Access/GUID-624D3D05-B15D-4A97-9F15-DA35CDB0DDD2.html>
28. <https://help.autodesk.com/cloudhelp/2016/ENU/MAXScript-Help/files/GUID-51429B01-2FC6-4746-9E88-5EB5D93056CC.htm>
29. <https://help.autodesk.com/cloudhelp/2015/ENU/MAXScript-Help/files/GUID-B57EA575-DCDE-42F5-9D30-88E3EB41F350.htm>
30. <https://help.autodesk.com/cloudhelp/2016/ENU/MAXScript-Help/files/GUID-E79133B4-9C23-40FD-8C2A-9FF43861222A.htm>

### Autodesk — FBX SDK

31. <https://help.autodesk.com/cloudhelp/2018/ENU/FBX-Developer-Help/cpp_ref/class_fbx_time.html>
32. <https://help.autodesk.com/cloudhelp/2018/ENU/FBX-Developer-Help/cpp_ref/fbxtimecode_8h_source.html>
33. <https://help.autodesk.com/cloudhelp/2018/ENU/FBX-Developer-Help/cpp_ref/class_fbx_pose.html>
34. <https://help.autodesk.com/cloudhelp/2018/ENU/FBX-Developer-Help/cpp_ref/class_fbx_cluster.html>
35. <https://help.autodesk.com/cloudhelp/2018/ENU/FBX-Developer-Help/cpp_ref/class_fbx_global_settings.html>

### Community / vendor

36. <https://www.tech-artists.org/t/3ds-max-batch-processing-help/1018>
37. <https://github.com/godotengine/godot/commit/095569011c6afd7baab44fac0a8a1850af3217e3>
38. <https://www.gameres.com/forum/t/139938>
39. <https://help.sketchfab.com/en/articles/16152844-3ds-max-animation>
40. <https://smartanim.com/documentation/maxscript/fbx.php>
41. <https://www.autodesk.com.cn/support/technical/article/caas/sfdcarticles/sfdcarticles/CHS/Error-Incomplete-BindPose-when-exporting-rigged-objects-from-3ds-Max-to-fbx-format.html> (HTTP 200 but rendered only the title; not used as evidence)

### Pages that were **not** usable (attempted, excluded)

- `forums.autodesk.com` threads → HTTP 403 / Cloudflare interstitial.
- `images.autodesk.com/...pdf` → `web_fetch` does not support `application/pdf`.
- Several `help.autodesk.com/view/...` pages → JS shell only ("Help").
- `docs.autodesk.com/FBX/2014/...` → fetch failure.

---

## 7. Local observations carried into this note (not web-sourced)

- 6 pilot scenes / 12 FBX exported with `Animation=true`, `BakeAnimation=true`, `BakeResampleAnimation=true`, range/step = scene range/1, then re-imported empty-scene self-check. **[local]**
- `Bip2FBX=true` drops all baked Biped curves; excluded. **[local]**
- 332 bones × 85 keys/channel for an 85-frame clip; LINEAR interpolation; skinned meshes deform. **[local]**
- Mixed 30/60 fps scenes; observed ranges `0–35`, `0–83.5`, `0–101`, `0–110`, `0–194`, `0–300`. **[local]**
- Per-file node local transforms (Blender `matrix_local`) differ and track the scene pose at export, while skinning is correct. **[local]**
- Blender maps FBX time 0 to frame 1, so baked ranges appear as `1..N`. **[local]**
