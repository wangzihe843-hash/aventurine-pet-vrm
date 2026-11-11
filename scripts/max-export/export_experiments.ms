/*
    export_experiments.ms  --  find the FBX exporter settings that KEEP the Biped animation

    Context: the first pilot export produced FBX where all 65 Biped bones are STATIC
    (no animation curves at all) while the 267 secondary/face bones DO animate. We need
    to find the export variant that bakes the Biped body animation.

    This script opens ONE scene (default StandBy.max) and exports several variants of the
    Biped selection to D:\sjxl\exp\. Send back the whole folder (each file should be small,
    a few MB). We then inspect which variant contains animated Biped bones.

    HOW TO RUN
    1. Edit SRC below if needed.
    2. 3ds Max: Scripting > Run Script... pick this file.
    3. Wait for the final message box (6 exports), then zip D:\sjxl\exp and send it back.
       Also send D:\sjxl\exp\experiments-log.txt.
*/
(
    -- ============================== CONFIG ==============================
    local SRC = @"D:\sjxl\max\StandBy.max"
    local OUTDIR = @"D:\sjxl\exp"
    -- ====================================================================

    if not (doesFileExist SRC) do (
        messageBox ("File not found:\n" + SRC) title:"export_experiments.ms"
        return false
    )
    if not (doesFileExist OUTDIR) do ( makeDir OUTDIR )

    local logPath = OUTDIR + "\\experiments-log.txt"
    local logF = createFile logPath
    fn L text = ( format "%\n" text to:logF )

    fn setParamRes name val = (
        local res = "unsupplied"
        try ( res = FBXExporterSetParam name val ) catch ( res = "EXCEPTION" )
        res
    )
    fn setParamLog name val = (
        local res = setParamRes name val
        L ("    param " + name + "=" + (val as string) + " -> " + res)
        res
    )

    -- Try to detect / turn OFF Biped Figure Mode through every plausible API spelling.
    -- Figure Mode freezes a Biped at its rest skeleton and would produce exactly the
    -- symptom we see (all Biped bones static in the exported FBX). Returns a log string.
    fn bipedFigureModeReport = (
        local lines = #()
        for o in objects do (
            local ctrl = undefined
            try ( ctrl = o.transform.controller ) catch ()
            if ctrl == undefined do continue
            local cn = ""
            try ( cn = (classOf ctrl) as string ) catch ()
            if (matchPattern cn pattern:"*Biped*") do (
                local line = ("  bipedRoot object=" + o.name + " controller=" + cn)
                local mode = "?"
                -- property probes
                local probes = #(#figureMode, #isFigureMode, #figuremode, #FigureMode)
                for pr in probes do (
                    local v = undefined
                    try ( v = getProperty ctrl pr ) catch ()
                    if v != undefined do (
                        mode = (v as string)
                        line = line + " property:" + (pr as string) + "=" + mode
                    )
                )
                -- function probes
                local fnNames = #(#figureMode, #getFigureMode)
                for fn in fnNames do (
                    local v = undefined
                    try ( v = biped.figureMode ctrl ) catch ()
                    if v != undefined do (
                        mode = (v as string)
                        line = line + " biped.figureMode=" + mode
                    )
                )
                append lines (line + "  (probe value=" + mode + ")")
            )
        )
        if lines.count == 0 do append lines "  no *Biped* transform controller found"
        lines
    )

    fn tryTurnFigureModeOff = (
        local changed = 0
        for o in objects do (
            local ctrl = undefined
            try ( ctrl = o.transform.controller ) catch ()
            if ctrl == undefined do continue
            local cn = ""
            try ( cn = (classOf ctrl) as string ) catch ()
            if (matchPattern cn pattern:"*Biped*") do (
                try ( ctrl.figureMode = false; changed += 1 ) catch ()
            )
        )
        changed
    )

    -- Biped animation layers may hold the animation; collapse them into the base layer
    -- before export (in-memory only, the .max file is never saved by this script).
    fn activateAndCollapseBipedLayers = (
        local report = #()
        for o in objects do (
            local ctrl = undefined
            try ( ctrl = o.transform.controller ) catch ()
            if ctrl == undefined do continue
            local cn = ""
            try ( cn = (classOf ctrl) as string ) catch ()
            if not (matchPattern cn pattern:"*Biped*") do continue
            local n = -1
            try ( n = biped.numLayers ctrl ) catch ()
            append report ("  biped=" + o.name + " numLayers=" + (n as string))
            if n < 1 do continue
            -- activate every layer (collapse requires all lower layers active)
            for li = 1 to n do ( try ( biped.setLayerActive ctrl li true ) catch () )
            -- collapse from the top down into the base layer (index 1 is the base)
            local guard = 0
            local merged = 0
            while ((biped.numLayers ctrl) > 1 and guard < 20) do (
                local top = biped.numLayers ctrl
                local okCollapse = false
                try ( okCollapse = biped.collapseAtLayer ctrl (top - 1) ) catch ()
                if not okCollapse then
                    try ( okCollapse = biped.collapseAtLayer ctrl 1 ) catch ()
                if okCollapse then merged += 1 else guard += 1
                guard += 1
            )
            append report ("  mergedLayers=" + (merged as string) + " remainingLayers=" + ((biped.numLayers ctrl) as string))
        )
        report
    )

    fn unhideEverything = (
        -- Multiple defensive attempts; some APIs differ across Max versions.
        try ( maxOps.unhideAll() ) catch ()
        try ( LayerManager.unhideAll() ) catch ()
        try (
            local layers = LayerManager.layers
            for ly in layers do (
                try ( ly.isHidden = false ) catch ()
                try ( ly.on = true ) catch ()
            )
        ) catch ()
        for o in objects do (
            try ( o.isHidden = false ) catch ()
            try ( if o.isFrozen do o.isFrozen = false ) catch ()
        )
        local hiddenNow = 0
        for o in objects where o.isHidden do hiddenNow += 1
        hiddenNow
    )

    fn selectBiped = (
        clearSelection()
        local targets = #()
        for o in objects do (
            if (matchPattern o.name pattern:"Bip*") or (matchPattern o.name pattern:"*Footsteps*") do append targets o
        )
        if targets.count > 0 do select targets
        targets.count
    )

    -- variant: apply Biped2FBX flag? unhide? minimal default settings?
    fn exportVariant tag doBip2FBX doUnhide minimal = (
        L ""
        L ("=== variant " + tag + " (bip2fbx=" + (doBip2FBX as string) + " unhide=" + (doUnhide as string) + " minimal=" + (minimal as string) + ") ===")
        resetMaxFile #noPrompt
        local ok = true
        try ( loadMaxFile SRC useFileUnits:true quiet:true ) catch (
            ok = false
            L ("  LOAD_FAIL: " + (getCurrentException() as string))
        )
        if not ok do return false

        if doUnhide do (
            local hiddenNow = unhideEverything()
            L ("  hiddenAfterUnhide=" + (hiddenNow as string))
        )

        local resetRes = "?"
        try ( resetRes = FBXExporterSetParam "ResetExport" ) catch ( resetRes = "EXCEPTION" )
        L ("  ResetExport -> " + (resetRes as string))

        if minimal then (
            setParamLog "Animation" true
            setParamLog "BakeAnimation" true
        ) else (
            setParamLog "Animation" true
            setParamLog "BakeAnimation" true
            setParamLog "Bip2FBX" doBip2FBX
            setParamLog "BakeFrameStart" animationRange.start.frame
            setParamLog "BakeFrameEnd" animationRange.end.frame
            setParamLog "BakeFrameStep" 1
            setParamLog "BakeResampleAnimation" true
            setParamLog "FilterKeyReducer" false
            setParamLog "GeomAsBone" false
            setParamLog "Cameras" false
            setParamLog "Lights" false
            setParamLog "EmbedTextures" false
            setParamLog "ShowWarnings" false
            setParamLog "UpAxis" "Y"
        )

        local selectedCount = selectBiped()
        L ("  selectedBipObjects=" + (selectedCount as string))
        local selectedOnly = selectedCount > 0
        local outFile = OUTDIR + "\\StandBy_" + tag + ".fbx"
        local exported = false
        try (
            exportFile outFile #noPrompt selectedOnly:selectedOnly using:FBXEXP
            exported = true
        ) catch (
            exported = false
            L ("  EXPORT_FAIL: " + (getCurrentException() as string))
        )
        local sizeBytes = 0
        if (doesFileExist outFile) do sizeBytes = (getFileSize outFile)
        L ("  out=" + outFile + " exported=" + (exported as string) + " bytes=" + (sizeBytes as string))
        L ("  fps=" + (frameRate as string) + " range=" + (animationRange.start.frame as string) + "-" + (animationRange.end.frame as string))
        exported
    )

    L "=== export_experiments ==="
    L ("maxVersion: " + ((maxVersion()) as string))
    L ("src: " + SRC)

    -- A: current settings (as in the first pilot export, selection-only skeleton)
    exportVariant "A_current" true false false
    -- B: same but Bip2FBX=false
    exportVariant "B_nobip2fbx" false false false
    -- C: current settings + unhide everything first
    exportVariant "C_unhide" true true false
    -- D: no Bip2FBX + unhide
    exportVariant "D_unhide_nobip2fbx" false true false
    -- E: minimal default: only Animation + BakeAnimation
    exportVariant "E_minimal" false false true
    -- F: minimal default + unhide
    exportVariant "F_minimal_unhide" false true true

    -- Figure Mode diagnosis (for the current scene state) + attempts
    L ""
    L "=== figure mode probe (StandBy scene) ==="
    resetMaxFile #noPrompt
    try ( loadMaxFile SRC useFileUnits:true quiet:true ) catch ( L "  reload for figure probe FAILED" )
    for line in (bipedFigureModeReport()) do L line
    local fmChanged = tryTurnFigureModeOff()
    L ("  tryTurnFigureModeOff changedControllers=" + (fmChanged as string))
    for line in (bipedFigureModeReport()) do L line

    -- G/H: figure mode turned off + export with current / unhide settings
    -- (implemented as separate reloads so each variant starts clean)
    fn exportVariantFigureOff tag doUnhide minimal = (
        L ""
        L ("=== variant " + tag + " (figureModeOff + unhide=" + (doUnhide as string) + ") ===")
        resetMaxFile #noPrompt
        try ( loadMaxFile SRC useFileUnits:true quiet:true ) catch ( L "  LOAD_FAIL" )
        local changed = tryTurnFigureModeOff()
        L ("  figureMode controllers changed=" + (changed as string))
        for line in (bipedFigureModeReport()) do L line
        if doUnhide do ( L ("  hiddenAfterUnhide=" + (unhideEverything() as string)) )
        try ( FBXExporterSetParam "ResetExport" ) catch ()
        if minimal then (
            setParamLog "Animation" true
            setParamLog "BakeAnimation" true
        ) else (
            setParamLog "Animation" true
            setParamLog "BakeAnimation" true
            setParamLog "Bip2FBX" false
            setParamLog "BakeFrameStart" animationRange.start.frame
            setParamLog "BakeFrameEnd" animationRange.end.frame
            setParamLog "BakeFrameStep" 1
            setParamLog "BakeResampleAnimation" true
            setParamLog "FilterKeyReducer" false
            setParamLog "GeomAsBone" false
            setParamLog "Cameras" false
            setParamLog "Lights" false
            setParamLog "EmbedTextures" false
            setParamLog "ShowWarnings" false
            setParamLog "UpAxis" "Y"
        )
        local selectedCount = selectBiped()
        L ("  selectedBipObjects=" + (selectedCount as string))
        local outFile = OUTDIR + "\\StandBy_" + tag + ".fbx"
        local exported = false
        try ( exportFile outFile #noPrompt selectedOnly:(selectedCount > 0) using:FBXEXP; exported = true ) catch ( L ("  EXPORT_FAIL: " + (getCurrentException() as string)) )
        L ("  out=" + outFile + " exported=" + (exported as string))
        exported
    )
    exportVariantFigureOff "G_figureOff" false false
    exportVariantFigureOff "H_figureOff_unhide" true false

    -- I/J: collapse Biped layers into the base layer, then export (figure mode off too)
    fn exportVariantLayers tag doUnhide = (
        L ""
        L ("=== variant " + tag + " (collapseBipedLayers + unhide=" + (doUnhide as string) + ") ===")
        resetMaxFile #noPrompt
        try ( loadMaxFile SRC useFileUnits:true quiet:true ) catch ( L "  LOAD_FAIL" )
        try ( tryTurnFigureModeOff() ) catch ()
        if doUnhide do ( L ("  hiddenAfterUnhide=" + (unhideEverything() as string)) )
        for line in (activateAndCollapseBipedLayers()) do L line
        try ( FBXExporterSetParam "ResetExport" ) catch ()
        setParamLog "Animation" true
        setParamLog "BakeAnimation" true
        setParamLog "Bip2FBX" false
        setParamLog "BakeFrameStart" animationRange.start.frame
        setParamLog "BakeFrameEnd" animationRange.end.frame
        setParamLog "BakeFrameStep" 1
        setParamLog "BakeResampleAnimation" true
        setParamLog "FilterKeyReducer" false
        setParamLog "GeomAsBone" false
        setParamLog "Cameras" false
        setParamLog "Lights" false
        setParamLog "EmbedTextures" false
        setParamLog "ShowWarnings" false
        setParamLog "UpAxis" "Y"
        local selectedCount = selectBiped()
        L ("  selectedBipObjects=" + (selectedCount as string))
        local outFile = OUTDIR + "\\StandBy_" + tag + ".fbx"
        local exported = false
        try ( exportFile outFile #noPrompt selectedOnly:(selectedCount > 0) using:FBXEXP; exported = true ) catch ( L ("  EXPORT_FAIL: " + (getCurrentException() as string)) )
        L ("  out=" + outFile + " exported=" + (exported as string))
        exported
    )
    exportVariantLayers "I_collapseLayers" false
    exportVariantLayers "J_collapseLayers_unhide" true

    L ""
    L "=== DONE (6 variants) ==="
    close logF
    messageBox ("Exported 10 experiment variants to:\n" + OUTDIR + "\n\nPlease zip the whole folder and send it back together with experiments-log.txt.") title:"export_experiments.ms"
    true
)
