#!/usr/bin/env python3
"""三列对拍拼图（dev-only）：[官方参考帧 | 源 FBX 渲染帧 | VRM clip 渲染帧]

用途（见 docs/adv-acceptance-plan.md 两级验收）：
把「官方参考视频/GIF 抽帧」「源 FBX 渲染帧（render-source-fbx.py 产物）」「VRM 重定向后预览帧
（preview-hsr.mjs / preview-adv.mjs 产物）」按同一组时间标签拼成带时间戳的对比图，
用于人眼逐姿态对拍 + 差异记录。

两种模式：
1) 三列对比（默认）：
   python3 scripts/vrm/motion/build-compare-sheet.py \\
     --out work/adv-biped/qa/compare/idle \\
     --labels 000,020,040,060,080 \\
     --ref-video "work/ref-aventurine/clips/xilang_standby_battle_arena_戏浪战斗待机.mp4" \\
     --ref-times 0,2.12,4.24,6.36,8.49 \\
     --source-dir work/adv-biped/qa/render/idle --source-prefix idle \\
     --vrm-dir work/adv-biped/qa/preview --vrm-prefix idle \\
     --title "idle 三列对拍（原型）"
   输出：<out>/<name>-<view>-compare.jpg（每个 view 一张）、<out>/<name>-compare.jpg（全部 view）、
         <out>/<name>-compare-meta.json、<out>/ref-frames/<label>.png（参考帧缓存）。

   参考帧来源：
   a) --ref-video a.mp4/b.mp4   ffmpeg 按 --ref-times 抽帧（ffmpeg 默认用
      work/ref-aventurine/tools/bin/ffmpeg，无 ffprobe 时用 `ffmpeg -i` stderr 解析时长）；
   b) --ref-gif a.gif           Pillow 直接按帧时长累计抽帧（官方 wiki GIF 即此类）；
   c) --ref-dir dir [--ref-prefix p]  复用已抽好的参考帧（文件名含 label 即可）。

2) 接触表（render-source-fbx.py 自动调用）：
   python3 scripts/vrm/motion/build-compare-sheet.py --contact-only --meta render-meta.json --out DIR
   输出：<clipId>-<view>-sheet.jpg（横向 frames 条）+ <clipId>-sheet.jpg（views×frames 网格）。

时间标签约定：fraction 渲染产物用 3 位百分比（000/020/.../100，与 preview-hsr.mjs 的
`<clip>-<view>-<suffix>.png` 命名一致）；帧号渲染产物用 f0001 之类；--labels 可传任意标签，
此时参考帧时间必须显式给 --ref-times（秒，与 --labels 一一对应）。

缺图不会失败：对应格子画成「MISSING + 路径」占位，方便工具链未跑完时先出半成品对比图。
"""
import argparse
import datetime
import glob
import json
import os
import re
import shutil
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont, ImageSequence

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "..", ".."))
DEFAULT_FFMPEG = os.path.join(REPO_ROOT, "work", "ref-aventurine", "tools", "bin", "ffmpeg")

BG = (24, 26, 30)
PANEL = (36, 39, 45)
PANEL_ALT = (30, 33, 38)
TEXT = (234, 236, 240)
DIM = (148, 154, 166)
MISSING_BG = (52, 34, 38)
ACCENT = {"ref": (110, 168, 255), "source": (255, 168, 88), "vrm": (118, 220, 160)}
ROW_LABEL_W = 116
CAPTION_H = 26
TILE_PAD = 8

FONT_CANDIDATES = [
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/Library/Fonts/Arial.ttf",
]


def log(message):
    print("[compare-sheet] %s" % message, flush=True)


def fail(message, code=2):
    print("[compare-sheet] ERROR: %s" % message, flush=True)
    sys.exit(code)


_font_cache = {}


def load_font(size):
    if size in _font_cache:
        return _font_cache[size]
    for path in FONT_CANDIDATES:
        if not os.path.isfile(path):
            continue
        try:
            font = ImageFont.truetype(path, size)
        except (OSError, ValueError):
            continue
        _font_cache[size] = font
        return font
    font = ImageFont.load_default()
    _font_cache[size] = font
    return font


# --------------------------------------------------------------------------------------
# 参考帧抽取
# --------------------------------------------------------------------------------------
def resolve_ffmpeg(explicit):
    candidates = []
    if explicit:
        candidates.append(explicit)
    candidates.append(DEFAULT_FFMPEG)
    found = shutil.which("ffmpeg")
    if found:
        candidates.append(found)
    for candidate in candidates:
        if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def probe_duration(path, ffmpeg):
    """无 ffprobe 时从 `ffmpeg -i` 的 stderr 解析时长（秒）。"""
    ffmpeg = ffmpeg or resolve_ffmpeg(None)
    if not ffmpeg:
        return None
    result = subprocess.run([ffmpeg, "-hide_banner", "-i", path], capture_output=True, text=True)
    match = re.search(r"Duration:\s*(\d+):(\d+):(\d+)(?:\.(\d+))?", result.stderr or "")
    if not match:
        return None
    hours, minutes, seconds, frac = match.groups()
    total = int(hours) * 3600 + int(minutes) * 60 + int(seconds)
    if frac:
        total += float("0." + frac)
    return total


def extract_video_frame(ffmpeg, video, time_sec, dest, force=False):
    if os.path.isfile(dest) and not force:
        return dest
    if not ffmpeg:
        return None
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    command = [
        ffmpeg, "-hide_banner", "-loglevel", "error",
        "-ss", "%.3f" % max(time_sec, 0.0), "-i", video,
        "-frames:v", "1", "-y", dest,
    ]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0 or not os.path.isfile(dest) or os.path.getsize(dest) == 0:
        log("WARN ffmpeg 抽帧失败 t=%.3f: %s" % (time_sec, (result.stderr or "").strip().splitlines()[-1:] or ""))
        return None
    return dest


def load_gif_sequence(gif_path):
    frames = []
    durations = []
    image = Image.open(gif_path)
    for frame in ImageSequence.Iterator(image):
        frames.append(frame.convert("RGB").copy())
        durations.append(max(image.info.get("duration", 50) or 50, 1) / 1000.0)
    return frames, durations


def extract_gif_frame(gif_path, time_sec, dest, force=False):
    if os.path.isfile(dest) and not force:
        return dest
    frames, durations = load_gif_sequence(gif_path)
    if not frames:
        return None
    cumulative = []
    total = 0.0
    for duration in durations:
        cumulative.append(total)
        total += duration
    target = max(0.0, min(time_sec, max(total - 1e-6, 0.0)))
    index = 0
    for candidate, start in enumerate(cumulative):
        if start <= target + 1e-9:
            index = candidate
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    frames[index].save(dest)
    return dest


def find_pre_extracted_ref(directory, label, prefix):
    if not os.path.isdir(directory):
        return None
    candidates = []
    if prefix:
        for ext in ("png", "jpg", "jpeg", "webp"):
            candidates.append(os.path.join(directory, "%s-%s.%s" % (prefix, label, ext)))
            candidates.append(os.path.join(directory, "%s_%s.%s" % (prefix, label, ext)))
    for ext in ("png", "jpg", "jpeg", "webp"):
        candidates.append(os.path.join(directory, "%s.%s" % (label, ext)))
    for candidate in candidates:
        if os.path.isfile(candidate):
            return candidate
    matches = sorted(glob.glob(os.path.join(directory, "*%s*.png" % label)))
    if not matches:
        matches = sorted(glob.glob(os.path.join(directory, "*%s*.jpg" % label)))
    return matches[0] if matches else None


def parse_time_list(values, count):
    raw = [item.strip() for item in (values or "").split(",") if item.strip()]
    try:
        numbers = [float(item) for item in raw]
    except ValueError:
        fail("--ref-times 需要逗号分隔的秒数")
    if len(numbers) != count:
        fail("--ref-times 数量 %d 与 labels 数量 %d 不一致（必须一一对应）" % (len(numbers), count))
    return numbers


def percentile_labels(fractions):
    return ["%03d" % int(round(value * 100)) for value in fractions]


def parse_fractions(values):
    raw = [item.strip() for item in (values or "").split(",") if item.strip()]
    try:
        numbers = [float(item) for item in raw]
    except ValueError:
        fail("--frames 需要逗号分隔的 0-1 小数")
    for number in numbers:
        if number < -1e-6 or number > 1 + 1e-6:
            fail("--frames 取值需在 [0,1]：%r" % number)
    return [min(max(number, 0.0), 1.0) for number in numbers]


def resolve_ref_frames(args, labels, times):
    """返回 {label: 图片路径或 None}，并按需把抽出的参考帧缓存到 <out>/ref-frames/。"""
    ref_dir = os.path.join(args.out, "ref-frames")
    frames = {}
    if args.ref_dir:
        for label in labels:
            frames[label] = find_pre_extracted_ref(args.ref_dir, label, args.ref_prefix)
        return frames
    if args.ref_video:
        ffmpeg = resolve_ffmpeg(args.ffmpeg)
        if not ffmpeg:
            fail("需要 ffmpeg 抽参考帧，但未找到（--ffmpeg 指定，或确认 work/ref-aventurine/tools/bin/ffmpeg）")
        for label, time_sec in zip(labels, times):
            frames[label] = extract_video_frame(
                ffmpeg, os.path.abspath(args.ref_video), time_sec,
                os.path.join(ref_dir, "%s.png" % label), force=args.force_ref,
            )
        return frames
    if args.ref_gif:
        for label, time_sec in zip(labels, times):
            frames[label] = extract_gif_frame(
                os.path.abspath(args.ref_gif), time_sec,
                os.path.join(ref_dir, "%s.png" % label), force=args.force_ref,
            )
        return frames
    return frames


# --------------------------------------------------------------------------------------
# 列图片解析
# --------------------------------------------------------------------------------------
def resolve_column_image(directory, prefix, pattern, view, label, side):
    if not directory:
        return None
    directory = os.path.abspath(directory)
    if pattern:
        try:
            relative = pattern.format(prefix=prefix or "", view=view, label=label, side=side)
        except KeyError:
            fail("--%s-pattern 只支持 {prefix}/{view}/{label}/{side} 占位符" % side)
        candidate = os.path.join(directory, relative)
        if os.path.isfile(candidate):
            return candidate
        matches = sorted(glob.glob(candidate))
        if matches:
            return matches[0]
        return None
    extensions = ("png", "jpg", "jpeg", "webp")
    if prefix:
        for ext in extensions:
            candidate = os.path.join(directory, "%s-%s-%s.%s" % (prefix, view, label, ext))
            if os.path.isfile(candidate):
                return candidate
    for ext in extensions:
        candidate = os.path.join(directory, "*-%s-%s.%s" % (view, label, ext))
        matches = sorted(glob.glob(candidate))
        if matches:
            return matches[0]
    for ext in extensions:
        matches = sorted(glob.glob(os.path.join(directory, "*%s*%s*.%s" % (view, label, ext))))
        if matches:
            return matches[0]
    return None


def read_render_meta(directory):
    if not directory:
        return None
    path = os.path.join(os.path.abspath(directory), "render-meta.json")
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def meta_frame_lookup(meta):
    lookup = {}
    if not meta:
        return lookup
    for entry in meta.get("frames", []):
        lookup[entry.get("label")] = entry
    return lookup


# --------------------------------------------------------------------------------------
# 通用绘图
# --------------------------------------------------------------------------------------
def fit_image(image, max_width, max_height, background=BG):
    """按比例缩放到 cell 内，不足处补背景色（不拉伸、不放大到超过原图 1.6 倍）。"""
    scale = min(max_width / max(image.width, 1), max_height / max(image.height, 1), 1.6)
    new_size = (max(1, int(round(image.width * scale))), max(1, int(round(image.height * scale))))
    resized = image.convert("RGB").resize(new_size, Image.LANCZOS)
    cell = Image.new("RGB", (max_width, max_height), background)
    cell.paste(resized, ((max_width - new_size[0]) // 2, (max_height - new_size[1]) // 2))
    return cell


def load_image(path):
    if not path or not os.path.isfile(path):
        return None
    try:
        image = Image.open(path)
        image.load()
        return image.convert("RGB")
    except (OSError, ValueError) as error:
        log("WARN 读图失败 %s: %s" % (path, error))
        return None


def draw_missing_tile(draw, box, label, path, cell_width, cell_height):
    left, top = box
    draw.rectangle([left, top, left + cell_width, top + cell_height], fill=MISSING_BG, outline=(150, 70, 70))
    font_small = load_font(15)
    draw.text((left + 8, top + 8), "MISSING", fill=(255, 140, 140), font=font_small)
    tail = path if path else label
    if len(tail) > 46:
        tail = "…" + tail[-45:]
    draw.text((left + 8, top + 30), tail, fill=DIM, font=load_font(13))


def tile_with_border(image, cell_width, cell_height):
    tile = fit_image(image, cell_width, cell_height, PANEL_ALT)
    draw = ImageDraw.Draw(tile)
    draw.rectangle([0, 0, cell_width - 1, cell_height - 1], outline=(64, 68, 76))
    return tile


# --------------------------------------------------------------------------------------
# 模式 1：三列对比
# --------------------------------------------------------------------------------------
def build_compare_sheet(args):
    if not args.source_dir:
        fail("三列对比模式缺少 --source-dir（render-source-fbx.py 输出目录）")
    labels = [item.strip() for item in (args.labels or "").split(",") if item.strip()]
    if args.frames:
        if labels:
            fail("--labels 与 --frames 只能给一个（--frames 会自动换算成百分比标签）")
        labels = percentile_labels(parse_fractions(args.frames))
    if not labels:
        fail("缺少 --labels 或 --frames")
    views = [item.strip() for item in (args.views or "front,side,threeQuarter").split(",") if item.strip()]
    os.makedirs(args.out, exist_ok=True)

    # ---- 列组合：参考列（可选）+ 源 FBX 列（必需）+ VRM 列（可选） ----
    ref_mode = None
    if args.ref_video:
        ref_mode = "video"
    elif args.ref_gif:
        ref_mode = "gif"
    elif args.ref_dir:
        ref_mode = "dir-view" if args.ref_pattern else "dir"
    if ref_mode is None and not args.vrm_dir:
        fail("至少需要参考素材（--ref-video/--ref-gif/--ref-dir）或 --vrm-dir 之一，否则没有可对比列")

    # 参考帧时间（仅视频/GIF 需要；dir 模式标签即文件名）
    times = []
    resolution = {"labels": labels, "times": [], "duration": None}
    ref_frames = {}
    if ref_mode in ("video", "gif"):
        if args.ref_times:
            times = parse_time_list(args.ref_times, len(labels))
        else:
            duration = args.ref_duration
            if duration is None:
                duration = probe_duration(os.path.abspath(args.ref_video or args.ref_gif),
                                          resolve_ffmpeg(args.ffmpeg))
            if duration is None:
                fail("无法确定参考素材时长：请给 --ref-times，或 --ref-duration（秒）")
            if args.ref_fraction:
                fractions = parse_fractions(args.ref_fraction)
                if len(fractions) != len(labels):
                    fail("--ref-fraction 数量与 labels 数量不一致")
                times = [value * duration for value in fractions]
            else:
                try:
                    times = [int(label) / 100.0 * duration for label in labels]
                except ValueError:
                    fail("标签非百分比时请显式给 --ref-times（秒）")
        used_duration = args.ref_duration
        if used_duration is None:
            used_duration = probe_duration(os.path.abspath(args.ref_video or args.ref_gif),
                                           resolve_ffmpeg(args.ffmpeg)) or 0.0
        resolution = {"labels": labels, "times": [round(value, 3) for value in times],
                      "duration": round(used_duration, 3)}
        ref_frames = resolve_ref_frames(args, labels, times)
    elif ref_mode == "dir":
        ref_frames = resolve_ref_frames(args, labels, [0.0] * len(labels))

    source_meta = read_render_meta(args.source_dir)
    source_lookup = meta_frame_lookup(source_meta)
    vrm_meta = read_render_meta(args.vrm_dir)
    vrm_lookup = meta_frame_lookup(vrm_meta)

    cell_height = args.cell_height
    cell_width = args.cell_width or int(round(cell_height * 0.75))
    ref_crop = None
    if args.ref_crop:
        try:
            parts = [float(item) for item in args.ref_crop.split(",")]
        except ValueError:
            fail("--ref-crop 需要 4 个 0-1 小数：x,y,w,h")
        if len(parts) != 4 or any(value < 0 or value > 1 for value in parts):
            fail("--ref-crop 需要 4 个 0-1 小数：x,y,w,h")
        ref_crop = parts

    def crop_ref(image):
        """按 x,y,w,h 比例裁剪参考帧（1080p 全身镜头里角色很小，裁到角色区域可读性更好）。"""
        if image is None or not ref_crop:
            return image
        x, y, w, h = ref_crop
        left = int(round(x * image.width))
        top = int(round(y * image.height))
        right = int(round((x + w) * image.width))
        bottom = int(round((y + h) * image.height))
        left, top = max(left, 0), max(top, 0)
        right, bottom = min(right, image.width), min(bottom, image.height)
        if right - left < 2 or bottom - top < 2:
            return image
        return image.crop((left, top, right, bottom))

    columns = []
    if ref_mode is not None:
        columns.append({"key": "ref", "title": args.ref_label, "color": ACCENT["ref"]})
    columns.append({"key": "source", "title": args.source_label, "color": ACCENT["source"]})
    if args.vrm_dir:
        columns.append({"key": "vrm", "title": args.vrm_label, "color": ACCENT["vrm"]})
    title = args.title or "%s 对拍" % args.name
    header_height = 96
    footer_lines = []
    if ref_mode is not None:
        footer_lines.append("参考: %s" % (args.ref_video or args.ref_gif or args.ref_dir or "（无）"))
    footer_lines.append("源 FBX: %s（render-source-fbx.py）" % (args.source_dir or "（无）"))
    if args.vrm_dir:
        footer_lines.append("VRM: %s（preview-hsr.mjs / preview-adv.mjs）" % args.vrm_dir)
    if times:
        footer_lines.append("时间: %s" % ", ".join("%s=%.2fs" % (label, time_sec)
                                                   for label, time_sec in zip(labels, times)))
    footer_lines.extend("备注: %s" % note for note in (args.note or []))
    footer_height = 18 + len(footer_lines) * 22
    gap = 10
    sheet_width = ROW_LABEL_W + len(columns) * (cell_width + gap) + gap
    sheet_height = header_height + len(labels) * (cell_height + CAPTION_H + gap) + footer_height + gap

    def compose(views_subset, sheet_title):
        views_list = list(views_subset)
        total_height = sheet_height * len(views_list) + (len(views_list) - 1) * 16
        canvas = Image.new("RGB", (sheet_width, total_height), BG)
        draw = ImageDraw.Draw(canvas)
        for view_index, view in enumerate(views_list):
            offset_y = view_index * (sheet_height + 16)
            draw.rectangle([0, offset_y, sheet_width, offset_y + sheet_height - 1], fill=BG, outline=(52, 56, 64))
            draw.text((18, offset_y + 14), "%s · %s" % (sheet_title, view),
                      fill=TEXT, font=load_font(24))
            # 列标题
            for column_index, column in enumerate(columns):
                column_left = ROW_LABEL_W + column_index * (cell_width + gap) + gap
                draw.text((column_left, offset_y + 56), column["title"],
                          fill=column["color"], font=load_font(19))
            # 每帧一行
            for row_index, label in enumerate(labels):
                row_top = offset_y + header_height + row_index * (cell_height + CAPTION_H + gap)
                draw.rectangle(
                    [ROW_LABEL_W - 6, row_top - 2, ROW_LABEL_W + len(columns) * (cell_width + gap) + gap,
                     row_top + cell_height + CAPTION_H - 2],
                    fill=PANEL_ALT if row_index % 2 == 0 else PANEL,
                )
                draw.text((16, row_top + 6), "%s%%" % (int(label) if label.isdigit() else label),
                          fill=TEXT, font=load_font(20))
                if times:
                    draw.text((16, row_top + 32), "t=%.2fs" % times[row_index], fill=DIM, font=load_font(16))
                for column_index, column in enumerate(columns):
                    column_left = ROW_LABEL_W + column_index * (cell_width + gap) + gap
                    if column["key"] == "ref":
                        if ref_mode == "dir-view":
                            path = resolve_column_image(args.ref_dir, args.ref_prefix, args.ref_pattern,
                                                        view, label, "ref")
                        else:
                            path = ref_frames.get(label)
                    elif column["key"] == "source":
                        path = resolve_column_image(args.source_dir, args.source_prefix, args.source_pattern,
                                                    view, label, "source")
                    else:
                        path = resolve_column_image(args.vrm_dir, args.vrm_prefix, args.vrm_pattern,
                                                    view, label, "vrm")
                    image = load_image(path)
                    if column["key"] == "ref":
                        image = crop_ref(image)
                    if image is None:
                        draw_missing_tile(draw, (column_left, row_top), label, path, cell_width, cell_height)
                    else:
                        canvas.paste(tile_with_border(image, cell_width, cell_height), (column_left, row_top))
                    # 单格 caption
                    caption = "%s" % label
                    if column["key"] == "source" and label in source_lookup:
                        entry = source_lookup[label]
                        if entry.get("frame") is not None:
                            caption = "%s · f=%.0f" % (label, entry["frame"])
                    elif column["key"] == "vrm" and label in vrm_lookup:
                        entry = vrm_lookup[label]
                        if entry.get("frame") is not None:
                            caption = "%s · f=%.0f" % (label, entry["frame"])
                    draw.text((column_left + 2, row_top + cell_height + 4), caption,
                              fill=DIM, font=load_font(14))
            # footer
            footer_top = offset_y + header_height + len(labels) * (cell_height + CAPTION_H + gap) + 6
            for line_index, line in enumerate(footer_lines):
                draw.text((18, footer_top + line_index * 22), line, fill=DIM, font=load_font(14))
        return canvas

    outputs = {}
    for view in views:
        canvas = compose([view], title)
        path = os.path.join(args.out, "%s-%s-compare.jpg" % (args.name, view))
        canvas.save(path, quality=args.jpeg_quality)
        outputs[view] = path
        log("compare %-13s -> %s" % (view, path))
    canvas = compose(views, title)
    combined = os.path.join(args.out, "%s-compare.jpg" % args.name)
    canvas.save(combined, quality=args.jpeg_quality)
    outputs["all"] = combined
    log("compare all -> %s" % combined)

    meta = {
        "schemaVersion": 1,
        "generatedAt": datetime.datetime.now().astimezone().isoformat(),
        "title": title,
        "name": args.name,
        "labels": labels,
        "views": views,
        "columns": [column["key"] for column in columns],
        "refMode": ref_mode,
        "refTimes": resolution,
        "ref": {"video": args.ref_video, "gif": args.ref_gif, "dir": args.ref_dir,
                "prefix": args.ref_prefix, "pattern": args.ref_pattern, "label": args.ref_label,
                "crop": ref_crop},
        "source": {"dir": args.source_dir, "prefix": args.source_prefix,
                   "pattern": args.source_pattern, "label": args.source_label,
                   "renderMeta": os.path.join(os.path.abspath(args.source_dir), "render-meta.json")
                   if source_meta else None},
        "vrm": {"dir": args.vrm_dir, "prefix": args.vrm_prefix, "pattern": args.vrm_pattern,
                "label": args.vrm_label},
        "outputs": outputs,
        "refFrames": ref_frames,
        "notes": args.note or [],
    }
    meta_path = os.path.join(args.out, "%s-compare-meta.json" % args.name)
    with open(meta_path, "w", encoding="utf-8") as handle:
        json.dump(meta, handle, ensure_ascii=False, indent=2)
    log("meta -> %s" % meta_path)
    print("COMPARE_JSON " + json.dumps({"ok": True, "outputs": outputs, "metaPath": meta_path},
                                       ensure_ascii=False), flush=True)
    return outputs


# --------------------------------------------------------------------------------------
# 模式 2：接触表（render-source-fbx.py 渲染产物）
# --------------------------------------------------------------------------------------
def build_contact_sheets(args):
    if not args.meta:
        fail("--contact-only 需要 --meta <render-meta.json>")
    if not os.path.isfile(args.meta):
        fail("--meta 不存在：%s" % args.meta)
    with open(args.meta, "r", encoding="utf-8") as handle:
        meta = json.load(handle)
    clip_id = meta.get("clipId") or "clip"
    views = list(meta.get("images", {}).keys())
    if not views:
        fail("render-meta.json 里没有 images")
    frames = [entry.get("label") for entry in meta.get("frames", [])]
    if not frames:
        fail("render-meta.json 里没有 frames")
    out_dir = args.out or os.path.dirname(os.path.abspath(args.meta))
    os.makedirs(out_dir, exist_ok=True)
    scale = args.contact_scale

    # 统一 tile 尺寸（所有 view/res 应相同，取最大）
    probe_paths = [entry["path"] for view in views for entry in meta["images"][view][:1]]
    width = height = 0
    for path in probe_paths:
        image = load_image(path)
        if image is not None:
            width = max(width, image.width)
            height = max(height, image.height)
    if width == 0:
        fail("接触表：所有 PNG 都读不到")
    width = int(round(width * scale))
    height = int(round(height * scale))
    label_h = int(round(30 * max(scale, 0.7)))
    gap = 8

    frame_lookup = {entry.get("label"): entry for entry in meta.get("frames", [])}
    outputs = {}

    def tile_for(view, label):
        entry = next((item for item in meta["images"][view] if item.get("label") == label), None)
        path = entry.get("path") if entry else None
        image = load_image(path)
        if image is None:
            placeholder = Image.new("RGB", (width, height), MISSING_BG)
            draw = ImageDraw.Draw(placeholder)
            draw.text((10, 10), "MISSING", fill=(255, 140, 140), font=load_font(16))
            return placeholder
        if scale != 1.0:
            image = image.resize((width, height), Image.LANCZOS)
        return image.convert("RGB")

    # 每个 view 的横向条
    header = int(round(46 * max(scale, 0.7)))
    strip_width = gap + len(frames) * (width + gap)
    strip_height = header + height + label_h + gap
    for view in views:
        canvas = Image.new("RGB", (strip_width, strip_height), BG)
        draw = ImageDraw.Draw(canvas)
        draw.text((gap + 2, 8), "%s · %s · 源 FBX 渲染接触表" % (clip_id, view),
                  fill=TEXT, font=load_font(int(round(22 * max(scale, 0.7)))))
        for column_index, label in enumerate(frames):
            left = gap + column_index * (width + gap)
            top = header
            canvas.paste(tile_for(view, label), (left, top))
            draw.rectangle([left, top, left + width - 1, top + height - 1], outline=(62, 66, 74))
            entry = frame_lookup.get(label, {})
            caption = "%s" % label
            if entry.get("timeSec") is not None:
                caption += "  t=%.2fs" % entry["timeSec"]
            draw.text((left + 2, top + height + 4), caption, fill=DIM, font=load_font(14))
        path = os.path.join(out_dir, "%s-%s-sheet.jpg" % (clip_id, view))
        canvas.save(path, quality=args.jpeg_quality)
        outputs[view] = path
        log("contact %-13s -> %s" % (view, path))

    # views × frames 总网格
    grid_width = ROW_LABEL_W + len(frames) * (width + gap) + gap
    grid_height = header + len(views) * (height + label_h + gap)
    canvas = Image.new("RGB", (grid_width, grid_height), BG)
    draw = ImageDraw.Draw(canvas)
    draw.text((gap + 2, 8), "%s · 源 FBX 渲染总接触表（views × frames）" % clip_id,
              fill=TEXT, font=load_font(int(round(22 * max(scale, 0.7)))))
    for row_index, view in enumerate(views):
        row_top = header + row_index * (height + label_h + gap)
        draw.text((10, row_top + height // 2 - 8), view, fill=ACCENT["source"], font=load_font(16))
        for column_index, label in enumerate(frames):
            left = ROW_LABEL_W + column_index * (width + gap) + gap
            canvas.paste(tile_for(view, label), (left, row_top))
            draw.rectangle([left, row_top, left + width - 1, row_top + height - 1], outline=(62, 66, 74))
    combined_path = os.path.join(out_dir, "%s-sheet.jpg" % clip_id)
    canvas.save(combined_path, quality=args.jpeg_quality)
    outputs["all"] = combined_path
    log("contact all -> %s" % combined_path)
    print("CONTACT_JSON " + json.dumps({"ok": True, "outputs": outputs}, ensure_ascii=False), flush=True)
    return outputs


# --------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------
def parse_args(argv):
    parser = argparse.ArgumentParser(
        description="三列对拍拼图：[官方参考帧 | 源 FBX 渲染帧 | VRM clip 渲染帧]",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--out", required=True, help="输出目录")
    parser.add_argument("--name", default="compare", help="输出文件名前缀（默认 compare）")
    parser.add_argument("--title", default="", help="标题")
    parser.add_argument("--note", action="append", default=[], help="附加备注行（可重复）")
    parser.add_argument("--labels", default="", help="逗号分隔标签：000,020,... 或 f0001；与源/VRM 文件名后缀一致")
    parser.add_argument("--frames", default="", help="逗号分隔 0-1 比例（自动换算成 3 位百分比标签）")
    parser.add_argument("--views", default="front,side,threeQuarter", help="逗号分隔 view 列表")
    parser.add_argument("--ref-video", default="", help="参考视频（mp4/mov/webm）")
    parser.add_argument("--ref-gif", default="", help="参考 GIF（Pillow 直接抽帧）")
    parser.add_argument("--ref-dir", default="", help="已抽好的参考帧目录（文件名含 <label>）")
    parser.add_argument("--ref-prefix", default="", help="参考帧文件名前缀（默认 <prefix>-<label>.png）")
    parser.add_argument("--ref-pattern", default="",
                        help="参考帧按 view 的文件名模板（{prefix}/{view}/{label}），用于「源渲染当参考」的两列模式")
    parser.add_argument("--ref-crop", default="",
                        help="参考帧裁剪比例 x,y,w,h（0-1），例如 0.25,0.05,0.35,0.9；1080p 全身镜头裁到角色区域")
    parser.add_argument("--ref-times", default="", help="参考帧时间戳（秒），与 labels 一一对应")
    parser.add_argument("--ref-fraction", default="", help="参考帧相对时长比例（与 --frames 同义）")
    parser.add_argument("--ref-duration", type=float, default=None, help="参考素材时长（秒；缺省自动探测）")
    parser.add_argument("--ref-label", default="官方参考", help="第一列标题")
    parser.add_argument("--source-dir", default="", help="源 FBX 渲染目录（render-source-fbx.py --out）")
    parser.add_argument("--source-prefix", default="", help="源图文件名前缀（默认 <prefix>-<view>-<label>.png）")
    parser.add_argument("--source-pattern", default="", help="源图文件名模板（{prefix}/{view}/{label}）")
    parser.add_argument("--source-label", default="源 FBX 渲染", help="第二列标题")
    parser.add_argument("--vrm-dir", default="", help="VRM 预览目录（preview-hsr.mjs --out）")
    parser.add_argument("--vrm-prefix", default="", help="VRM 图文件名前缀")
    parser.add_argument("--vrm-pattern", default="", help="VRM 图文件名模板")
    parser.add_argument("--vrm-label", default="VRM clip 渲染", help="第三列标题")
    parser.add_argument("--ffmpeg", default="", help="ffmpeg 路径（默认 work/ref-aventurine/tools/bin/ffmpeg）")
    parser.add_argument("--force-ref", action="store_true", help="强制重新抽取参考帧")
    parser.add_argument("--cell-height", type=int, default=480, help="单元格高度（默认 480）")
    parser.add_argument("--cell-width", type=int, default=0, help="单元格宽度（默认 cell-height×0.75）")
    parser.add_argument("--jpeg-quality", type=int, default=90, help="JPEG 质量（默认 90）")
    parser.add_argument("--contact-only", action="store_true", help="接触表模式（配 --meta）")
    parser.add_argument("--meta", default="", help="render-meta.json（--contact-only 用）")
    parser.add_argument("--contact-scale", type=float, default=1.0, help="接触表缩放（默认 1.0）")
    return parser.parse_args(argv)


def main():
    args = parse_args(sys.argv[1:])
    if args.contact_only:
        build_contact_sheets(args)
    else:
        build_compare_sheet(args)


if __name__ == "__main__":
    main()
