#!/usr/bin/env bash
# =============================================================================
# W0-2: 幂等安装官方 VRM Add-on for Blender (saturday06/VRM-Addon-for-Blender)
# -----------------------------------------------------------------------------
# 用途:
#   在本机 Blender 4.2 LTS 上安装并启用 VRM Add-on，使其可被无头脚本
#   (scripts/vrm/export-dummy-vrm.py) 使用。重复运行是安全的: 下载/安装均跳过。
#
# 用法:
#   scripts/vrm/install-vrm-addon.sh
#
# 可覆盖的环境变量:
#   BLENDER_BIN            Blender 可执行文件路径 (默认见下方 DEFAULT_BLENDER)
#   VRM_ADDON_VERSION      要安装的版本 (默认 4.10.4, 已 pin)
#   VRM_ADDON_EXT_SHA256   extension zip 的 sha256 (默认已 pin)
#   VRM_ADDON_CACHE_DIR    下载缓存目录 (默认 ~/Library/Caches/aventurine-vrm-tools)
#   VRM_ADDON_LOG_DIR      日志目录 (默认 <repo>/tests/tmp/w0-2)
#
# 来源 (官方 GitHub release):
#   https://github.com/saturday06/VRM-Addon-for-Blender
#   Blender >= 4.2 用 extension 资产: VRM_Addon_for_Blender-Extension-<ver>.zip
#   Blender <= 4.1 用 legacy addon 资产: VRM_Addon_for_Blender-<ver>.zip
#
# 退出码: 0 = 成功(含已安装的幂等路径); 非 0 = 失败(带清晰错误)
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

DEFAULT_BLENDER="/Volumes/4TB外置盘/deepseek-harness/tools/blender/Blender.app/Contents/MacOS/Blender"

# --- pin: 版本 + sha256 (2026-11-04 官方 release v4.10.4, Blender 4.2+ extension) ---
VRM_ADDON_VERSION="${VRM_ADDON_VERSION:-4.10.4}"
VRM_ADDON_EXT_SHA256="${VRM_ADDON_EXT_SHA256:-a711da721878d319a76eaaf9dc72c40de6b96d4ed95766f30666ecf7ae492f5b}"
# legacy addon (Blender 2.93–4.1) 同名版本资产的 sha256, 仅 fallback 用
VRM_ADDON_LEGACY_SHA256="${VRM_ADDON_LEGACY_SHA256:-51bbf2725d5f52d9f8cc6d85323b5a4bec285679925f61f5ac5cc1353424325f}"

RELEASE_BASE="https://github.com/saturday06/VRM-Addon-for-Blender/releases/download/v${VRM_ADDON_VERSION}"
VERSION_USCORE="${VRM_ADDON_VERSION//./_}"
EXT_ASSET="VRM_Addon_for_Blender-Extension-${VERSION_USCORE}.zip"
LEGACY_ASSET="VRM_Addon_for_Blender-${VERSION_USCORE}.zip"
EXT_URL="${RELEASE_BASE}/${EXT_ASSET}"
LEGACY_URL="${RELEASE_BASE}/${LEGACY_ASSET}"

CACHE_DIR="${VRM_ADDON_CACHE_DIR:-$HOME/Library/Caches/aventurine-vrm-tools}"
LOG_DIR="${VRM_ADDON_LOG_DIR:-$REPO_ROOT/tests/tmp/w0-2}"
LOG_FILE="$LOG_DIR/install-vrm-addon.log"

mkdir -p "$CACHE_DIR" "$LOG_DIR"

TS() { date '+%Y-%m-%d %H:%M:%S'; }
log() { printf '[%s] %s\n' "$(TS)" "$*" | tee -a "$LOG_FILE"; }
warn() { printf '[%s] WARN: %s\n' "$(TS)" "$*" | tee -a "$LOG_FILE" >&2; }
die() { printf '[%s] ERROR: %s\n' "$(TS)" "$*" | tee -a "$LOG_FILE" >&2; exit 1; }

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

download_pinned() {
  # $1=url $2=dest $3=expected_sha256
  local url="$1" dest="$2" expected="$3" actual
  if [[ -f "$dest" ]]; then
    actual="$(sha256_of "$dest")"
    if [[ "$actual" == "$expected" ]]; then
      log "[skip] 缓存命中且 sha256 校验通过: $dest"
      return 0
    fi
    warn "缓存文件 sha256 不匹配 (期望 $expected, 实际 $actual), 删除重下: $dest"
    rm -f "$dest"
  fi
  log "[download] $url"
  # 先写 .part, 校验通过后再落位, 避免半截文件被当成有效缓存
  if ! curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 300 \
      -o "${dest}.part" "$url" 2>&1 | tee -a "$LOG_FILE"; then
    rm -f "${dest}.part"
    die "下载失败: $url (网络/镜像问题? 可手动下载后放到 $CACHE_DIR 再重跑)"
  fi
  actual="$(sha256_of "${dest}.part")"
  if [[ "$actual" != "$expected" ]]; then
    rm -f "${dest}.part"
    die "sha256 校验失败: 期望 $expected, 实际 $actual (文件可能被篡改或不完整)"
  fi
  mv "${dest}.part" "$dest"
  log "[download] OK size=$(wc -c < "$dest" | tr -d ' ') bytes sha256=$actual"
}

# --------------------------- 1. 定位 Blender --------------------------------
if [[ -n "${BLENDER_BIN:-}" ]]; then
  BL="$BLENDER_BIN"
  BL_SOURCE="环境变量 BLENDER_BIN"
elif [[ -x "$DEFAULT_BLENDER" ]]; then
  BL="$DEFAULT_BLENDER"
  BL_SOURCE="默认路径"
elif command -v blender >/dev/null 2>&1; then
  BL="$(command -v blender)"
  BL_SOURCE="PATH 中的 blender"
else
  die "找不到 Blender 可执行文件。已尝试: BLENDER_BIN(未设置) / ${DEFAULT_BLENDER} / PATH。
      请用 BLENDER_BIN=/path/to/Blender 显式指定 (macOS 上为 Blender.app/Contents/MacOS/Blender)。"
fi
[[ -x "$BL" ]] || die "Blender 不可执行: $BL"
log "== Blender =="
log "BLENDER_BIN=$BL (来源: $BL_SOURCE)"

BLENDER_VERSION_LINE="$("$BL" --version 2>/dev/null | head -1)"
[[ -n "$BLENDER_VERSION_LINE" ]] || die "无法执行 '$BL --version', 请确认这是 Blender 可执行文件"
BLENDER_VERSION="$(awk '{print $2}' <<<"$BLENDER_VERSION_LINE")"
[[ "$BLENDER_VERSION" =~ ^[0-9]+\.[0-9]+ ]] || die "无法解析 Blender 版本: '$BLENDER_VERSION_LINE'"
BLENDER_MM="$(cut -d. -f1,2 <<<"$BLENDER_VERSION")"
log "Blender: $BLENDER_VERSION_LINE"
log "Blender 版本目录: $BLENDER_MM"

# Blender >= 4.2 才有 --command extension; 否则走 legacy addon 安装
HAS_EXTENSION_CLI=0
if "$BL" --command extension list >/dev/null 2>&1; then
  HAS_EXTENSION_CLI=1
fi
log "extension CLI 支持: $([[ $HAS_EXTENSION_CLI -eq 1 ]] && echo yes || echo no)"

# --------------------------- 2. 定位用户扩展目录 -----------------------------
case "$(uname -s)" in
  Darwin) USER_EXT_BASE="$HOME/Library/Application Support/Blender/$BLENDER_MM/extensions/user_default" ;;
  Linux)  USER_EXT_BASE="${XDG_CONFIG_HOME:-$HOME/.config}/blender/$BLENDER_MM/extensions/user_default" ;;
  *)      USER_EXT_BASE="${APPDATA:-$HOME}/Blender Foundation/Blender/$BLENDER_MM/extensions/user_default" ;;
esac
log "用户扩展目录: $USER_EXT_BASE"

installed_ext_version() {
  local manifest="$USER_EXT_BASE/vrm/blender_manifest.toml"
  if [[ -f "$manifest" ]]; then
    awk -F'"' '/^[[:space:]]*version[[:space:]]*=/{print $2; exit}' "$manifest"
  fi
}

# --------------------------- 3. 下载 + 安装 ----------------------------------
log "== 目标版本: VRM Add-on for Blender v${VRM_ADDON_VERSION} =="
log "来源: $RELEASE_BASE"

if [[ "$(installed_ext_version)" == "$VRM_ADDON_VERSION" ]]; then
  log "[skip] v${VRM_ADDON_VERSION} 已安装 (manifest: $USER_EXT_BASE/vrm/blender_manifest.toml), 跳过下载与安装"
else
  if [[ $HAS_EXTENSION_CLI -eq 1 ]]; then
    EXT_ZIP="$CACHE_DIR/$EXT_ASSET"
    download_pinned "$EXT_URL" "$EXT_ZIP" "$VRM_ADDON_EXT_SHA256"
    # 版本不匹配(旧版本在装)时先移除, 避免 install-file 冲突
    OLD_VERSION="$(installed_ext_version)"
    if [[ -n "$OLD_VERSION" && "$OLD_VERSION" != "$VRM_ADDON_VERSION" ]]; then
      log "[install] 移除旧版本 v$OLD_VERSION"
      "$BL" --command extension remove vrm 2>&1 | tee -a "$LOG_FILE" || warn "移除旧版本失败, 继续尝试安装"
    fi
    log "[install] $BL --command extension install-file -r user_default -e <zip>"
    if ! "$BL" --command extension install-file -r user_default -e "$EXT_ZIP" 2>&1 | tee -a "$LOG_FILE"; then
      die "extension install-file 失败 (zip: $EXT_ZIP)。可尝试手动安装: Blender > Preferences > Extensions > Install from Disk"
    fi
  else
    # Blender <= 4.1: legacy addon, 用 bpy.ops.preferences.addon_install + addon_enable
    warn "当前 Blender 不支持 extension (需要 >= 4.2), 走 legacy addon 安装路径 (module=io_scene_vrm)"
    LEGACY_ZIP="$CACHE_DIR/$LEGACY_ASSET"
    download_pinned "$LEGACY_URL" "$LEGACY_ZIP" "$VRM_ADDON_LEGACY_SHA256"
    # C-04：不要把路径插值进 `--python-expr` 的三引号字符串（CACHE_DIR 可被环境变量
    # 覆盖，含 `'''` 的路径会变成 Python 注入）。改为通过环境变量把路径传给
    # Blender 内嵌 Python（os.environ），这里只对换行做一层可读性兜底校验。
    if [[ "$LEGACY_ZIP" == *$'\n'* ]]; then
      die "legacy addon zip 路径包含换行，拒绝安装: $LEGACY_ZIP"
    fi
    log "[install] bpy.ops.preferences.addon_install(filepath=<VRM_LEGACY_ZIP>) + addon_enable(io_scene_vrm)"
    if ! env VRM_LEGACY_ZIP="$LEGACY_ZIP" "$BL" --background --factory-startup --python-exit-code 1 --python-expr "
import os

import bpy

zip_path = os.environ['VRM_LEGACY_ZIP']
bpy.ops.preferences.addon_install(filepath=zip_path)
bpy.ops.preferences.addon_enable(module='io_scene_vrm')
bpy.ops.wm.save_userpref()
print('LEGACY_ADDON_INSTALL=OK')
" 2>&1 | tee -a "$LOG_FILE"; then
      die "legacy addon 安装失败 (zip: $LEGACY_ZIP)"
    fi
  fi
fi

# --------------------------- 4. 验证: 已列出 + 无头可启用 --------------------
log "== 验证 =="
if [[ $HAS_EXTENSION_CLI -eq 1 ]]; then
  log "[verify] extension list (仅显示 vrm / mmd_tools / Repository 行)"
  "$BL" --command extension list 2>&1 | grep -E 'Repository:|^  (vrm|mmd_tools) ' | tee -a "$LOG_FILE" || true
  LISTED="$("$BL" --command extension list 2>&1 | grep -cE '^  vrm \[installed\]' || true)"
  [[ "$LISTED" -ge 1 ]] || die "extension list 中未找到 'vrm [installed]'"
  log "[verify] extension list: vrm [installed] OK"
fi

VERIFY_PY="$(mktemp -t vrm-addon-verify.XXXXXX.py)"
trap 'rm -f "$VERIFY_PY"' EXIT
cat > "$VERIFY_PY" <<'PY'
import importlib
import sys

import bpy

module = None
for candidate in ("bl_ext.user_default.vrm", "io_scene_vrm"):
    try:
        bpy.ops.preferences.addon_enable(module=candidate)
        module = candidate
        break
    except Exception as exc:  # noqa: BLE001 - 依次尝试候选模块名
        print(f"addon_enable({candidate}) failed: {exc}")

if module is None:
    print("VRM_ADDON_ENABLE=FAIL")
    sys.exit(1)

mod = importlib.import_module(module)
version = tuple(getattr(mod, "bl_info", {}).get("version", ()))
has_export = hasattr(bpy.ops.export_scene, "vrm")
has_import = hasattr(bpy.ops.import_scene, "vrm")
print(f"VRM_ADDON_MODULE={module}")
print(f"VRM_ADDON_VERSION={'.'.join(str(v) for v in version)}")
print(f"VRM_ADDON_FILE={getattr(mod, '__file__', '')}")
print(f"VRM_ADDON_EXPORT_OP={'export_scene.vrm' if has_export else 'MISSING'}")
print(f"VRM_ADDON_IMPORT_OP={'import_scene.vrm' if has_import else 'MISSING'}")
if not (has_export and has_import):
    print("VRM_ADDON_ENABLE=FAIL")
    sys.exit(1)
print("VRM_ADDON_ENABLE=OK")
PY

log "[verify] 无头启用 (--background --factory-startup)"
VERIFY_OUT="$("$BL" --background --factory-startup --python-exit-code 1 --python "$VERIFY_PY" 2>&1)"
if ! grep -q '^VRM_ADDON_ENABLE=OK$' <<<"$VERIFY_OUT"; then
  printf '%s\n' "$VERIFY_OUT" | tee -a "$LOG_FILE" >&2
  die "无头模式下启用 VRM add-on 失败 (见上)"
fi
printf '%s\n' "$VERIFY_OUT" | grep -E '^VRM_ADDON_' | tee -a "$LOG_FILE"

# --------------------------- 5. 汇总 ----------------------------------------
EFFECTIVE_VERSION="$(installed_ext_version || true)"
if [[ -z "$EFFECTIVE_VERSION" ]]; then
  EFFECTIVE_VERSION="$(grep -oE '^VRM_ADDON_VERSION=.*' <<<"$VERIFY_OUT" | head -1 | cut -d= -f2)"
fi
log "== 完成 =="
log "addon: VRM Add-on for Blender (VRM format), module=bl_ext.user_default.vrm"
log "version: ${EFFECTIVE_VERSION:-$VRM_ADDON_VERSION}"
log "sha256: $VRM_ADDON_EXT_SHA256"
log "install_path: $USER_EXT_BASE/vrm"
log "log: $LOG_FILE"
log "next: \"$BL\" --background --factory-startup --python scripts/vrm/export-dummy-vrm.py"
exit 0
