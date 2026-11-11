# assets 说明（Phase 3 / VRM 工作区）

本目录全部为**私有资产**，已被 `.gitignore` 忽略，禁止提交、发布、随 app 分发。

## 目录

- `model/`：v1 遗留 PMX + 贴图 + legacy VMD 动作（回退用，不参与 VRM 主线）。
  - 来源：模之屋「星穹铁道—砂金·戏浪（优化）」；版权 miHoYo；禁止二次配布/商用；允许本地改造。
- `vrm/canary/砂金石心十人公司制服(0.x).vrm`：**canary** 模型（VRM 0.x，51 humanoid 骨骼、31 材质、13 张贴图，约 14.7MB）。
  - 来自用户下载（模之屋），仅本机验证 three-vrm 管线用；同样禁止再分发。
  - W0-4 实测：rotateVRM0 后面向 +Z 正确；有 VRM0 lookAt（`firstPerson.lookAtTypeName=Bone`）；无 spring 骨；
    MToon/贴图加载正常（3 视图 + 10s 录屏见 `tests/tmp/w0-4/`）。
- `vrm/星穹铁道—砂金·戏浪(1.0).vrm`：用户 2026-11-08 用模之屋转好的**目标模型 VRM 1.0**（候选主资产，约 25.9MB）。
  - GLB JSON 实测：52 humanoid 骨骼、39 个 `VRMC_materials_mtoon` 材质、20 张贴图、12 个 expression preset
    （happy/angry/surprised/blink/blinkLeft/blinkRight/neutral/aa/ih/ou/ee/oh）、
    **无 `VRMC_vrm.springBone`、无 `lookAt`、无 animations**。
  - W0-4 实测：**模型面向 -Z**（与 VRM 1.0 的 +Z 约定相反）→ `src/shared/vrm-manifest.json` 用
    `yawOffsetDeg: 180` 修正；29/39 材质 `alphaMode=BLEND`（27 个 alpha≈1）+ 39/39 doubleSided
    + `transparentWithZWrite=true` → 透明排序局部 ghost 瑕疵；实测 force-opaque 仅改 3.75% 像素，
    **整体发白主因是贴图色调/光照**（观感调优归 V6）。
  - **W0-5 数据修复副本**：`vrm/aventurine-waveflair.vrm`（manifest 实际引用；原始文件只读保留）。
    生成命令（幂等，只改 glTF JSON、BIN/贴图/几何字节不变）：
    ```bash
    node scripts/vrm/patch-vrm-gltf.mjs "assets/vrm/星穹铁道—砂金·戏浪(1.0).vrm" \
      -o "assets/vrm/aventurine-waveflair.vrm" --force-opaque-alpha1
    ```
    修复内容：① 删除 `珍珠` 非法 `shadeMultiplyTexture={}`（否则 three-vrm 加载抛错）；
    ② 27 个 α≈1 的 BLEND 材质改 OPAQUE（39 = 37 OPAQUE + 2 BLEND，颜赤/目影真半透明保留）。
    修复报告 `tests/tmp/w0-5/patch-report.json`；V1 loader 仍应内置 `patchVrmGlbBuffer` 内存防御。
  - 来源：模之屋;版权 miHoYo;禁止二次配布/商用。原始 zip 已解压并移动到本目录（zip 同样 gitignore）。
  - 待 Wave 1（V1/V5）评估：直接接入 or 在 Blender 管线补 spring 链/lookAt/表情映射；V2 决定是否自转。
- `vrm/aventurine.vrm`：V2 自转产出路径（尚未生成，本地私有）；如果用户提供的 1.0 资产验收通过，可让 V2 改为
  「补 spring/lookAt/材质」而不是整模重转。
- `vrm/expressions.json` / `spring-bones.json`：转换产出的映射配置（本地生成）。
- `motions/`：Mixamo/Blender 重定向得到的 glTF/VRMA 动作（Phase 3 产出，授权见 `docs/anim-strategy.md`）。
- `icons/`：应用图标（可提交）。

## 红线

1. 不得 `git add -f assets/model` / `assets/vrm` / `assets/motions`。
2. 任何公开仓库、分享包、Release 都必须排除这些目录。
3. 若将来要公开发布 app，应改为"用户自备模型"模式（app 只带 loader）。
