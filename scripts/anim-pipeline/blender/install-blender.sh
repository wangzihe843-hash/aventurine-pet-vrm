#!/usr/bin/env bash
# Install Blender 4.2 LTS (macOS arm64) + MMD Tools outside the repository,
# without sudo and without Homebrew. Reproduces the exact commands validated on
# 2026-11-08 (macOS 27.0.1 arm64).
#
#   bash scripts/anim-pipeline/blender/install-blender.sh
#
# Environment overrides (all optional):
#   TOOLS_ROOT       default: /Volumes/4TB外置盘/deepseek-harness/tools
#   BLENDER_VERSION  default: 4.2.23 (latest 4.2 LTS seen from the mirrors)
#   MMD_TOOLS_VER    default: 4.5.14 (release asset suffix "-bl4.2")
#   BLENDER_DMG_SHA256 / MMD_TOOLS_ZIP_SHA256
#                    override the pinned hashes when intentionally bumping versions
#
# Notes discovered during the validation run:
#   * download.blender.org is behind a Cloudflare challenge and returns HTTP 403
#     to curl (even with a browser UA). Use an official mirror instead; the two
#     tested here serve the same bytes (CRC32/sha256 verified).
#   * Downloads are pinned by sha256 (BLENDER_DMG_SHA256 / MMD_TOOLS_ZIP_SHA256,
#     verified 2026-11-10) and checked before use; a mismatch aborts the install.
#   * `xattr -dr com.apple.quarantine` was deliberately removed. Blender.app is
#     Developer ID signed + notarized by the Blender Foundation; the pinned DMG
#     hash and `codesign --verify --deep --strict` are the trust anchor instead
#     of stripping the quarantine bit.
#   * `hdiutil attach ... -mountpoint <dir-on-external-volume>` fails with
#     "权限被拒绝" (permission denied); mounting to the default /Volumes/<name>
#     works. This script therefore auto-mounts and copies with ditto.
#   * The MMD Tools zip is an extension package; install it with Blender's own
#     CLI so its bundled wheel (opencc) is registered correctly.
set -euo pipefail

TOOLS_ROOT="${TOOLS_ROOT:-/Volumes/4TB外置盘/deepseek-harness/tools}"
BLENDER_VERSION="${BLENDER_VERSION:-4.2.23}"
MMD_TOOLS_VER="${MMD_TOOLS_VER:-4.5.14}"
# --- pin: 版本对应的 SHA256（2026-11-10 核对） --------------------------------
# Blender 4.2.23 macos-arm64 DMG（来源：mirrors.dotsrc.org 的 blender-4.2.23.sha256，
# ftp.nluug.nl 镜像同值；本机 downloads/ 实文件复算一致）。
BLENDER_DMG_SHA256="${BLENDER_DMG_SHA256:-8b6bc5fafd4773e94bb863ca19ba1c9a54d096eecbbc4375eae7dbc3b49fab40}"
# MMD Tools 4.5.14 bl4.2 extension zip（官方 GitHub release asset，803,729 B）。
MMD_TOOLS_ZIP_SHA256="${MMD_TOOLS_ZIP_SHA256:-ed3b78184ae9862be0df04e2e147803d011ad067edd8c31029c92fb719e19a6f}"
MIRROR="${BLENDER_MIRROR:-https://mirrors.dotsrc.org/blender/release}"
FALLBACK_MIRROR="${BLENDER_FALLBACK_MIRROR:-https://ftp.nluug.nl/pub/graphics/blender/release}"

BLENDER_DIR="$TOOLS_ROOT/blender"
BLENDER_APP="$BLENDER_DIR/Blender.app"
BLENDER_BIN="$BLENDER_APP/Contents/MacOS/Blender"
DOWNLOADS="$TOOLS_ROOT/downloads"
DMG_NAME="blender-$BLENDER_VERSION-macos-arm64.dmg"
MMD_ZIP_NAME="mmd_tools-v$MMD_TOOLS_VER-bl4.2.zip"
MMD_ZIP_URL="https://github.com/MMD-Blender/blender_mmd_tools/releases/download/v$MMD_TOOLS_VER/$MMD_ZIP_NAME"

mkdir -p "$BLENDER_DIR" "$DOWNLOADS"

log() { printf '[install-blender] %s\n' "$*"; }
warn() { printf '[install-blender] WARN: %s\n' "$*" >&2; }
die() { printf '[install-blender] ERROR: %s\n' "$*" >&2; exit 1; }

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

# $1=file $2=expected sha256 $3=label；不匹配返回 1（由调用方 die/清理）
verify_sha256() {
  local file="$1" expected="$2" label="$3" actual
  actual="$(sha256_of "$file")"
  if [ "$actual" != "$expected" ]; then
    printf '[install-blender] ERROR: %s sha256 mismatch: expected %s, got %s (%s)\n' \
      "$label" "$expected" "$actual" "$file" >&2
    return 1
  fi
  log "$label sha256 OK ($actual)"
  return 0
}

# Blender.app 官方 Developer ID 签名 + 公证；安装后立即用 codesign 校验。
# $1=app $2=context(fresh|existing)。existing 允许 Blender 自身运行后生成的
# __pycache__/*.pyc（会出现在 CodeResources 之外，导致 --deep --strict 报 file added）；
# 其它任何签名漂移仍然失败。
verify_blender_signature() {
  local app="$1" context="$2" output unexpected
  if output="$(codesign --verify --deep --strict --verbose=4 "$app" 2>&1)"; then
    log "codesign --verify --deep --strict OK: $app"
    return 0
  fi
  if [ "$context" = "existing" ]; then
    unexpected="$(printf '%s\n' "$output" \
      | grep -E '^(file added|file modified|file missing):' \
      | grep -v '__pycache__/' || true)"
    if printf '%s\n' "$output" | grep -q 'file added: .*__pycache__/' && [ -z "$unexpected" ]; then
      warn "codesign --deep --strict flagged only Blender-generated __pycache__ files;"
      warn "treating as benign bundle drift (delete the .pyc files or reinstall to silence)"
      return 0
    fi
  fi
  printf '[install-blender] ERROR: codesign verification failed for %s:\n%s\n' "$app" "$output" >&2
  return 1
}

# ---------------------------------------------------------------- 1. Blender
BLENDER_FRESHLY_INSTALLED=0
if [ -x "$BLENDER_BIN" ]; then
  log "Blender already installed at $BLENDER_APP"
else
  DMG="$DOWNLOADS/$DMG_NAME"
  if [ ! -s "$DMG" ] || [ "$(stat -f%z "$DMG")" -lt 300000000 ]; then
    log "downloading $DMG_NAME from $MIRROR"
    rm -f "$DMG.part"
    if ! curl -L --fail --retry 3 --connect-timeout 20 -o "$DMG.part" \
      "$MIRROR/Blender4.2/$DMG_NAME"; then
      if ! curl -L --fail --retry 3 --connect-timeout 20 -o "$DMG.part" \
        "$FALLBACK_MIRROR/Blender4.2/$DMG_NAME"; then
        rm -f "$DMG.part"
        die "failed to download $DMG_NAME from $MIRROR and $FALLBACK_MIRROR"
      fi
    fi
    verify_sha256 "$DMG.part" "$BLENDER_DMG_SHA256" "Blender DMG" || {
      rm -f "$DMG.part"
      die "Blender DMG sha256 mismatch (pinned $BLENDER_VERSION; set BLENDER_DMG_SHA256 when bumping versions)"
    }
    mv "$DMG.part" "$DMG"
  else
    log "using cached $DMG_NAME"
    verify_sha256 "$DMG" "$BLENDER_DMG_SHA256" "Blender DMG" || \
      die "cached Blender DMG sha256 mismatch (delete $DMG and rerun; pinned $BLENDER_VERSION)"
  fi

  MOUNT_POINT="$(hdiutil attach -nobrowse -readonly "$DMG" | awk -F'\t' '/\/Volumes\// {print $NF; exit}')"
  if [ -z "${MOUNT_POINT:-}" ] || [ ! -d "$MOUNT_POINT/Blender.app" ]; then
    log "ERROR: could not locate mounted Blender.app (mount='${MOUNT_POINT:-}')" >&2
    exit 1
  fi
  # 先校验只读挂载点里的原始 app（此时尚未运行 Blender，签名必须完整），再复制。
  verify_blender_signature "$MOUNT_POINT/Blender.app" fresh || {
    hdiutil detach "$MOUNT_POINT" -force >/dev/null 2>&1 || true
    die "mounted Blender.app failed codesign verification; refusing to install"
  }
  log "mounting $DMG at $MOUNT_POINT and copying Blender.app"
  ditto "$MOUNT_POINT/Blender.app" "$BLENDER_APP"
  hdiutil detach "$MOUNT_POINT" -force >/dev/null 2>&1 || diskutil eject "$MOUNT_POINT" >/dev/null 2>&1 || true
  BLENDER_FRESHLY_INSTALLED=1
  verify_blender_signature "$BLENDER_APP" fresh || die "copied Blender.app failed codesign verification"
fi

chmod +x "$BLENDER_BIN" || true

# 故意不再执行 `xattr -dr com.apple.quarantine "$BLENDER_APP"`：剥离隔离位是绕过
# Gatekeeper 的 workaround，不是安装步骤。Blender.app 由 Blender Foundation 官方
# Developer ID 签名并公证；上面的 pinned sha256 + codesign --verify --deep --strict
# 已校验来源与完整性。若系统仍拦截，请从官方/可信镜像重新获取，而不是去掉隔离位。
if [ "$BLENDER_FRESHLY_INSTALLED" = "1" ]; then
  log "Blender.app signature verified (mounted + copied)"
else
  # 已安装的 app 可能被 Blender 自身运行写入了 __pycache__（已知 benign 漂移）。
  verify_blender_signature "$BLENDER_APP" existing || \
    die "existing Blender.app failed codesign verification (reinstall from the pinned DMG)"
fi

log "Blender binary: $BLENDER_BIN"
"$BLENDER_BIN" --version | head -3

# ------------------------------------------------------------- 2. MMD Tools
MMD_ZIP="$DOWNLOADS/$MMD_ZIP_NAME"
if [ ! -s "$MMD_ZIP" ]; then
  log "downloading $MMD_ZIP_NAME"
  rm -f "$MMD_ZIP.part"
  curl -L --fail --retry 3 --connect-timeout 20 -o "$MMD_ZIP.part" "$MMD_ZIP_URL" || {
    rm -f "$MMD_ZIP.part"
    die "failed to download $MMD_ZIP_NAME from $MMD_ZIP_URL"
  }
  verify_sha256 "$MMD_ZIP.part" "$MMD_TOOLS_ZIP_SHA256" "MMD Tools zip" || {
    rm -f "$MMD_ZIP.part"
    die "MMD Tools zip sha256 mismatch (pinned $MMD_TOOLS_VER; set MMD_TOOLS_ZIP_SHA256 when bumping versions)"
  }
  mv "$MMD_ZIP.part" "$MMD_ZIP"
else
  log "using cached $MMD_ZIP_NAME"
  verify_sha256 "$MMD_ZIP" "$MMD_TOOLS_ZIP_SHA256" "MMD Tools zip" || \
    die "cached MMD Tools zip sha256 mismatch (delete $MMD_ZIP and rerun; pinned $MMD_TOOLS_VER)"
fi

# `extension install-file -r user_default -e` installs into Blender's standard user
# extension repo (macOS: ~/Library/Application Support/Blender/4.2/extensions/user_default)
# and enables it. BLENDER_USER_CONFIG cannot relocate this repo, so it stays per-user.
log "installing MMD Tools extension$([ "$(uname)" = Darwin ] && echo " (repo user_default)")"
if ! "$BLENDER_BIN" --command extension list 2>/dev/null | grep -q "mmd_tools"; then
  "$BLENDER_BIN" --command extension install-file -r user_default -e "$MMD_ZIP"
else
  log "MMD Tools already installed"
fi

# ------------------------------------------------------------- 3. Smoke test
log "smoke test: enable MMD Tools + import operators in --background"
"$BLENDER_BIN" -b --factory-startup --python-expr "
import bpy
try:
    bpy.ops.preferences.addon_enable(module='bl_ext.user_default.mmd_tools')
except Exception:
    bpy.ops.preferences.addon_enable(module='mmd_tools')
assert hasattr(bpy.ops.mmd_tools, 'import_model'), 'import_model missing'
assert hasattr(bpy.ops.mmd_tools, 'export_vpd'), 'export_vpd missing'
print('MMD_TOOLS_OK', bpy.app.version_string)
" 2>&1 | grep -E "MMD_TOOLS_OK|Error" || true

cat <<EOF

Installed:
  Blender   $BLENDER_BIN  (expected 4.2.23 LTS)
  MMD Tools extension v$MMD_TOOLS_VER (blender_version_min 4.2.0, bl4.2 build)

Use the headless pipeline (from the repo root):
  BL="$BLENDER_BIN"
  "\$BL" -b --factory-startup --python scripts/anim-pipeline/blender/render_views.py -- \\
    --pmx "\$PWD/assets/model/optimized/星穹铁道—砂金·戏浪.pmx" \\
    --out "\$PWD/tests/tmp/blender-probe" --views front,side,three-quarter,back

No sudo, no Homebrew, nothing written into the repository by this script.
EOF
