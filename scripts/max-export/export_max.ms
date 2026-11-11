/*
    export_max.ms  --  Aventurine "Waveflair" (HSR 4.5) .max -> FBX batch exporter
    -------------------------------------------------------------------------------
    Goal: export the 3ds Max Biped animation scenes to FBX so the macOS side can
    sample + retarget them to a VRM humanoid rig. Two variants:

      * full  : whole scene (mesh + skin + Biped animation). Bigger (5-20 MB/file).
                Used for the PILOT so we can render the original asset as the
                ground truth for visual comparison.
      * skel  : model meshes are deleted first; only Biped skeleton + animation
                remains. Small (0.1-1 MB/file). Used for the FULL 138-file run.

    Tested design target: 3ds Max 2024-2027 on Windows 11 (any version able to open
    scenes saved by 3ds Max 2021).

    TWO WAYS TO RUN
    ---------------
    1) RECOMMENDED (headless batch): double-click run_pilot.bat / run_full.bat
       (they call 3dsmaxbatch.exe with the arguments this script expects).
    2) GUI fallback: open 3ds Max, menu Scripting > Run Script..., pick this file.
       Without command-line arguments it uses DEF_* below (pilot mode).

    IMPORTANT
    ---------
    - Start the 3ds Max GUI once and sign in to the 30-day trial BEFORE using the
      batch scripts, otherwise 3dsmaxbatch exits with license error (-8).
    - Missing-texture dialogs do not matter for animation; batch mode passes
      -dm on to suppress dialogs.
    - ASCII-only file on purpose (Chinese Windows encoding safety).
    - This script only reads scene FPS/units; it never changes them.
*/

(
    -- ===================== default settings (GUI / fallback) =====================
    local DEF_SRC  = @"D:\sjxl\max"     -- folder containing the *.max files
    local DEF_OUT  = @"D:\sjxl\fbx"     -- output root folder
    -- "pilot"  : 6 representative files, BOTH variants (full scene + skeleton)
    -- "all"    : every *.max, skeleton only (delete model meshes -> small FBX)
    -- "subset" : SUBSET_FILES only, full scene (mesh kept; used for video comparison of key clips)
    local DEF_MODE = "pilot"
    -- ============================================================================

    -- Pilot set: one representative file per category. Do NOT swap blindly.
    local PILOT_FILES = #("tpose.max", "standby.max", "walk.max", "talk01.max", "skill01.max", "state_stun.max")

    -- Subset for mesh-based source fidelity (A-grade skills + B-grade idle/walk).
    -- Keep in sync with docs/adv-pilot-ingest-runbook.md / docs/adv-acceptance-plan.md.
    local SUBSET_FILES = #(
        "standby.max", "teamstandby.max", "attackstandby.max",
        "idle_show_01.max", "idle_show_02.max", "common_idleshow.max",
        "walk.max", "run.max",
        "skill01.max", "skill02.max", "skill03.max", "skill04.max", "skill41.max",
        "mazeskill01.max"
    )

    fn swallow = ( 0 )

    -- ---------------- command line args (3dsmaxbatch -mxsString k:v) ----------------
    -- Batch detection: the official way is maxops.isInNonInteractiveMode();
    -- fall back to "was a -mxsString dir: passed" for older/edge cases.
    local args = maxOps.mxsCmdLineArgs
    local isBatch = false
    try (
        if ((maxops.isInNonInteractiveMode()) == true) do isBatch = true
    ) catch ( swallow() )
    if not isBatch do (
        try ( isBatch = (args[#dir] != undefined) ) catch ( swallow() )
    )

    fn argOr key defVal = (
        local v = defVal
        try ( local a = args[key]; if a != undefined do v = a ) catch ( swallow() )
        v
    )
    local srcDir = argOr #dir DEF_SRC
    local outDir = argOr #out DEF_OUT
    local mode   = argOr #mode DEF_MODE

    if (srcDir.count > 0) do (
        if (srcDir[srcDir.count] == "\\") do srcDir = substring srcDir 1 (srcDir.count - 1)
    )
    if (outDir.count > 0) do (
        if (outDir[outDir.count] == "\\") do outDir = substring outDir 1 (outDir.count - 1)
    )

    fn ensureDir d = (
        if not (doesFileExist d) do ( try ( makeDir d ) catch ( swallow() ) )
        doesFileExist d
    )

    -- Safe setter: unknown param returns "unsupplied"/throws but never breaks the run.
    fn setParam name val = (
        local res = "error"
        try ( res = FBXExporterSetParam name val ) catch ( res = "exception" )
        res
    )

    fn setParamNoVal name = (
        local res = "error"
        try ( res = FBXExporterSetParam name ) catch ( res = "exception" )
        res
    )

    -- FBX settings validated against the official 3ds Max FBX plug-in MaxScript docs.
    fn applyFbxSettings = (
        setParamNoVal "ResetExport"            -- no value by design
        setParam "Animation" true
        setParam "BakeAnimation" true          -- life line for Biped IK/Footsteps -> FK keys
        setParam "Bip2FBX" true                -- convert Biped hierarchy to FBX bones
        setParam "BakeFrameStart" animationRange.start.frame
        setParam "BakeFrameEnd" animationRange.end.frame
        setParam "BakeFrameStep" 1
        setParam "BakeResampleAnimation" true
        setParam "FilterKeyReducer" false
        setParam "Removesinglekeys" false
        setParam "GeomAsBone" false
        setParam "Skin" true
        setParam "Shape" true
        setParam "PointCache" false
        setParam "Cameras" false
        setParam "Lights" false
        setParam "EmbedTextures" false
        setParam "ShowWarnings" false
        setParam "GenerateLog" false
        setParam "UpAxis" "Y"
        setParam "AxisConversionMethod" "None"
        setParam "Triangulate" true
        setParam "SmoothingGroups" true
        setParam "TangentSpaceExport" false
        setParam "Preserveinstances" false
        OK
    )

    fn meshObjectCount = (
        local c = 0
        for o in objects where (superClassOf o == GeometryClass) do c += 1
        c
    )

    fn bipNodeCount = (
        local c = 0
        for o in objects where (matchPattern o.name pattern:"Bip*") do c += 1
        c
    )

    -- Select only the Biped rig for the skeleton-only export.
    -- Real 3ds Max Waveflair scenes contain 300+ geometry objects: model meshes plus every
    -- biped/bone object (all named "Bip...") and 260+ secondary *_JNT bones. Class-name based
    -- mesh deletion proved unreliable (deletedMeshes=0 in the first real pilot), so we select
    -- the Biped named objects and export SELECTED ONLY -- meshes and *_JNT secondary bones
    -- are excluded, the Biped animation is baked by the exporter.
    fn selectBipedRig logF = (
        clearSelection()
        local targets = #()
        for o in objects do (
            local n = o.name
            if (matchPattern n pattern:"Bip*") or (matchPattern n pattern:"*Footsteps*") or (n == "Root") do append targets o
        )
        if targets.count > 0 do select targets
        format "  selectBipedRig count=%\n" targets.count to:logF
        targets.count
    )

    fn logWrite logF line = ( format "%\n" line to:logF )

    -- Load one .max scene, return true if at least one object is present.
    fn loadScene srcFile logF = (
        resetMaxFile #noPrompt
        local ok = true
        try ( loadMaxFile srcFile useFileUnits:true quiet:true ) catch (
            ok = false
            logWrite logF ("FAIL,LOAD," + (filenameFromPath srcFile) + "," + (getCurrentException() as string))
        )
        if ok and (objects.count == 0) do ok = false
        ok
    )

    -- ================================ pilot ==================================
    fn exportPilotFile srcFile outDir logF = (
        local base = getFilenameFile srcFile
        local okFull = false
        local okSkel = false

        if (loadScene srcFile logF) do (
            local fpsVal = frameRate
            local fStart = animationRange.start.frame
            local fEnd   = animationRange.end.frame
            local utype  = units.SystemType as string
            local uscale = units.SystemScale
            applyFbxSettings()

            local dstFull = outDir + "\\" + base + ".fbx"
            try ( exportFile dstFull #noPrompt selectedOnly:false using:FBXEXP; okFull = true ) catch (
                logWrite logF ("FAIL,FULL," + base + "," + (getCurrentException() as string))
            )
            local szFull = "0"
            if (doesFileExist dstFull) do szFull = (getFileSize dstFull) as string
            logWrite logF ("OK,FULL," + base + ",fps=" + (fpsVal as string) + ",unit=" + utype + "/" + (uscale as string) + ",frames=" + (fStart as string) + "-" + (fEnd as string) + ",meshObjs=" + (meshObjectCount() as string) + ",bipNodes=" + (bipNodeCount() as string) + ",bytes=" + szFull)

            if (loadScene srcFile logF) do (
                applyFbxSettings()
                local selectedCount = selectBipedRig logF
                local dstSkel = outDir + "\\" + base + "_skel.fbx"
                local skelSelectedOnly = selectedCount > 0
                if not skelSelectedOnly do logWrite logF ("WARN,SKEL," + base + ",未选中任何 Bip* 对象，退回整场景导出（体积不会变小）")
                try ( exportFile dstSkel #noPrompt selectedOnly:skelSelectedOnly using:FBXEXP; okSkel = true ) catch (
                    logWrite logF ("FAIL,SKEL," + base + "," + (getCurrentException() as string))
                )
                local szSkel = "0"
                if (doesFileExist dstSkel) do szSkel = (getFileSize dstSkel) as string
                logWrite logF ("OK,SKEL," + base + ",fps=" + (fpsVal as string) + ",unit=" + utype + ",frames=" + (fStart as string) + "-" + (fEnd as string) + ",selectedBipNodes=" + (selectedCount as string) + ",selectedOnly=" + (skelSelectedOnly as string) + ",bytes=" + szSkel)
            )
            resetMaxFile #noPrompt
        )
        okFull and okSkel
    )

    -- ========================== full scene (mesh kept) ==========================
    -- Used by the "subset" mode: export the whole scene without deleting meshes so
    -- the macOS side can render the ORIGINAL character for video comparison.
    fn exportFullOnly srcFile outDir logF = (
        local base = getFilenameFile srcFile
        local done = false
        if (loadScene srcFile logF) then (
            local fpsVal = frameRate
            local fStart = animationRange.start.frame
            local fEnd   = animationRange.end.frame
            local utype  = units.SystemType as string
            local meshCnt = meshObjectCount()
            local bipCnt  = bipNodeCount()
            applyFbxSettings()
            local dst = outDir + "\\" + base + ".fbx"
            local ok = false
            try ( exportFile dst #noPrompt selectedOnly:false using:FBXEXP; ok = true ) catch (
                logWrite logF ("FAIL,EXPORT," + base + "," + (getCurrentException() as string))
            )
            if ok do (
                local sz = "0"
                if (doesFileExist dst) do sz = (getFileSize dst) as string
                logWrite logF ("OK,FULL," + base + ",fps=" + (fpsVal as string) + ",unit=" + utype + ",frames=" + (fStart as string) + "-" + (fEnd as string) + ",meshObjs=" + (meshCnt as string) + ",bipNodes=" + (bipCnt as string) + ",bytes=" + sz)
            )
            resetMaxFile #noPrompt
            done = ok
        )
        done
    )

    -- ================================== full ==================================
    fn exportAllFile srcFile outDir logF = (
        local base = getFilenameFile srcFile
        local done = false
        if (loadScene srcFile logF) then (
            local fpsVal = frameRate
            local fStart = animationRange.start.frame
            local fEnd   = animationRange.end.frame
            local utype  = units.SystemType as string
            local meshCnt = meshObjectCount()
            local bipCnt  = bipNodeCount()
            applyFbxSettings()
            local selectedCount = selectBipedRig logF
            local skelSelectedOnly = selectedCount > 0
            if not skelSelectedOnly do logWrite logF ("WARN,SKEL," + base + ",未选中任何 Bip* 对象，退回整场景导出")
            local dst = outDir + "\\" + base + ".fbx"
            local ok = false
            try ( exportFile dst #noPrompt selectedOnly:skelSelectedOnly using:FBXEXP; ok = true ) catch (
                logWrite logF ("FAIL,EXPORT," + base + "," + (getCurrentException() as string))
            )
            if ok do (
                local sz = "0"
                if (doesFileExist dst) do sz = (getFileSize dst) as string
                logWrite logF ("OK,SKEL," + base + ",fps=" + (fpsVal as string) + ",unit=" + utype + ",frames=" + (fStart as string) + "-" + (fEnd as string) + ",meshObjs=" + (meshCnt as string) + ",selectedBipNodes=" + (selectedCount as string) + ",selectedOnly=" + (skelSelectedOnly as string) + ",bipNodes=" + (bipCnt as string) + ",bytes=" + sz)
            )
            resetMaxFile #noPrompt
            done = ok
        )
        done
    )

    -- ================================== main ==================================
    local fatal = ""
    if not (doesFileExist srcDir) do fatal = "Source folder not found: " + srcDir
    if fatal == "" and not (ensureDir outDir) do fatal = "Cannot create output folder: " + outDir
    if fatal != "" do (
        format "FATAL %\n" fatal
        if not isBatch do messageBox fatal title:"export_max.ms"
        throw fatal
    )

    local logPath = outDir + "\\export_log.txt"
    local logF = createFile logPath
    logWrite logF "# Aventurine Waveflair FBX export log"
    logWrite logF ("# mode=" + mode + " src=" + srcDir + " out=" + outDir + " max=" + ((maxVersion()) as string) + " frameRate=" + (frameRate as string))

    local jobs = getFiles (srcDir + "\\*.max")
    if ((toLower mode) == "pilot") do (
        local picked = #()
        for f in jobs do (
            local ln = toLower (filenameFromPath f)
            if (findItem PILOT_FILES ln) > 0 do append picked f
        )
        jobs = picked
    )
    if ((toLower mode) == "subset") do (
        local picked = #()
        for f in jobs do (
            local ln = toLower (filenameFromPath f)
            if (findItem SUBSET_FILES ln) > 0 do append picked f
        )
        jobs = picked
    )
    sort jobs
    logWrite logF ("# fileCount=" + (jobs.count as string))

    local okCount = 0
    local failList = #()
    try ( progressStart "Exporting FBX" ) catch ( swallow() )
    local i = 0
    for f in jobs do (
        i += 1
        local ok = false
        local modeLc = toLower mode
        try (
            if modeLc == "pilot" then (
                ok = exportPilotFile f outDir logF
            ) else if modeLc == "subset" then (
                ok = exportFullOnly f outDir logF
            ) else (
                ok = exportAllFile f outDir logF
            )
        ) catch (
            logWrite logF ("FAIL,UNEXPECTED," + (filenameFromPath f) + "," + (getCurrentException() as string))
        )
        if ok then okCount += 1 else append failList (filenameFromPath f)
        format "EXPORT % / %  %  ok=%\n" i jobs.count (filenameFromPath f) ok
        try ( progressUpdate (100.0 * i / (if jobs.count > 0 then jobs.count else 1)) ) catch ( swallow() )
    )
    try ( progressEnd() ) catch ( swallow() )

    logWrite logF ("")
    logWrite logF ("=== DONE mode=" + mode + " ok=" + (okCount as string) + " fail=" + (failList.count as string) + " ===")
    for x in failList do logWrite logF ("failed: " + x)
    close logF
    format "EXPORT DONE ok=% fail=%\n" okCount failList.count
    if not isBatch do (
        messageBox ("Export finished.\n\nOK: " + (okCount as string) + " / " + (jobs.count as string) + "\nLog: " + logPath) title:"export_max.ms"
        shellLaunch outDir ""
    )
    if isBatch do quitMAX quiet:true
    true
)
