/*
    probe_scene_anim.ms  --  scene animation / hiding / Biped diagnostics
  
    Purpose: figure out why the 3ds Max Biped body animation is NOT baked into the
    exported FBX (only the secondary/face bones animate in the FBX; all Biped bones
    are static). This script opens one scene and dumps everything needed to tell:
      - whether Bip* nodes are animated in Max (and how: keys? controllers?)
      - whether objects/layers are hidden or frozen (a hidden animated rig may be
        skipped by the FBX export animation pass)
      - which classes the nodes actually have
      - a numeric transform probe at two frames for key Biped parts
  
    HOW TO RUN
    1. Edit SRC below (recommend D:\sjxl\max\StandBy.max).
    2. 3ds Max: Scripting > Run Script... pick this file.
    3. Send back the OUT text file (default D:\sjxl\probe-scene-anim.txt).
*/
(
    -- ============================== CONFIG ==============================
    local SRC = @"D:\sjxl\max\StandBy.max"
    local OUT = @"D:\sjxl\probe-scene-anim.txt"
    -- ====================================================================

    fn setParamRes name val = (
        local res = "unsupplied"
        try ( res = FBXExporterSetParam name val ) catch ( res = "EXCEPTION" )
        res
    )

    if not (doesFileExist SRC) do (
        messageBox ("File not found:\n" + SRC) title:"probe_scene_anim.ms"
        return false
    )
    local logF = createFile OUT
    fn L text = ( format "%\n" text to:logF )

    resetMaxFile #noPrompt
    local loaded = true
    try ( loadMaxFile SRC useFileUnits:true quiet:true ) catch (
        loaded = false
        L ("LOAD_FAIL: " + (getCurrentException() as string))
    )
    L "=== probe_scene_anim ==="
    L ("maxVersion: " + ((maxVersion()) as string))
    L ("file: " + SRC)
    L ("loaded: " + (loaded as string))

    -- 0) FBX exporter param acceptance (to know if BakeAnimation/Bip2FBX are real params)
    L ""
    L "--- FBX param acceptance ---"
    local resetRes = "?"
    try ( resetRes = FBXExporterSetParam "ResetExport" ) catch ( resetRes = "EXCEPTION" )
    L ("ResetExport -> " + (resetRes as string))
    local pairs = #(
        #("Animation", true), #("BakeAnimation", true), #("Bip2FBX", true),
        #("BakeFrameStart", 0), #("BakeFrameEnd", 10), #("BakeFrameStep", 1),
        #("BakeResampleAnimation", true), #("FilterKeyReducer", false),
        #("GeomAsBone", false), #("Skin", true), #("Shape", true),
        #("Cameras", false), #("Lights", false), #("EmbedTextures", false),
        #("ShowWarnings", false), #("UpAxis", "Y"), #("Triangulate", true),
        #("ConvertUnit", "cm"), #("ScaleFactor", 1.0), #("UseSceneName", true)
    )
    for item in pairs do (
        L ("  " + item[1] + " -> " + (setParamRes item[1] item[2]))
    )

    L ""
    L ("frameRate: " + (frameRate as string))
    L ("animationRange: " + (animationRange.start.frame as string) + " .. " + (animationRange.end.frame as string))
    L ("units: " + (units.SystemType as string) + " scale=" + (units.SystemScale as string))
    L ("objectCount: " + (objects.count as string))

    -- 1) hidden / frozen / layers
    local hiddenCount = 0
    local frozenCount = 0
    local hiddenAnimated = 0
    for o in objects do (
        if o.isHidden do hiddenCount += 1
        if o.isFrozen do frozenCount += 1
        if (o.isHidden and o.isAnimated) do hiddenAnimated += 1
    )
    L ""
    L "--- visibility ---"
    L ("hiddenObjects: " + (hiddenCount as string))
    L ("frozenObjects: " + (frozenCount as string))
    L ("hiddenAndAnimated: " + (hiddenAnimated as string))
    local layers = LayerManager.layers
    L ("layerCount: " + (layers.count as string))
    for ly in layers do (
        local hiddenFlag = "?"
        try ( hiddenFlag = (ly.isHidden as string) ) catch ()
        L ("  layer: " + ly.name + "  hidden=" + hiddenFlag + "  on=" + (ly.on as string))
    )

    -- 2) Biped related objects: class, animation state, controller, hidden
    L ""
    L "--- Biped named nodes (first 80) ---"
    local bipNodes = for o in objects where (matchPattern o.name pattern:"Bip*") collect o
    L ("bipNamedCount: " + (bipNodes.count as string))
    local i = 0
    for o in bipNodes do (
        if i < 80 do (
            local cn = "?"
            local ctrl = "?"
            local anim = "?"
            try ( cn = (classOf o) as string ) catch ()
            try ( ctrl = (if o.controller != undefined then (classOf o.controller) as string else "none") ) catch ()
            try ( anim = (o.isAnimated as string) ) catch ()
            L ("  " + o.name + " | class=" + cn + " | animated=" + anim + " | controller=" + ctrl + " | hidden=" + (o.isHidden as string))
        )
        i += 1
    )

    -- 3) find the Biped root object(s) by class name
    L ""
    L "--- Biped root objects (class name contains Biped) ---"
    for o in objects do (
        local cn = ""
        try ( cn = (classOf o) as string ) catch ()
        if (matchPattern cn pattern:"*Biped*") do (
            L ("  " + o.name + " | class=" + cn + " | animated=" + (o.isAnimated as string) + " | hidden=" + (o.isHidden as string))
        )
    )

    -- 4) transform probe at two frames for key Biped parts (does the rig move in Max?)
    L ""
    L "--- transform probe (frame start vs middle) ---"
    local f0 = animationRange.start.frame
    local f1 = ((animationRange.start.frame + animationRange.end.frame) / 2) as integer
    L ("frames: " + (f0 as string) + " / " + (f1 as string))
    local probeNames = #(
        "Bip001 Pelvis", "Bip001 L UpperArm", "Bip001 L Forearm", "Bip001 Spine",
        "Bip001 L Thigh", "Bip001 Head", "Bip001"
    )
    for nm in probeNames do (
        local n = getNodeByName nm
        if n == undefined then (
            L ("  " + nm + " : NOT FOUND as scene object")
        ) else (
            local p0 = "?"; local p1 = "?"; local r0 = "?"; local r1 = "?"
            try ( p0 = (at time f0 n.transform).translation as string ) catch ( p0 = "EXCEPTION" )
            try ( p1 = (at time f1 n.transform).translation as string ) catch ( p1 = "EXCEPTION" )
            try ( r0 = (at time f0 n.transform).rotation as string ) catch ( r0 = "EXCEPTION" )
            try ( r1 = (at time f1 n.transform).rotation as string ) catch ( r1 = "EXCEPTION" )
            L ("  " + nm)
            L ("    pos@f0=" + p0 + "  pos@f1=" + p1)
            L ("    rot@f0=" + r0 + "  rot@f1=" + r1)
            L ("    changed=" + (((p0 != p1) or (r0 != r1)) as string))
        )
    )

    -- 5) Biped API probe (if a Biped class object exists, query its pelvis through the API)
    L ""
    L "--- Biped API probe ---"
    local bipedRoots = #()
    for o in objects do (
        local cn = ""
        try ( cn = (classOf o) as string ) catch ()
        if (matchPattern cn pattern:"Biped") do append bipedRoots o
    )
    L ("bipedRootCount: " + (bipedRoots.count as string))
    for b in bipedRoots do (
        L ("  biped root: " + b.name)
        local pelvis = undefined
        try ( pelvis = biped.getNode b #pelvis ) catch ( L "    biped.getNode EXCEPTION" )
        if pelvis != undefined then (
            local pp0 = "?"; local pp1 = "?"
            try ( pp0 = (at time f0 pelvis.transform).translation as string ) catch ( pp0 = "EXCEPTION" )
            try ( pp1 = (at time f1 pelvis.transform).translation as string ) catch ( pp1 = "EXCEPTION" )
            L ("    pelvis pos@f0=" + pp0 + "  pos@f1=" + pp1)
            L ("    pelvis changed=" + ((pp0 != pp1) as string))
        )
    )

    -- 6) Biped animation layers (animation may live on Biped layers, not the base layer;
    --    an FBX bake may then miss it -- a further root-cause candidate)
    L ""
    L "--- Biped animation layers ---"
    local layerBipeds = 0
    for o in objects do (
        local ctrl = undefined
        try ( ctrl = o.transform.controller ) catch ()
        if ctrl != undefined do (
            local cn = ""
            try ( cn = (classOf ctrl) as string ) catch ()
            if (matchPattern cn pattern:"*Biped*") do (
                layerBipeds += 1
                local n = -1
                try ( n = biped.numLayers ctrl ) catch ()
                L ("  biped root=" + o.name + " numLayers=" + (n as string))
                if n > 0 do (
                    for li = 1 to n do (
                        local layerName = "?"
                        local layerActive = "?"
                        try ( layerName = biped.getLayerName ctrl li ) catch ()
                        try ( layerActive = (biped.getLayerActive ctrl li) as string ) catch ()
                        L ("    layer " + (li as string) + " name=" + layerName + " active=" + layerActive)
                    )
                    local curLayer = "?"
                    try ( curLayer = biped.getCurrentLayer ctrl ) catch ()
                    L ("    currentLayer=" + (curLayer as string))
                )
            )
        )
    )
    if layerBipeds == 0 do L "  no biped transform controller found"

    L ""
    L "=== MANUAL CHECKS (please report these too, with a screenshot if possible) ==="
    L "1) In 3ds Max, select the Biped root (e.g. Bip001) -> Motion panel -> Biped rollout:"
    L "   is the Figure Mode button (small stick-figure icon) highlighted/ON?"
    L "2) Press Play: does the character BODY visibly move? Or only hair/cloth?"
    L "3) Scrub to the middle frame: does the viewport body pose change vs frame 0?"
    L "   (The transform probe above already reports body bone changes numerically.)"
    L "If Figure Mode is ON, please run export_experiments.ms again with Variant C/D"
    L "after clicking Figure Mode OFF in the UI (or tell us it was ON)."
    L ""
    L "=== END ==="
    close logF
    messageBox ("Probe written to:\n" + OUT + "\n\nPlease send this file back.") title:"probe_scene_anim.ms"
    true
)
