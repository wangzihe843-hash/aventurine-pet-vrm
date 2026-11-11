#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# run-adv-pipeline.sh — one-shot Mac-side pipeline for the adv motion set.
#
# Steps: Blender sampling (Biped FBX -> samples.json) -> coverage gate ->
#        retarget (samples -> clip JSON) -> [full] manifest + --check -> validate
#        -> optional preview (Electron screenshots + contact sheets).
#
# Usage:
#   scripts/vrm/motion/run-adv-pipeline.sh --fbx-dir <dir> --mode pilot
#   scripts/vrm/motion/run-adv-pipeline.sh --fbx-dir <dir> --mode full
#
# Options (all optional except --fbx-dir):
#   --fbx-dir <dir>      folder with the exported FBX (should contain Tpose.fbx)
#   --mode pilot|full    pilot: staging clips dir, manifest skipped, preview on matched clips
#                        full : writes assets/motions/adv, builds manifest/index + validate
#   --config <json>      clip registry (default: pilot=clips.adv.json, full=clips.adv-all.json)
#   --tmp-dir <dir>      staging/report dir (default tests/tmp/adv-pipeline)
#   --clips-out <dir>    override clip JSON output dir
#   --skip-preview       do not run the Electron preview
#   --dry-run            print resolved commands and exit
#
# Exit codes: 0 ok; 1 bad usage (option missing/empty value); 2 coverage gate failed (full mode);
#             3 missing dependency / invalid --mode / unknown option.
# ---------------------------------------------------------------------------
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT" || exit 3

BLENDER="${BLENDER:-/Volumes/4TB外置盘/deepseek-harness/tools/blender/Blender.app/Contents/MacOS/Blender}"
FBX_DIR=""
MODE="pilot"
CONFIG=""
TMP_DIR="tests/tmp/adv-pipeline"
CLIPS_OUT=""
SKIP_PREVIEW=0
DRY_RUN=0

# 需要值的选项：缺值/空值时立即报错退出，避免只剩 1 个参数时 `shift 2` 失败
# 后进入死循环（C-05）。$1=选项名，$2=剩余参数个数，$3=待用值。
need_value() {
  if [ "$2" -lt 2 ] || [ -z "${3:-}" ]; then
    echo "ERROR: $1 requires a non-empty value（--help 查看用法）" >&2
    exit 1
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --fbx-dir) need_value "$1" "$#" "${2:-}"; FBX_DIR="$2"; shift 2 ;;
    --mode) need_value "$1" "$#" "${2:-}"; MODE="$2"; shift 2 ;;
    --config) need_value "$1" "$#" "${2:-}"; CONFIG="$2"; shift 2 ;;
    --tmp-dir) need_value "$1" "$#" "${2:-}"; TMP_DIR="$2"; shift 2 ;;
    --clips-out) need_value "$1" "$#" "${2:-}"; CLIPS_OUT="$2"; shift 2 ;;
    --skip-preview) SKIP_PREVIEW=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 3 ;;
  esac
done

if [ -z "$FBX_DIR" ]; then echo "ERROR: --fbx-dir is required" >&2; exit 3; fi
if [ ! -d "$FBX_DIR" ]; then echo "ERROR: FBX dir not found: $FBX_DIR" >&2; exit 3; fi
if [ ! -x "$BLENDER" ]; then echo "ERROR: Blender not found: $BLENDER" >&2; exit 3; fi
case "$MODE" in
  pilot) [ -z "$CONFIG" ] && CONFIG="scripts/vrm/motion/clips.adv.json"; [ -z "$CLIPS_OUT" ] && CLIPS_OUT="$TMP_DIR/clips" ;;
  full)  [ -z "$CONFIG" ] && CONFIG="scripts/vrm/motion/clips.adv-all.json"; [ -z "$CLIPS_OUT" ] && CLIPS_OUT="assets/motions/adv" ;;
  *) echo "ERROR: --mode must be pilot|full" >&2; exit 3 ;;
esac
mkdir -p "$TMP_DIR"

SAMPLES="$TMP_DIR/samples.json"
SAMPLES_REPORT="$TMP_DIR/samples-report.json"

run() {
  echo ""
  echo "### $*"
  if [ "$DRY_RUN" = "1" ]; then return 0; fi
  "$@"
}

echo "== adv pipeline =="
echo "  mode      : $MODE"
echo "  root      : $ROOT"
echo "  fbx dir   : $FBX_DIR"
echo "  config    : $CONFIG"
echo "  tmp dir   : $TMP_DIR"
echo "  clips out : $CLIPS_OUT"

# 1) sampling
run "$BLENDER" -b --factory-startup --python scripts/vrm/motion/extract-biped-anims.py -- \
  --fbx-dir "$FBX_DIR" --config "$CONFIG" \
  --out "$SAMPLES" --report "$SAMPLES_REPORT" --minimal
SAMPLER_RC=$?
if [ "$DRY_RUN" = "0" ] && [ $SAMPLER_RC -ne 0 ]; then
  echo "ERROR: sampling failed (exit $SAMPLER_RC). Check $SAMPLES_REPORT" >&2
  exit 2
fi

# 1b) coverage gate
if [ "$DRY_RUN" = "0" ]; then
  node - "$SAMPLES" "$CONFIG" "$MODE" <<'NODE'
const fs = require('node:fs')
const [samplesPath, configPath, mode] = process.argv.slice(2)
const samples = JSON.parse(fs.readFileSync(samplesPath, 'utf8'))
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
const expected = (config.clips ?? []).map((clip) => clip.id)
const got = Object.keys(samples.clips ?? {})
const missing = expected.filter((id) => !got.includes(id))
console.log(`[coverage] samples=${got.length}/${expected.length} missing=${missing.slice(0, 12).join(',') || 'none'}${
  missing.length > 12 ? ` (+${missing.length - 12} more)` : ''
}`)
if (mode === 'full' && missing.length > 0) {
  console.error('[coverage] FULL mode requires every registry clip; fix take/file matching first (see docs/adv-pipeline-commands.md §3.1).')
  process.exit(2)
}
NODE
  GATE_RC=$?
  if [ $GATE_RC -ne 0 ]; then exit 2; fi
fi

# 2) retarget
run node scripts/vrm/motion/retarget-adv.mjs \
  --samples "$SAMPLES" --config "$CONFIG" \
  --out "$CLIPS_OUT" --report-dir "$TMP_DIR"
RETARGET_RC=$?
if [ "$DRY_RUN" = "0" ] && [ $RETARGET_RC -ne 0 ]; then
  echo "ERROR: retarget failed (exit $RETARGET_RC); inspect $TMP_DIR/retarget-report.json" >&2
  exit 2
fi

# 3) manifest + --check (full mode only: pilot has no full coverage by design)
if [ "$MODE" = "full" ]; then
  run node scripts/vrm/motion/build-adv-manifest.mjs \
    --dir "$CLIPS_OUT" --config "$CONFIG" --report "$TMP_DIR/manifest-report.json"
  MANIFEST_RC=$?
  if [ "$DRY_RUN" = "0" ] && [ $MANIFEST_RC -ne 0 ]; then exit 2; fi
  run node scripts/vrm/motion/build-adv-manifest.mjs --dir "$CLIPS_OUT" --config "$CONFIG" --check
  CHECK_RC=$?
  if [ "$DRY_RUN" = "0" ] && [ $CHECK_RC -ne 0 ]; then exit 2; fi
fi

# 4) validate
run node scripts/vrm/motion/validate-adv-clips.mjs \
  --dir "$CLIPS_OUT" --json "$TMP_DIR/validation-report.json"
VALIDATE_RC=$?
if [ "$DRY_RUN" = "0" ] && [ $VALIDATE_RC -ne 0 ]; then
  echo "WARN: validation reported FAIL (exit $VALIDATE_RC); inspect $TMP_DIR/validation-report.json" >&2
fi

# 5) preview (skip with --skip-preview; needs Electron)
if [ "$SKIP_PREVIEW" = "0" ]; then
  if [ "$MODE" = "full" ]; then
    run node scripts/vrm/motion/preview-adv.mjs --all --clips-dir "$CLIPS_OUT" \
      --out "$TMP_DIR/preview" --frames 0,0.25,0.5,0.75 --views front,side,threeQuarter
  else
    PREVIEW_CLIPS=$(node -e 'const fs=require("node:fs");const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));console.log(Object.keys(s.clips||{}).slice(0,6).join(","))' "$SAMPLES")
    run node scripts/vrm/motion/preview-adv.mjs --clips "$PREVIEW_CLIPS" --clips-dir "$CLIPS_OUT" \
      --out "$TMP_DIR/preview" --frames 0,0.25,0.5,0.75 --views front,side,threeQuarter
  fi
fi

echo ""
echo "== adv pipeline done =="
echo "  samples    : $SAMPLES"
echo "  report     : $TMP_DIR/samples-report.json"
echo "  clips      : $CLIPS_OUT"
echo "  validation : $TMP_DIR/validation-report.json"
if [ "$MODE" = "full" ]; then
  echo "  manifest   : $CLIPS_OUT/manifest.json / index.json"
  echo "  next       : node scripts/vrm/motion/build-app-manifest.mjs  (after adv manifest exists)"
fi
