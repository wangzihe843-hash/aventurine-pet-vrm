/*
    export_one.ms  --  export the CURRENTLY OPEN 3ds Max scene to FBX (manual fallback)
    ---------------------------------------------------------------------------------
    Use this only when run_pilot.bat / run_full.bat cannot run (batch mode, license,
    graphics device, or a script error) and you need to export one scene by hand.

    HOW TO RUN
    1. Open the .max scene in 3ds Max.
    2. In 3ds Max: Scripting > Run Script... (Chinese UI: 脚本 > 运行脚本...) and pick
       this file.
    3. The FBX is written to OUT_DIR\<scene name>.fbx.

    For the pilot please open and export these 6 scenes, one by one:
      Tpose.max, StandBy.max, Walk.max, Talk01.max, Skill01.max, State_Stun.max
*/

(
    -- ============================== CONFIG ==============================
    local OUT_DIR = @"D:\sjxl\manual"
    -- ====================================================================

    if not (doesFileExist OUT_DIR) do ( makeDir OUT_DIR )
    if not (doesFileExist OUT_DIR) do (
        messageBox ("Cannot create output folder:\n" + OUT_DIR) title:"export_one.ms"
        return false
    )

    local base = getFilenameFile maxFileName
    if base == "" do base = "untitled"
    local outFile = OUT_DIR + "\\" + base + ".fbx"

    try ( FBXExporterSetParam "ResetExport" ) catch ()
    FBXExporterSetParam "Animation" true
    FBXExporterSetParam "BakeAnimation" true
    FBXExporterSetParam "Bip2FBX" true
    FBXExporterSetParam "BakeFrameStart" animationRange.start.frame
    FBXExporterSetParam "BakeFrameEnd" animationRange.end.frame
    FBXExporterSetParam "BakeFrameStep" 1
    FBXExporterSetParam "FilterKeyReducer" false
    FBXExporterSetParam "Cameras" false
    FBXExporterSetParam "Lights" false
    FBXExporterSetParam "EmbedTextures" false
    FBXExporterSetParam "ShowWarnings" false
    FBXExporterSetParam "UpAxis" "Y"
    FBXExporterSetParam "Triangulate" true

    local ok = true
    try (
        exportFile outFile #noPrompt selectedOnly:false using:FBXEXP
    ) catch (
        ok = false
        messageBox ("Export failed:\n" + (getCurrentException() as string)) title:"export_one.ms"
    )
    if ok do (
        messageBox ("Exported:\n" + outFile + "\n\nNext: open the next .max and run this script again.") title:"export_one.ms"
    )
    ok
)
