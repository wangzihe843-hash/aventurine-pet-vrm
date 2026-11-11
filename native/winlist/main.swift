// 窗口枚举助手（A4）—— `CGWindowListCopyWindowInfo` 最小封装。
//
// 用途：给主进程（`src/main/desktop/winlist.ts`）提供屏幕内窗口列表（id / pid / owner /
// layer / alpha / bounds / onScreen），供 B5 桌面感知（坐窗口上沿、跟随移动、关闭落下）
// 与 C1 真实拖窗使用。
//
// 权限：**不需要屏幕录制权限**。窗口标题（kCGWindowName）才需要录屏权限，本助手不读取标题；
// bounds / pid / layer / owner / alpha 都是公开元数据（PLAN §10 已实测）。
//
// 用法：
//   winlist --json     输出单个 JSON 数组到 stdout（默认行为，显式传 --json 也接受）
//   winlist --help     打印用法
//
// 退出码：成功 0；参数错误 / CGWindowListCopyWindowInfo 失败 → stderr 输出错误 JSON，exit 2。
// 过滤：跳过 width/height <= 0 的窗口；最多输出 2000 个（防御异常环境下的超大列表）。
// 公开契约：输出字段与 `src/shared/types.ts` 的 `WindowInfo` 一致（JSON key 按字母序）。

import CoreGraphics
import Foundation

/// 屏幕/窗口矩形（整数逻辑像素，左上原点；对应共享契约 `Rect`）。
struct WindowRect: Codable {
  let x: Int
  let y: Int
  let width: Int
  let height: Int
}

/// 单个窗口（对应共享契约 `WindowInfo`）。
struct WindowItem: Codable {
  let id: Int
  let pid: Int
  let owner: String
  let layer: Int
  let alpha: Double
  let bounds: WindowRect
  let onScreen: Bool
}

/// stderr 错误载荷（`{"error":"..."}`）。
struct ErrorPayload: Codable {
  let error: String
}

/// 最多输出的窗口数（CGWindowList 通常几十个；上限只防异常环境）。
let maxWindows = 2000

/// 用法说明（`--help`）。
let usage = """
用法: winlist [--json] [--help]

枚举屏幕内窗口（无需屏幕录制权限），输出字段：
  id       CGWindowNumber（窗口 id）
  pid      CGWindowOwnerPID（所属进程）
  owner    CGWindowOwnerName（应用名）
  layer    CGWindowLayer（层；普通应用窗口为 0）
  alpha    CGWindowAlpha（不透明度，缺省 1.0）
  bounds   { x, y, width, height }（屏幕全局逻辑像素整数）
  onScreen CGWindowIsOnscreen（是否在屏幕上，缺省 true）

选项:
  --json   以单个 JSON 数组输出到 stdout（默认行为）
  --help   显示本帮助
"""

/// 输出 JSON 到指定文件句柄（stdout / stderr），带结尾换行。
func writeJSON<T: Encodable>(_ value: T, to handle: FileHandle) {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
  guard let data = try? encoder.encode(value) else { return }
  handle.write(data)
  handle.write(Data([0x0A]))
}

/// 失败：stderr 输出错误 JSON 并 exit 2。
func fail(_ message: String) -> Never {
  writeJSON(ErrorPayload(error: message), to: FileHandle.standardError)
  exit(2)
}

/// 从 CFNumber 值取整数；缺省 / 非数值返回 nil。
func intValue(_ dict: NSDictionary, _ key: String) -> Int? {
  guard let number = dict[key] as? NSNumber else { return nil }
  return number.intValue
}

/// 把 Double 四舍五入并钳制到 Int32 安全范围（A4-F07）。
///
/// `Int(Double)` 对超出 `Int` 表示范围的输入会 trap（SIGILL）。WindowServer 通常把
/// bounds 限制在 32 位点坐标内，但异常 / 恶意窗口仍可能给出极大值；这里统一钳制，
/// 保证助手不会因为单个窗口把整轮枚举打崩。宽度/高度在调用方再校验 > 0。
func clampedRoundedInt(_ value: Double) -> Int {
  let rounded = value.rounded()
  let lower = Double(Int32.min)
  let upper = Double(Int32.max)
  let clamped = min(max(rounded, lower), upper)
  return Int(clamped)
}

/// 从字典取 bounds；缺任何一个整数坐标 / 尺寸都返回 nil。
func rectValue(_ dict: NSDictionary, _ key: String) -> WindowRect? {
  guard let bounds = dict[key] as? NSDictionary else { return nil }
  guard
    let rawX = bounds["X"] as? NSNumber,
    let rawY = bounds["Y"] as? NSNumber,
    let rawWidth = bounds["Width"] as? NSNumber,
    let rawHeight = bounds["Height"] as? NSNumber
  else { return nil }

  let x = rawX.doubleValue
  let y = rawY.doubleValue
  let width = rawWidth.doubleValue
  let height = rawHeight.doubleValue
  // JSON 不能表达 NaN / Infinity；异常窗口直接丢弃。
  guard x.isFinite, y.isFinite, width.isFinite, height.isFinite else { return nil }
  // 跳过零/负尺寸窗口（某些辅助窗口会出现）。
  guard width > 0, height > 0 else { return nil }

  let roundedWidth = clampedRoundedInt(width)
  let roundedHeight = clampedRoundedInt(height)
  // 亚像素尺寸（如 0.4）四舍五入后可能变成 0，同样跳过。
  guard roundedWidth > 0, roundedHeight > 0 else { return nil }

  return WindowRect(
    x: clampedRoundedInt(x),
    y: clampedRoundedInt(y),
    width: roundedWidth,
    height: roundedHeight
  )
}

/// 解析命令行参数；`--json` 是默认模式（也接受显式传入），`--help` 打印用法。
func parseArguments() {
  for argument in CommandLine.arguments.dropFirst() {
    switch argument {
    case "--json":
      // 默认输出即 JSON；保留该 flag 只为显式声明 / 未来兼容其它格式。
      continue
    case "--help", "-h":
      print(usage)
      exit(0)
    default:
      fail("unknown argument: \(argument)")
    }
  }
}

parseArguments()

// 只取「屏幕内、排除桌面元素」的窗口；顺序即 CGWindowList 的前后顺序（前面的窗口在前）。
//
// A4-F08：`.optionOnScreenOnly` 会把「窗口关闭 / 最小化 / 切到其它 Space /
// 显示器分离空间」统一表现为「从列表消失」，消费侧不能把「列表里没有」直接当成窗口关闭。
// A4-F12：因此本助手输出项的 onScreen 当前恒为 true（该字段保留给未来枚举隐藏窗口的扩展）。
guard let rawWindowList = CGWindowListCopyWindowInfo(
  [.optionOnScreenOnly, .excludeDesktopElements],
  kCGNullWindowID
) else {
  fail("CGWindowListCopyWindowInfo returned nil")
}

let windowList = rawWindowList as NSArray
var windows: [WindowItem] = []
windows.reserveCapacity(min(windowList.count, maxWindows))

for element in windowList {
  if windows.count >= maxWindows { break }
  guard let dict = element as? NSDictionary else { continue }

  // id / pid / bounds 是必需字段；缺失的窗口（通常不属于任何 app）直接跳过。
  guard let id = intValue(dict, kCGWindowNumber as String) else { continue }
  guard let pid = intValue(dict, kCGWindowOwnerPID as String) else { continue }
  guard let bounds = rectValue(dict, kCGWindowBounds as String) else { continue }

  let owner = dict[kCGWindowOwnerName as String] as? String ?? ""
  let layer = intValue(dict, kCGWindowLayer as String) ?? 0
  let alpha = (dict[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1.0
  guard alpha.isFinite else { continue }
  let onScreen = (dict[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? true

  windows.append(
    WindowItem(
      id: id,
      pid: pid,
      owner: owner,
      layer: layer,
      alpha: alpha,
      bounds: bounds,
      onScreen: onScreen
    )
  )
}

writeJSON(windows, to: FileHandle.standardOutput)
exit(0)
