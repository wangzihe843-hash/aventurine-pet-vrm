using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace AventurineBake
{
    [Serializable]
    public class ClipEntry
    {
        public string name;
        public string mood;
        public string path;
        public bool loop = true;
        public float timeScale = 1f;
    }

    [Serializable]
    public class BakeConfig
    {
        public float fps = 30f;
        public string outputDir = "";
        public string clipsRoot = "";
        public string scenePath = "";
        public string avatarPrefabPath = "";
        public string avatarNameContains = "";
        public bool syntheticAvatar = true;
        public float sourceHeightMeters = 1.7f;
        public bool includeFingers = false;
        public ClipEntry[] clips = new ClipEntry[0];
    }

    [Serializable]
    public class BoneTrack
    {
        public string name;
        public float[] rest;
        public float[] rot;
        public float[] pos;
    }

    [Serializable]
    public class ClipFile
    {
        public int version = 1;
        public string clip;
        public string mood;
        public bool loop;
        public float fps;
        public float duration;
        public string avatar;
        public float sourceHeight;
        public string space = "unity-lh";
        public int frames;
        public BoneTrack[] bones;
    }

    /// <summary>
    /// U1：把 Mate-Engine 的 Humanoid .anim 采集成 JSON。
    /// 推荐用法：空 Unity 工程 + 只拷贝 .anim + 本脚本，用 syntheticAvatar 自动建一个标准 humanoid 骨架采样，
    /// 不依赖 Mate-Engine 工程/avatar/DLC/资源包。
    /// 批处理入口：AventurineBake.ClipExporter.Run
    /// </summary>
    public static class ClipExporter
    {
        const string TAG = "[AventurineBake] ";
        static readonly List<UnityEngine.Object> _tempObjects = new List<UnityEngine.Object>();
        static Animator _animator;

        public static void Run()
        {
            try { RunInternal(); }
            catch (Exception e)
            {
                Debug.LogError(TAG + "EXPORT FAILED: " + e);
                EditorApplication.Exit(1);
            }
        }

        static string ArgValue(string name)
        {
            var args = Environment.GetCommandLineArgs();
            for (int i = 0; i < args.Length - 1; i++) if (args[i] == name) return args[i + 1];
            return null;
        }

        static void RunInternal()
        {
            string cfgPath = Environment.GetEnvironmentVariable("AVENTURINE_BAKE_CONFIG") ?? ArgValue("-aventurineBakeConfig");
            if (string.IsNullOrEmpty(cfgPath)) throw new Exception("missing config path (AVENTURINE_BAKE_CONFIG)");
            cfgPath = Path.GetFullPath(cfgPath);
            if (!File.Exists(cfgPath)) throw new Exception("config not found: " + cfgPath);
            var cfg = JsonUtility.FromJson<BakeConfig>(File.ReadAllText(cfgPath));
            if (cfg == null || cfg.clips == null || cfg.clips.Length == 0) throw new Exception("empty clip list in " + cfgPath);

            string outDir = Environment.GetEnvironmentVariable("AVENTURINE_BAKE_OUT");
            if (string.IsNullOrEmpty(outDir)) outDir = Path.Combine(Path.GetDirectoryName(cfgPath), "out");
            Directory.CreateDirectory(outDir);

            _animator = FindHumanoidAnimator(cfg);
            if (_animator == null && cfg.syntheticAvatar)
            {
                Debug.Log(TAG + "no project avatar found; building synthetic humanoid rig...");
                _animator = BuildSyntheticHumanoid();
            }
            if (_animator == null)
            {
                DumpHumanoidCandidates();
                throw new Exception("no humanoid Animator. Set avatarPrefabPath/scenePath, or enable syntheticAvatar.");
            }

            var avatar = _animator.avatar;
            Debug.Log(TAG + "avatar=" + (avatar != null ? avatar.name : "null") + " humanoid=" + (avatar != null && avatar.isHuman));

            var bones = CollectBones(_animator, cfg.includeFingers);
            if (bones.Count == 0) throw new Exception("no humanoid bones found on animator");

            var restRot = new Dictionary<HumanBodyBones, Quaternion>();
            var restPos = new Dictionary<HumanBodyBones, Vector3>();
            foreach (var b in bones)
            {
                var t = _animator.GetBoneTransform(b);
                restRot[b] = t.localRotation;
                restPos[b] = t.localPosition;
            }
            float height = EstimateHeight(_animator, cfg.sourceHeightMeters);
            Debug.Log(TAG + "bones=" + bones.Count + " height=" + height + " fps=" + cfg.fps);

            var done = new List<string>();
            foreach (var entry in cfg.clips)
            {
                if (entry == null || string.IsNullOrEmpty(entry.path)) continue;
                var clip = ResolveClip(entry.path, cfg.clipsRoot);
                if (clip == null) { Debug.LogError(TAG + "clip not found: " + entry.path); continue; }
                var data = ExportClip(cfg, entry, clip, bones, restRot, restPos, height);
                string name = SafeFileName(string.IsNullOrEmpty(entry.name) ? clip.name : entry.name);
                string file = Path.Combine(outDir, name + ".json");
                File.WriteAllText(file, JsonUtility.ToJson(data, true));
                Debug.Log(TAG + "wrote " + file + " (" + data.frames + " frames, " + data.duration.ToString("0.00") + "s)");
                done.Add(name);
            }
            Debug.Log(TAG + "done: " + string.Join(", ", done));
        }

        static AnimationClip ResolveClip(string path, string clipsRoot)
        {
            var cands = new List<string>();
            if (!string.IsNullOrEmpty(clipsRoot)) cands.Add(clipsRoot.TrimEnd('/') + "/" + path);
            cands.Add(path);
            cands.Add("Assets/MATE ENGINE - Animations/" + path);
            foreach (var c in cands)
            {
                if (!c.StartsWith("Assets/")) continue;
                var clip = AssetDatabase.LoadAssetAtPath<AnimationClip>(c);
                if (clip != null) return clip;
            }
            // fallback: search by filename
            string fileName = Path.GetFileName(path);
            string stem = Path.GetFileNameWithoutExtension(path);
            foreach (var guid in AssetDatabase.FindAssets(stem + " t:AnimationClip"))
            {
                string p = AssetDatabase.GUIDToAssetPath(guid);
                if (p.EndsWith("/" + fileName, StringComparison.OrdinalIgnoreCase))
                    return AssetDatabase.LoadAssetAtPath<AnimationClip>(p);
            }
            return null;
        }

        static ClipFile ExportClip(BakeConfig cfg, ClipEntry entry, AnimationClip clip, List<HumanBodyBones> bones,
            Dictionary<HumanBodyBones, Quaternion> restRot, Dictionary<HumanBodyBones, Vector3> restPos, float height)
        {
            float fps = cfg.fps <= 0 ? 30f : cfg.fps;
            float length = Mathf.Max(clip.length, 1f / fps);
            bool loop = entry.loop;
            int frames = Mathf.RoundToInt(length * fps);
            if (frames < 1) frames = 1;
            if (!loop) frames += 1;

            var tracks = new Dictionary<HumanBodyBones, BoneTrack>();
            foreach (var b in bones)
            {
                tracks[b] = new BoneTrack
                {
                    name = b.ToString(),
                    rest = new[] { restRot[b].x, restRot[b].y, restRot[b].z, restRot[b].w },
                    rot = new float[frames * 4],
                    pos = b == HumanBodyBones.Hips ? new float[frames * 3] : null
                };
            }

            var startPos = _animator.transform.position;
            var startRot = _animator.transform.rotation;

            AnimationMode.StartAnimationMode();
            try
            {
                for (int f = 0; f < frames; f++)
                {
                    float t = Mathf.Min(f / fps, length);

                    foreach (var b in bones)
                    {
                        var tr = _animator.GetBoneTransform(b);
                        tr.localRotation = restRot[b];
                        tr.localPosition = restPos[b];
                    }

                    AnimationMode.BeginSampling();
                    AnimationMode.SampleAnimationClip(_animator.gameObject, clip, t);
                    AnimationMode.EndSampling();

                    foreach (var b in bones)
                    {
                        var tr = _animator.GetBoneTransform(b);
                        var qNorm = Quaternion.Inverse(restRot[b]) * tr.localRotation;
                        var track = tracks[b];
                        track.rot[f * 4 + 0] = qNorm.x;
                        track.rot[f * 4 + 1] = qNorm.y;
                        track.rot[f * 4 + 2] = qNorm.z;
                        track.rot[f * 4 + 3] = qNorm.w;
                        if (track.pos != null)
                        {
                            var d = tr.localPosition - restPos[b];
                            track.pos[f * 3 + 0] = d.x;
                            track.pos[f * 3 + 1] = d.y;
                            track.pos[f * 3 + 2] = d.z;
                        }
                    }
                }
            }
            finally
            {
                AnimationMode.StopAnimationMode();
                _animator.transform.position = startPos;
                _animator.transform.rotation = startRot;
            }

            return new ClipFile
            {
                clip = string.IsNullOrEmpty(entry.name) ? clip.name : entry.name,
                mood = entry.mood,
                loop = loop,
                fps = fps,
                duration = length,
                avatar = _animator.avatar != null ? _animator.avatar.name : "unknown",
                sourceHeight = height,
                frames = frames,
                bones = tracks.Values.ToArray()
            };
        }

        static List<HumanBodyBones> CollectBones(Animator animator, bool includeFingers)
        {
            var result = new List<HumanBodyBones>();
            foreach (HumanBodyBones b in Enum.GetValues(typeof(HumanBodyBones)))
            {
                if (b == HumanBodyBones.LastBone) continue;
                string n = b.ToString();
                bool isFinger = n.StartsWith("LeftThumb") || n.StartsWith("RightThumb")
                    || n.StartsWith("LeftIndex") || n.StartsWith("RightIndex")
                    || n.StartsWith("LeftMiddle") || n.StartsWith("RightMiddle")
                    || n.StartsWith("LeftRing") || n.StartsWith("RightRing")
                    || n.StartsWith("LeftLittle") || n.StartsWith("RightLittle");
                if (isFinger && !includeFingers) continue;
                if (animator.GetBoneTransform(b) != null) result.Add(b);
            }
            return result;
        }

        static Animator FindHumanoidAnimator(BakeConfig cfg)
        {
            if (!string.IsNullOrEmpty(cfg.scenePath))
            {
                if (!File.Exists(cfg.scenePath)) throw new Exception("scene not found: " + cfg.scenePath);
                EditorSceneManager.OpenScene(cfg.scenePath, OpenSceneMode.Single);
            }

            var found = Resources.FindObjectsOfTypeAll<Animator>()
                .Where(a => a != null && a.avatar != null && a.avatar.isHuman && a.gameObject.scene.IsValid())
                .Where(a => string.IsNullOrEmpty(cfg.avatarNameContains)
                    || a.name.Contains(cfg.avatarNameContains)
                    || a.avatar.name.Contains(cfg.avatarNameContains))
                .OrderByDescending(a => a.avatar.name.Length)
                .ToList();
            if (found.Count > 0) return found[0];

            if (!string.IsNullOrEmpty(cfg.avatarPrefabPath))
            {
                var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(cfg.avatarPrefabPath);
                if (prefab == null) throw new Exception("avatarPrefabPath not found: " + cfg.avatarPrefabPath);
                var go = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
                _tempObjects.Add(go);
                var animator = go.GetComponent<Animator>();
                if (animator == null) animator = go.AddComponent<Animator>();
                var avatar = animator.avatar;
                if (avatar == null || !avatar.isHuman)
                {
                    avatar = AssetDatabase.LoadAllAssetsAtPath(cfg.avatarPrefabPath).OfType<Avatar>().FirstOrDefault(a => a.isHuman);
                    if (avatar != null) animator.avatar = avatar;
                }
                if (avatar != null && avatar.isHuman) return animator;
                throw new Exception("avatarPrefabPath has no humanoid Avatar: " + cfg.avatarPrefabPath);
            }
            return null;
        }

        // ---------- 合成标准 humanoid 骨架（不依赖工程里的 avatar） ----------
        static Animator BuildSyntheticHumanoid()
        {
            var root = new GameObject("AventurineBakeRig");
            _tempObjects.Add(root);
            var animator = root.AddComponent<Animator>();

            // 手性约定（Wave 1.5 GT 实测修正，2026-11-08）：
            // Unity 是左手系（X 右 / Y 上 / Z 前）；角色面向 +Z 时，角色的 Left 在 **-X**、Right 在 +X。
            // 旧实现把 Left 放在 +X（左右镜像），导致烘焙出的手臂 normalized 旋转左右手性相反
            // （GT 对拍：手臂 ΔW 166°；修正后 ~17.6°）。腿部同理。
            Transform Bone(string name, Transform parent, Vector3 localPos)
            {
                var go = new GameObject(name);
                go.transform.SetParent(parent, false);
                go.transform.localPosition = localPos;
                go.transform.localRotation = Quaternion.identity;
                return go.transform;
            }

            var hips = Bone("Hips", root.transform, new Vector3(0f, 1.0f, 0f));
            var spine = Bone("Spine", hips, new Vector3(0f, 0.12f, 0f));
            var chest = Bone("Chest", spine, new Vector3(0f, 0.12f, 0f));
            var upperChest = Bone("UpperChest", chest, new Vector3(0f, 0.12f, 0f));
            var neck = Bone("Neck", upperChest, new Vector3(0f, 0.12f, 0f));
            var head = Bone("Head", neck, new Vector3(0f, 0.10f, 0f));

            var lShoulder = Bone("LeftShoulder", upperChest, new Vector3(-0.05f, 0.10f, 0f));
            var lUpperArm = Bone("LeftUpperArm", lShoulder, new Vector3(-0.12f, 0f, 0f));
            var lLowerArm = Bone("LeftLowerArm", lUpperArm, new Vector3(-0.28f, 0f, 0f));
            var lHand = Bone("LeftHand", lLowerArm, new Vector3(-0.25f, 0f, 0f));

            var rShoulder = Bone("RightShoulder", upperChest, new Vector3(0.05f, 0.10f, 0f));
            var rUpperArm = Bone("RightUpperArm", rShoulder, new Vector3(0.12f, 0f, 0f));
            var rLowerArm = Bone("RightLowerArm", rUpperArm, new Vector3(0.28f, 0f, 0f));
            var rHand = Bone("RightHand", rLowerArm, new Vector3(0.25f, 0f, 0f));

            var lUpperLeg = Bone("LeftUpperLeg", hips, new Vector3(-0.09f, -0.02f, 0f));
            var lLowerLeg = Bone("LeftLowerLeg", lUpperLeg, new Vector3(0f, -0.45f, 0f));
            var lFoot = Bone("LeftFoot", lLowerLeg, new Vector3(0f, -0.45f, 0.02f));
            var lToes = Bone("LeftToes", lFoot, new Vector3(0f, 0f, 0.12f));

            var rUpperLeg = Bone("RightUpperLeg", hips, new Vector3(0.09f, -0.02f, 0f));
            var rLowerLeg = Bone("RightLowerLeg", rUpperLeg, new Vector3(0f, -0.45f, 0f));
            var rFoot = Bone("RightFoot", rLowerLeg, new Vector3(0f, -0.45f, 0.02f));
            var rToes = Bone("RightToes", rFoot, new Vector3(0f, 0f, 0.12f));

            var all = new List<Transform> { root.transform, hips, spine, chest, upperChest, neck, head,
                lShoulder, lUpperArm, lLowerArm, lHand, rShoulder, rUpperArm, rLowerArm, rHand,
                lUpperLeg, lLowerLeg, lFoot, lToes, rUpperLeg, rLowerLeg, rFoot, rToes };

            var hd = new HumanDescription();
            hd.human = new[]
            {
                HB("Hips", hips), HB("Spine", spine), HB("Chest", chest), HB("UpperChest", upperChest),
                HB("Neck", neck), HB("Head", head),
                HB("LeftShoulder", lShoulder), HB("LeftUpperArm", lUpperArm), HB("LeftLowerArm", lLowerArm), HB("LeftHand", lHand),
                HB("RightShoulder", rShoulder), HB("RightUpperArm", rUpperArm), HB("RightLowerArm", rLowerArm), HB("RightHand", rHand),
                HB("LeftUpperLeg", lUpperLeg), HB("LeftLowerLeg", lLowerLeg), HB("LeftFoot", lFoot), HB("LeftToes", lToes),
                HB("RightUpperLeg", rUpperLeg), HB("RightLowerLeg", rLowerLeg), HB("RightFoot", rFoot), HB("RightToes", rToes)
            };
            hd.skeleton = all.Select(t => new SkeletonBone
            {
                name = t.name,
                position = t.localPosition,
                rotation = t.localRotation,
                scale = t.localScale
            }).ToArray();
            hd.upperArmTwist = 0.5f;
            hd.lowerArmTwist = 0.5f;
            hd.upperLegTwist = 0.5f;
            hd.lowerLegTwist = 0.5f;
            hd.armStretch = 0.05f;
            hd.legStretch = 0.05f;
            hd.feetSpacing = 0.0f;
            hd.hasTranslationDoF = false;

            var avatar = AvatarBuilder.BuildHumanAvatar(root, hd);
            if (avatar == null || !avatar.isValid || !avatar.isHuman)
                throw new Exception("synthetic AvatarBuilder failed (valid=" + (avatar != null && avatar.isValid) + ", human=" + (avatar != null && avatar.isHuman) + ")");
            avatar.name = "AventurineBakeSyntheticAvatar";
            animator.avatar = avatar;
            animator.applyRootMotion = false;
            return animator;
        }

        static HumanBone HB(string humanName, Transform t) => new HumanBone
        {
            boneName = t.name,
            humanName = humanName,
            limit = new HumanLimit { useDefaultValues = true }
        };

        static void DumpHumanoidCandidates()
        {
            Debug.Log(TAG + "candidates: scanning project for humanoid avatars/models...");
            var guids = AssetDatabase.FindAssets("t:Model t:Prefab");
            int printed = 0;
            foreach (var guid in guids)
            {
                string path = AssetDatabase.GUIDToAssetPath(guid);
                if (!path.StartsWith("Assets/")) continue;
                var avatars = AssetDatabase.LoadAllAssetsAtPath(path).OfType<Avatar>().Where(a => a != null && a.isHuman).ToList();
                if (avatars.Count == 0) continue;
                Debug.Log(TAG + "  " + path + " -> " + string.Join(",", avatars.Select(a => a.name)));
                if (++printed >= 20) break;
            }
            if (printed == 0) Debug.Log(TAG + "  (none found)");
        }

        static float EstimateHeight(Animator animator, float fallback)
        {
            var smr = animator.GetComponentsInChildren<SkinnedMeshRenderer>(true).FirstOrDefault();
            if (smr != null)
            {
                float h = smr.bounds.size.y;
                if (h > 0.2f && h < 5f) return h;
            }
            var head = animator.GetBoneTransform(HumanBodyBones.Head);
            if (head != null)
            {
                float h = head.position.y + 0.12f;
                if (h > 0.5f && h < 3f) return h;
            }
            return fallback > 0 ? fallback : 1.7f;
        }

        static string SafeFileName(string s)
        {
            foreach (char c in Path.GetInvalidFileNameChars()) s = s.Replace(c, '_');
            return s;
        }
    }
}
