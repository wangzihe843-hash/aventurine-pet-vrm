# U0 — Unity 烘焙环境准备（用户操作 + 检查清单）

> 目的：把 Mate-Engine 的 Unity Humanoid `.anim` 导出成可重定向的 FBX/采样数据，再在 Blender 里重定向到我们的 VRM。
> 为什么需要：`.anim` 是 Unity Humanoid muscle 曲线，**必须由 Unity + Avatar 求值**，three.js/Blender 无法直接读。

## 0. 重要：Unity 6 在中国区已断供（2026-11 实测）

Mate-Engine 工程要求 **Unity 6000.2.6f2（Unity 6.2.6f2，revision `4a4dcaec6541`，见 `refs/Mate-Engine/ProjectSettings/ProjectVersion.txt`）**。

- 截图里的 **团结引擎 1.11.0 / 1.6.14 不是 Unity 6**，是 Unity 中国版替代品；Package 与 Unity 国际版不互通，直接打开 Unity 6.2 工程大概率失败。
- `unity.com/download` 在国内会 302 到 `unity.cn/releases`（团结引擎页）；Unity 6 官方安装包链接会 302 到 `download.unitychina.cn/...` 然后 **404（已下架）**（本机实测）。
- 社区记录（[记一次从Unity6转TuanJie引擎](https://www.lfzxb.top/from-unity6-to-tuanjie/index.html)）：目前只能**科学上网（TUN 模式）**从国际版 Hub 强行下载 Unity 6；团结引擎与 Unity 国际版 Package 不互通，打开 Unity 6 项目困难。

### 实测：Unity Hub 中国版只给中国版编辑器（2026-11-08）

- 本机装出的 Hub 是 **Unity Hub 3.3.7 中国版**（`~/Library/Application Support/UnityHub` 缓存含 `unitychina`），编辑器列表只有 `2022.3.62f3c1-arm64` 这类 **c1 中国版**，没有 6000.2.6f2。
- 从官方 CDN 直链装的 Hub 在国区网络下同样走中国版列表，所以"能下载 Hub"≠"能下 Unity 6"。
- **先取消 2022.3.62f3c1 的下载**：Unity 2022.3 打不开 Unity 6.2 工程，装它没有意义。

### 本机环境状态（2026-11-08 14:10 更新）

- ✅ 已卸载 **Unity 中国版 Hub 3.3.7**（签名 You San Di Technology (Shanghai)），备份在
  `/Volumes/4TB外置盘/deepseek-harness/tools/backup/unity-cn-3.3.7-20261108/`（app/support/prefs/中国版 dmg）。
- ✅ 已安装 **国际版 Unity Hub 3.22.6**（Developer ID: Unity Technologies SF，`/Applications/Unity Hub.app`）。
- ✅ 编辑器列表无 `2022.3.62f3c1`（当时只有 Hub 下载、未装完，无需卸载；Hub 缓存已随旧 Hub 数据备份移走）。
- ⏳ `Unity-6000.2.6f2.pkg` 后台仍在下载（Chrome 临时文件 `~/Downloads/未确认 *.crdownload`），完成后装 pkg → 新 Hub **Locate** → 登录 Unity ID 激活 Personal。

### 直链下载实测（2026-11-08，国区网络可用）

- 链接：`https://download.unity3d.com/download_unity/4a4dcaec6541/MacEditorInstallerArm64/Unity-6000.2.6f2.pkg`
- `curl -I` 会看到 302→404，但 **GET 实际可用**：`206 Partial Content`，总大小 **4,940,050,268 B**，`Accept-Ranges: bytes`，ETag `7c6a81d0d6604f13b20e1126d28b933e`（通常即 MD5，可下载后 `md5 -q` 校验）。
- 国区下载速度约 **1.2 MB/s**（单线程 ~277KB/s，8/16/32 并发总上限 ~1.1MB/s，是线路瓶颈），4.6GB 约 **65–75 分钟**。
- 浏览器显示 "0.0/4.6 GB" 时别以为没下：Chrome 的临时文件是 `~/Downloads/未确认 *.crdownload`，看它大小在长就是正在下。
- 下载完成后双击 pkg 安装（默认 `/Applications/Unity/Hub/Editor/6000.2.6f2/Unity.app`）；Hub 3.3.7 中国版用 **Locate** 添加该编辑器；license 问题装完再处理。

### TUN 模式是什么 / 怎么开（需要代理服务）

TUN 不是 macOS 自带开关，是代理客户端提供的"虚拟网卡/增强模式"：把 Unity Hub/下载器的流量透明代理到境外节点。

1. 你需要有代理客户端 + 可用订阅（Clash Verge Rev / Mihomo Party / Stash / Surge 等任选）；**没有代理服务就无法开 TUN**。
2. 打开客户端 → 设置 → 开启 **TUN / 虚拟网卡 / 增强模式**（macOS 会要求安装系统 helper，输入管理员密码，并在"系统设置 → 隐私与安全性"允许系统扩展）。
3. 验证：`curl -I https://unity.com/download` 不再 302 到 `unity.cn`；`curl -I https://download.unity3d.com/download_unity/4a4dcaec6541/MacEditorInstallerArm64/Unity-6000.2.6f2.pkg` 应返回 200/302 到可下载地址，而不是 404。
4. 完全退出 Unity Hub（含菜单栏图标）再打开；登录 Unity ID；Installs → Install Editor → **Archive** 选 **6000.2.6f2**。
5. 如果仍只有中国版编辑器：卸载中国版 Hub，装国际版最新 Hub（需同样网络条件）。

### 三条可选路线（按推荐排序）

| 路线 | 做法 | 成本/风险 |
|---|---|---|
| **A. 海外网络 + Unity Hub（推荐）** | 下载 Unity Hub 官方 CDN 直链：`https://public-cdn.cloud.unity3d.com/hub/prod/UnityHubSetup.dmg`（535MB，本机实测可下）→ 登录 Unity ID → Installs → Archive → **6000.2.6f2** | 需要能访问国际 CDN（TUN/代理）；最干净 |
| **B. 借有 Unity 6 的机器** | 把 `refs/Mate-Engine` 工程 + `scripts/unity-bake/` 拷到对方机器，装 FBX Exporter（或跑我们的采样脚本），只导出动作 FBX/JSON 回本机 | 需要另一台机器；动作仅个人使用，不发布 |
| **C. 团结引擎 1.11.0 试探（不推荐首选）** | 复制工程到 `work/Mate-Engine-Unity`，用团结 1.11 打开；若只是导动作，用我们自写的 Editor 采样脚本（不依赖 FBX Exporter）绕开包不互通 | 工程能否打开不确定；Package/GUID/场景格式差异大；耗时长 |

> 结论：**优先 A；没有代理就走 B；C 只作为最后尝试，不要直接改 `refs/` 里的原工程。**

## 1. 安装 Unity（约 10–20 GB 磁盘）

1. 安装 **Unity Hub**（Apple Silicon 版）：https://unity.com/download
2. 注册/登录 Unity 账号（免费 Personal 许可即可；Mate-Engine 是个人项目，非商业用途）。
3. 在 Hub 的 **Installs → Install Editor → Archive / 其他版本** 里找 **6000.2.6f2**（Mate-Engine 工程 `ProjectVersion.txt` 要求的确切版本）。
   - 若 Hub 列表没有，从 https://unity.com/releases/editor/archive 找该版本下载。
   - 安装模块可只选 macOS 平台支持（不需要 iOS/Android/WebGL）。
4. **先复制工程再打开**（避免 Unity 改写 `refs/` 参考工程）：
   ```bash
   mkdir -p work
   cp -R refs/Mate-Engine work/Mate-Engine-Unity
   ```
   Hub → **Projects → Add → Add project from disk** → 选择 `work/Mate-Engine-Unity`。
   - 首次打开会导入 2.4 GB 工程与资源，可能需要数分钟到十几分钟。
   - 用 **6000.2.6f2** 打开；不要升级原 `refs/` 工程。
5. 进入工程后安装 **FBX Exporter**：`Window → Package Manager → Unity Registry → 搜索 "FBX Exporter" → Install`（`com.unity.formats.fbx`）。
6. 可选检查：`Edit → Project Settings → Player` 能正常显示；`Assets/MATE ENGINE - Animations` 下能看到 128 个 `.anim`。

## 2. 完成后告诉我 / 记录

- [ ] Unity Hub 已登录
- [ ] Editor 6000.2.6f2 已安装
- [ ] Mate-Engine 工程可打开（无报错阻塞）
- [ ] FBX Exporter 已安装
- [ ] 版本记录：Unity `6000.2.6f2`；FBX Exporter 版本：______

## 3. 下一步（我这边）

- U1：写 `scripts/unity-bake/ExportClips.cs`（Editor 脚本：按清单把 Humanoid clip 导出 FBX；或采样 humanoid 骨骼局部旋转为 JSON）+ `run-export.sh`（`Unity -batchmode -executeMethod` 无头调用）。
- 先导 3 个 clip 试烧：`PET_IDLE`、`BETA_PET_WINDOW_LAY`、`PET_DRAGGING`（对应 idle / 坐窗 / 被拖拽）。
- U2：目标已升级为 `assets/vrm/aventurine-tpose.vrm`（W1.5-Tpose：规范 T-pose，VRM 1.0，53 骨、95 表情、SpringBone 50 链；见 `docs/vrm-tpose-repair.md`）；旧的 `aventurine-waveflair.vrm` 只读保留。
- 产出放 `assets/motions/mate/**`（gitignore，私有，禁止分发）。

## 4. 授权提醒

Mate-Engine 动画素材 © Shiny，仅限本地个人非商业使用、需署名、不得单独再分发；烘焙产物只进本机 `assets/motions/mate/`，不发布。
