/*
    diagnose_max.ms  --  3ds Max scene + FBX exporter diagnostics (troubleshooting aid)
    ---------------------------------------------------------------------------------
    Use this when run_pilot.bat / run_full.bat fails or produces unexpected FBX.
    It does NOT export anything: it opens one .max scene and writes a diagnostic log
    (scene info + which FBXExporterSetParam names the installed FBX plug-in recognizes
    + a small animation probe).

    HOW TO RUN
    1. Edit SRC (one .max file path) and OUT below.
    2. In 3ds Max: Scripting > Run Script... (Chinese UI: 脚本 > 运行脚本...) and pick
       this file. If a missing-texture dialog pops up, choose Skip All / OK.
    3. Send back the OUT log file (default D:\sjxl\diagnose.txt).
*/

(
    -- ============================== CONFIG ==============================
    local SRC = @"D:\sjxl\max\StandBy.max"
    local OUT = @"D:\sjxl\diagnose.txt"
    -- ====================================================================

    fn setParamRes name val = (
        local res = "unsupplied"
        try ( res = FBXExporterSetParam name val ) catch ( res = "EXCEPTION" )
        res
    )

    if not (doesFileExist SRC) do (
        messageBox ("File not found:\n" + SRC + "\n\nPlease edit SRC in the CONFIG block.") title:"diagnose_max.ms"
        return false
    )

    local logF = createFile OUT
    fn logLine logF text = ( format "%\n" text to:logF )

    logLine logF "=== 3ds Max / scene / FBX exporter diagnostics ==="
    logLine logF ("maxVersion   : " + ((maxVersion()) as string))
    logLine logF ("sourceFile   : " + SRC)

    -- ---- 1) load scene (test quiet:true support explicitly) ----
    local loadMode = "quiet"
    local loaded = true
    try (
        loadMaxFile SRC useFileUnits:true quiet:true
    ) catch (
        loaded = false
        logLine logF ("LOAD_QUIET_EXCEPTION: " + (getCurrentException() as string))
    )
    if not loaded do (
        loadMode = "plain"
        loaded = true
        try ( loadMaxFile SRC useFileUnits:true ) catch (
            loaded = false
            logLine logF ("LOAD_PLAIN_EXCEPTION: " + (getCurrentException() as string))
        )
    )
    logLine logF ("loadMode     : " + loadMode + "   loaded=" + (loaded as string))

    if loaded do (
        -- ---- 2) scene info ----
        logLine logF ""
        logLine logF "--- scene ---"
        logLine logF ("frameRate        : " + (frameRate as string))
        logLine logF ("animationRange   : " + (animationRange.start.frame as string) + " .. " + (animationRange.end.frame as string))
        logLine logF ("units            : " + (units.SystemType as string) + "  scale=" + (units.SystemScale as string))
        logLine logF ("objectCount      : " + (objects.count as string))

        local bipCount = 0
        local meshCount = 0
        local classList = ""
        local sample = ""
        local sampleCount = 0
        for o in objects do (
            local cn = (classOf o) as string
            if (matchPattern o.name pattern:"Bip*") do bipCount += 1
            if (superClassOf o == GeometryClass) do meshCount += 1
            if (findString classList cn) == undefined do classList = classList + cn + ", "
            if sampleCount < 25 do (
                sample = sample + o.name + " [" + cn + "]\n"
                sampleCount += 1
            )
        )
        logLine logF ("bipNamedNodes    : " + (bipCount as string))
        logLine logF ("geometryObjects  : " + (meshCount as string))
        logLine logF ("classes          : " + classList)
        logLine logF "objects(sample)  :"
        logLine sample

        -- ---- 3) FBX exporter parameter support matrix ----
        logLine logF ""
        logLine logF "--- FBXExporterSetParam support (OK = recognized) ---"
        local resetRes = "unsupplied"
        try ( resetRes = FBXExporterSetParam "ResetExport" ) catch ( resetRes = "EXCEPTION" )
        logLine logF ("ResetExport      : " + resetRes)

        local pairs = #(
            #("Animation", true), #("BakeAnimation", true), #("Bip2FBX", true),
            #("BakeFrameStart", 0), #("BakeFrameEnd", 10), #("BakeFrameStep", 1),
            #("BakeResampleAnimation", true), #("FilterKeyReducer", false),
            #("Removesinglekeys", false), #("GeomAsBone", false),
            #("Skin", true), #("Shape", true), #("PointCache", false),
            #("Cameras", false), #("Lights", false), #("EmbedTextures", false),
            #("ShowWarnings", false), #("GenerateLog", false),
            #("UpAxis", "Y"), #("AxisConversionMethod", "None"),
            #("Triangulate", true), #("SmoothingGroups", true),
            #("TangentSpaceExport", false), #("Preserveinstances", false),
            #("ConvertUnit", "cm"), #("ScaleFactor", 1.0),
            #("UseSceneName", true), #("ASCII", false),
            #("FileVersion", "FBX201400")
        )
        for item in pairs do (
            local res = setParamRes item[1] item[2]
            logLine logF ("  " + item[1] + " = " + (item[2] as string) + "  ->  " + res)
        )
        logLine logF "--- FBXExporterGetParam spot check ---"
        local getNames = #("Animation", "BakeAnimation", "Bip2FBX", "UpAxis", "FileVersion")
        for name in getNames do (
            local got = "?"
            try ( got = FBXExporterGetParam name ) catch ( got = "EXCEPTION" )
            logLine logF ("  " + name + "  ->  " + (got as string))
        )

        -- ---- 4) quick Biped animation probe ----
        logLine logF ""
        logLine logF "--- animation sanity probe ---"
        local candidates = #("Bip001 L UpperArm", "Bip001 Spine", "Bip001 Pelvis", "Bip001", "Bip01 L UpperArm", "Bip01")
        local probeNode = undefined
        for name in candidates do (
            if probeNode == undefined do (
                local found = getNodeByName name
                if found != undefined do probeNode = found
            )
        )
        if probeNode == undefined then (
            logLine logF "probeNode : NOT FOUND (tried standard Biped bone names)"
        ) else (
            local f0 = animationRange.start.frame as integer
            local f1 = (animationRange.start.frame + ((animationRange.end.frame - animationRange.start.frame) / 2)) as integer
            local q0 = undefined
            local q1 = undefined
            local t0 = undefined
            local t1 = undefined
            try ( sliderTime = f0; q0 = probeNode.transform.rotation; t0 = probeNode.transform.translation ) catch ( logLine logF "probe f0 EXCEPTION" )
            try ( sliderTime = f1; q1 = probeNode.transform.rotation; t1 = probeNode.transform.translation ) catch ( logLine logF "probe f1 EXCEPTION" )
            logLine logF ("probeNode : " + probeNode.name + "  [" + ((classOf probeNode) as string) + "]")
            logLine logF ("frame " + (f0 as string) + " rot=" + (q0 as string) + " pos=" + (t0 as string))
            logLine logF ("frame " + (f1 as string) + " rot=" + (q1 as string) + " pos=" + (t1 as string))
            logLine logF ("rotationChanged : " + ((q0 != q1) as string))
        )
    )

    logLine logF ""
    logLine logF "=== END ==="
    close logF
    messageBox ("Diagnostics written to:\n" + OUT + "\n\nPlease send this file back to the Mac side.") title:"diagnose_max.ms"
    true
)
