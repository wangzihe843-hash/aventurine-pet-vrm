# 「砂金·戏浪」动作包 → 桌宠可用动作：Windows 侧导出操作指南

> 这条链路只做一件事：把你 Windows 电脑上的 138 个 `.max` 动作文件，用 3ds Max 批量导出成 FBX，再传回 Mac。
> 我（Mac 侧）收到 FBX 后会负责重定向、对拍验收和接入项目。**你只需要照下面 1–6 步操作。**
> 预计总耗时：**2–4 小时**（大头是 Autodesk 安装包下载 6–8GB）。

---

## 0. 先做两个检查（30 秒）

1. 在 Windows 上按 `Win + R`，输入 `winver`，回车。
   - 显示 **Windows 11** → 继续（3ds Max 2027 只支持 Win11）。
   - 显示 **Windows 10** → 先别下载，告诉我一声。可选：设置 → Windows 更新 → 免费升级 Win11；升不了我们就换别的方案。
2. 确认 **C 盘至少剩 20 GB**（3ds Max 装完约 9–15GB），**D 盘至少剩 10 GB**（动作包解压 3.2GB + 导出产物）。

---

## 1. 注册/登录 Autodesk 账号，下载 3ds Max 2027 免费试用

1. 打开（中国站可直连）：<https://www.autodesk.com.cn/products/3ds-max/free-trial>
   （或国际站 <https://www.autodesk.com/products/3ds-max/free-trial>）
2. 注册/登录 **Autodesk 账号**（免费），选择 **3ds Max 免费试用**（30 天，完整功能，不需要信用卡）。
3. 安装 3ds Max（两种方式都行）：
   - **省事**：Autodesk Account 里点 **Install（在线安装器）**，按默认一路下一步即可（你的 Windows 是正常 x64 机器，不需要像 ARM 模拟那样必须离线包）；
   - **更稳/可断点**：选 **Download（完整安装包）**，把多卷全部下到同一文件夹再解压安装（约 6–8GB；建议浏览器断点续传挂机下载）。
4. 装完重启电脑。
5. 首次启动 3ds Max → 登录同一账号 → 选择 **Run（Trial）** → 确认能看到 "30 days left" 字样。
   **务必先用 GUI 启动并登录一次**，否则后面的批处理会因许可未激活报错（退出码 -8）。

> 卡住时：如果试用注册要求填支付方式，官方 FAQ 说明支付方式非必填；被卡可换国际站账号再试。

---

## 2. 把动作包解压到 Windows

1. 在 Windows 的百度网盘客户端里，登录你自己的账号，下载 `砂金戏浪.zip`（617MB）。
2. 解压到 **`D:\sjxl\max\`**，确保这个文件夹里**直接是 138 个 `.max` 文件**（不要多套一层文件夹；文件名不要改）。
   旁边那 35 个 png/json 可以不管（按需解压也行）。
3. 路径要求：**纯英文、无空格**（`D:\sjxl\max` 即可）。

---

## 3. 准备导出脚本

把本工具包（`max-export-kit` 文件夹里的 3 个文件）放到 **`D:\sjxl\`**：

- `export_max.ms`  ← 批量导出脚本
- `run_pilot.bat`  ← 试点导出（先跑这个）
- `run_full.bat`   ← 全量导出（等我们验证试点后再跑）

> 工具包在哪：Mac 侧仓库 `aventurine-pet-vrm/scripts/max-export/`；
> 也可从百度网盘里我放好的 `砂金动作转换/max-export-kit/` 取（若同步可见）。

---

## 4. 先跑试点（约 1–2 分钟 + 加载时间）

1. 双击 **`run_pilot.bat`**（如果 Windows 提示"未知发布者"选"仍要运行"）。
2. 会弹出一个命令行窗口，显示 Max batch 路径和进度；结束后请**不要急着关**，看最后 Exit code 是否为 **0**。
3. 完成后会自动打开 `D:\sjxl\fbx-pilot`，里面应有：
   - `Tpose.fbx` / `StandBy.fbx` / `Walk.fbx` / `Talk01.fbx` / `Skill01.fbx` / `State_Stun.fbx`（全场景，含模型）
   - 同名的 `*_skel.fbx`（只有骨骼+动画，文件很小）
   - `export_log.txt`（每个文件的 fps / 单位 / 帧范围 / 成功失败都在里面）
   - `listener.log`、`max.log`（Max 的详细日志）

如果弹窗报错：
- **缺失贴图/外部文件** → 选 "Skip All" / "跳过全部"（不影响动作导出）。
- **退出码 -8** → 回 3ds Max GUI 登录试用后再跑。
- **退出码 -7（图形设备）** → 改用 GUI 方式：打开 3ds Max → 顶部菜单 `Scripting`（脚本）→ `Run Script...`（运行脚本）→ 选 `D:\sjxl\export_max.ms`，等进度条跑完（默认就是试点模式）。
- 其它报错：把 `export_log.txt` 和 `listener.log` 发回来。

---

## 5. 回传试点结果（我来验证）

把 **整个 `D:\sjxl\fbx-pilot` 文件夹**压缩成 zip（应该只有几十 MB），通过下面任一方式给我：

- 上传到你 Windows 的百度网盘，放到一个文件夹（例如 `砂金动作转换/`）——Mac 端能看到同步目录；
- 或者告诉我，我们走局域网/其它传输方式。

同时告诉我：
- 3ds Max 实际版本号（帮助 → 关于，或窗口标题栏）；
- Windows 版本（`winver` 截图或文字）；
- `export_log.txt` 里有没有 FAIL 行。

**我验证试点 FBX（能否导入、骨骼是否标准 Biped、动画是否完整、时长是否对得上）后，再让你跑全量。**

---

## 6. 全量导出（等我说 OK 再做）

1. 双击 **`run_full.bat`**，它会导出全部 138 个文件到 `D:\sjxl\fbx-all`（预计 10–40 分钟，取决于电脑；产物应该很小，每个文件约 0.1–1MB）。
2. 完成后确认窗口 Exit code = 0，打开 `D:\sjxl\fbx-all\export_log.txt`，最后一行应为 `=== DONE mode=all ok=138 fail=0 ===`。
3. 把 **整个 `D:\sjxl\fbx-all` 文件夹**压缩成 zip 传回 Mac（同第 5 步方式）。

---

## 6.5（可选但推荐）再导一批"带模型"的关键片段

全量导出为了回传体积只保留骨架；但**技能类动作要对照官方演示核对**，有模型才能做像样的对比图。
等全量跑完后，再双击 **`run_subset.bat`**（工具包里的新脚本）：

- 它会导出约 14 个关键动作的**完整场景**（含模型）到 `D:\sjxl\fbx-subset`；
- 预计 100–200MB，完成后把 `D:\sjxl\fbx-subset` 整个压缩传回；
- 覆盖：StandBy/TeamStandBy/AttackStandBy、Idle_Show_01/02、Common_IdleShow、Walk、Run、Skill01/02/03/04、Skill41、MazeSkill01。

（如果全量回传已经很顺利，这个也很快；只影响对拍质量，不影响转换。）

## 7. 常见问题速查

| 现象 | 处理 |
|---|---|
| 打不开 `.max`、提示版本/插件问题 | 记下文件名发我；个别文件可跳过（用 Biped 面板 Save/Load `.bip` 兜底） |
| 3ds Max 打开场景很慢/占内存 | 正常（每个场景含完整模型）；确保只开一个 Max 实例 |
| `run_pilot.bat` 一闪而过 | 右键 → 编辑，确认 `SRC`/`OUT` 路径；或在命令行里运行看报错 |
| 找不到 `3dsmaxbatch.exe` | 用记事本编辑 bat 第一段 `MAXEXE`，改成你的安装路径，例如 `C:\Program Files\Autodesk\3ds Max 2027\3dsmaxbatch.exe` |
| 网盘下载动作包太慢 | 可先从 Mac 用移动硬盘/局域网拷 617MB 的 zip；解压后是 3.2GB |
| Windows 打不开/拷不到 Mac 上的文件 | 在 Mac 上打开「系统设置 → 通用 → 共享 → 文件共享」，Windows 资源管理器输入 `\\\\<Mac 电脑名或 IP>` 访问，拷贝 `砂金戏浪.zip` 或工具包即可 |

---

## 8. 版权提醒

这些是游戏官方资源（miHoYo/HoYoverse），仅限我们本机私用与内部转换：
- 不要公开发布、不要上传到公开网盘分享链接、不要商用；
- 回传用的网盘文件夹请设**私有**（不要生成公开分享链接）。

---

## 9. 出错时的诊断步骤（按顺序做，把日志发回 Mac）

### 9.1 `run_pilot.bat` 报错或导出结果可疑

1. **先看日志**：`D:\sjxl\fbx-pilot\` 下应有 `export_log.txt`、`listener.log`、`max.log`。把这三个文件打包发回。
   命令行窗口最后的 **Exit code** 含义（官方 3ds Max Batch 文档）：
   `0`=成功；`-8`=试用未激活（先 GUI 登录）；`-7`=图形设备（改用 GUI Run Script）；`-130`=脚本报错（把 listener.log/max.log 发回）；`-110`=Max 进程起不来（重启电脑/重装）；`-120`=与 Max 进程通信失败（杀进程重试）。
2. **跑诊断脚本**：把工具包里的 `diagnose_max.ms` 放到 `D:\sjxl\`，用记事本打开，确认第 12 行 `SRC` 指向一个真实文件（默认 `D:\sjxl\max\StandBy.max`），然后在 3ds Max 里 `Scripting → Run Script...` 选它。它会打开该场景并输出 `D:\sjxl\diagnose.txt`（场景 fps/单位/对象类清单/FBX 导出参数支持矩阵/动画探针）。把这个 txt 一起发回。
3. **试手动导出**：如果批处理完全跑不起来（例如 -8 许可 / -7 图形设备 / 脚本报错），用 `export_one.ms`：
   - 在 3ds Max 里依次打开 `Tpose.max / StandBy.max / Walk.max / Talk01.max / Skill01.max / State_Stun.max`；
   - 每打开一个，`Scripting → Run Script...` 选 `export_one.ms`，它会导出到 `D:\sjxl\manual\<场景名>.fbx`；
   - 6 个都导完后把 `D:\sjxl\manual` 压缩发回。
4. 如果弹窗提示"缺失外部贴图/文件"：选 **Skip All / 跳过全部**（不影响动作导出）。如果提示缺少插件（Corona/V-Ray 等）：选 **Ignore / 忽略**。

### 9.2 全量导出异常

- `export_log.txt` 里出现 `FAIL` 行：把含 FAIL 的那几行 + `listener.log` 发回；个别文件失败不影响其它文件。
- 导出完成后 `=== DONE mode=all ok=138 fail=0 ===` 才表示全量成功。
