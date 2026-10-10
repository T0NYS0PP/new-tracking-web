"""
Export a Gaussian-splat training dataset from an Unreal Engine level.

Run inside the Unreal Editor (Edit > Plugins > "Python Editor Script Plugin" enabled):

    py "C:/path/to/ue_export_splat_dataset.py"

or paste into the Python console. Edit the CONFIG block first (pivot, base camera, output).

What it does
  1. Builds a set of camera poses on a spherical cap around PIVOT, all looking at PIVOT.
     Yaw / pitch / distance ranges should cover (and slightly exceed) what the web hero shows.
  2. Renders every pose with a SceneCapture2D (final tonemapped colour, fixed exposure,
     no motion blur / DoF / vignette / lens flare) to <OUTPUT_DIR>/images/NNNN.png.
  3. Writes <OUTPUT_DIR>/transforms.json in Nerfstudio format (OpenGL camera convention,
     right-handed Z-up world in metres) so Nerfstudio can train without running COLMAP.
     PostShot ignores the JSON and runs its own camera solve on the images.

Tested conventions, not tested code: this script was written without access to an Unreal
install. Run it once with DRY_RUN = True to check the pose coverage in the Output Log, then
render a small set (YAW_STEPS = 3, PITCH_STEPS = 2) before the full export.
"""

import json
import math
import os
import sys

import unreal

# ----------------------------------------------------------------------------------------------
# CONFIG - edit these
# ----------------------------------------------------------------------------------------------
CONFIG = {
    # Point the viewer "looks at" through the window (UE world units, cm).
    "PIVOT": (0.0, 0.0, 130.0),
    # Where the neutral camera sits: distance and direction to PIVOT come from this.
    "BASE_CAMERA": (-350.0, 0.0, 150.0),
    # Angular coverage around the base direction (degrees). The hero orbits ±20° yaw / ±10°
    # pitch, so cover a bit more than that.
    "YAW_RANGE_DEG": 32.0,
    "PITCH_RANGE_DEG": 16.0,
    # Distance multipliers relative to the base distance (the hero moves ±~25 % in depth).
    "DISTANCE_SCALES": (0.8, 1.0, 1.2),
    # Grid density. Total images = YAW_STEPS * PITCH_STEPS * len(DISTANCE_SCALES).
    "YAW_STEPS": 13,
    "PITCH_STEPS": 7,
    # Small random offset (cm) added to every position so views are not perfectly coplanar.
    "JITTER_CM": 4.0,
    # Image size and horizontal field of view (degrees).
    "WIDTH": 1920,
    "HEIGHT": 1080,
    "FOV_DEG": 60.0,
    # Manual exposure (EV100 bias applied with auto exposure disabled). Adjust to taste.
    "EXPOSURE_BIAS": 0.0,
    # Output folder (created if missing).
    "OUTPUT_DIR": os.path.join(unreal.Paths.project_saved_dir(), "SplatDataset"),
    # True: only compute and log poses, render nothing.
    "DRY_RUN": False,
    # Keep the capture actor in the level after export (useful to inspect the last pose).
    "KEEP_ACTOR": False,
}

# ----------------------------------------------------------------------------------------------
# Pose generation
# ----------------------------------------------------------------------------------------------

def _vec(t):
    return unreal.Vector(float(t[0]), float(t[1]), float(t[2]))


def _lerp(a, b, t):
    return a + (b - a) * t


def build_poses(cfg):
    """Return a list of (location: Vector, rotation: Rotator) looking at the pivot."""
    import random

    random.seed(1234)  # deterministic jitter so re-exports match
    pivot = _vec(cfg["PIVOT"])
    base = _vec(cfg["BASE_CAMERA"])
    offset = base - pivot
    distance = offset.length()
    if distance < 1.0:
        raise ValueError("BASE_CAMERA must not coincide with PIVOT")

    base_dir = offset / distance
    base_yaw = math.degrees(math.atan2(base_dir.y, base_dir.x))
    base_pitch = math.degrees(math.asin(max(-1.0, min(1.0, base_dir.z))))

    poses = []
    yaw_steps = max(1, int(cfg["YAW_STEPS"]))
    pitch_steps = max(1, int(cfg["PITCH_STEPS"]))
    for scale in cfg["DISTANCE_SCALES"]:
        for pi in range(pitch_steps):
            tp = 0.5 if pitch_steps == 1 else pi / (pitch_steps - 1)
            pitch = base_pitch + _lerp(-cfg["PITCH_RANGE_DEG"], cfg["PITCH_RANGE_DEG"], tp)
            for yi in range(yaw_steps):
                ty = 0.5 if yaw_steps == 1 else yi / (yaw_steps - 1)
                yaw = base_yaw + _lerp(-cfg["YAW_RANGE_DEG"], cfg["YAW_RANGE_DEG"], ty)
                r = distance * scale
                cp = math.cos(math.radians(pitch))
                direction = unreal.Vector(
                    cp * math.cos(math.radians(yaw)),
                    cp * math.sin(math.radians(yaw)),
                    math.sin(math.radians(pitch)),
                )
                jitter = unreal.Vector(
                    random.uniform(-1, 1) * cfg["JITTER_CM"],
                    random.uniform(-1, 1) * cfg["JITTER_CM"],
                    random.uniform(-1, 1) * cfg["JITTER_CM"],
                )
                location = pivot + direction * r + jitter
                rotation = unreal.MathLibrary.find_look_at_rotation(location, pivot)
                poses.append((location, rotation))
    return poses


# ----------------------------------------------------------------------------------------------
# Nerfstudio transforms.json
# ----------------------------------------------------------------------------------------------

def _ue_to_rh(v):
    """UE is left-handed (X forward, Y right, Z up, cm). Negating Y gives the same physical
    scene in a right-handed Z-up frame; divide by 100 for metres."""
    return (v.x / 100.0, -v.y / 100.0, v.z / 100.0)


def _ue_dir_to_rh(v):
    return (v.x, -v.y, v.z)


def camera_to_world(location, rotation):
    """4x4 camera-to-world in the OpenGL convention (+X right, +Y up, -Z forward)."""
    fwd = _ue_dir_to_rh(unreal.MathLibrary.get_forward_vector(rotation))
    right = _ue_dir_to_rh(unreal.MathLibrary.get_right_vector(rotation))
    up = _ue_dir_to_rh(unreal.MathLibrary.get_up_vector(rotation))
    pos = _ue_to_rh(location)
    back = (-fwd[0], -fwd[1], -fwd[2])
    return [
        [right[0], up[0], back[0], pos[0]],
        [right[1], up[1], back[1], pos[1]],
        [right[2], up[2], back[2], pos[2]],
        [0.0, 0.0, 0.0, 1.0],
    ]


def write_transforms(cfg, poses, image_names):
    w, h = int(cfg["WIDTH"]), int(cfg["HEIGHT"])
    fl = (w / 2.0) / math.tan(math.radians(cfg["FOV_DEG"]) / 2.0)
    frames = []
    for (location, rotation), name in zip(poses, image_names):
        frames.append({
            "file_path": "images/" + name,
            "transform_matrix": camera_to_world(location, rotation),
        })
    data = {
        "camera_model": "OPENCV",
        "w": w,
        "h": h,
        "fl_x": fl,
        "fl_y": fl,
        "cx": w / 2.0,
        "cy": h / 2.0,
        "k1": 0.0, "k2": 0.0, "p1": 0.0, "p2": 0.0,
        "frames": frames,
    }
    path = os.path.join(cfg["OUTPUT_DIR"], "transforms.json")
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
    return path


# ----------------------------------------------------------------------------------------------
# Rendering
# ----------------------------------------------------------------------------------------------

def _editor_world():
    try:
        return unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
    except Exception:
        return unreal.EditorLevelLibrary.get_editor_world()


def _spawn(actor_class, location, rotation):
    try:
        subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
        return subsystem.spawn_actor_from_class(actor_class, location, rotation)
    except Exception:
        return unreal.EditorLevelLibrary.spawn_actor_from_class(actor_class, location, rotation)


def _destroy(actor):
    try:
        unreal.get_editor_subsystem(unreal.EditorActorSubsystem).destroy_actor(actor)
    except Exception:
        unreal.EditorLevelLibrary.destroy_actor(actor)


def _set_pp(settings, overrides):
    """Set post-process overrides defensively (property names vary slightly between versions)."""
    for name, value in overrides:
        try:
            settings.set_editor_property("override_" + name, True)
            settings.set_editor_property(name, value)
        except Exception as err:  # noqa: BLE001
            unreal.log_warning("[splat] could not set post-process '%s': %s" % (name, err))


def configure_capture(component, cfg, render_target):
    component.set_editor_property("texture_target", render_target)
    component.set_editor_property("fov_angle", float(cfg["FOV_DEG"]))
    component.set_editor_property("capture_source", unreal.SceneCaptureSource.SCS_FINAL_COLOR_LDR)
    component.set_editor_property("capture_every_frame", False)
    component.set_editor_property("capture_on_movement", False)
    component.set_editor_property("always_persist_rendering_state", True)
    try:
        component.set_editor_property("post_process_blend_weight", 1.0)
        pp = component.get_editor_property("post_process_settings")
        _set_pp(pp, [
            ("auto_exposure_method", unreal.AutoExposureMethod.AEM_MANUAL),
            ("auto_exposure_bias", float(cfg["EXPOSURE_BIAS"])),
            ("motion_blur_amount", 0.0),
            ("vignette_intensity", 0.0),
            ("lens_flare_intensity", 0.0),
            ("bloom_intensity", 0.0),
            ("depth_of_field_fstop", 32.0),
        ])
        component.set_editor_property("post_process_settings", pp)
    except Exception as err:  # noqa: BLE001
        unreal.log_warning("[splat] post-process overrides skipped: %s" % err)


def export(cfg):
    poses = build_poses(cfg)
    unreal.log("[splat] %d poses, output: %s" % (len(poses), cfg["OUTPUT_DIR"]))
    for i, (loc, rot) in enumerate(poses[:5]):
        unreal.log("[splat] pose %04d loc=(%.0f, %.0f, %.0f) rot=(p%.1f y%.1f r%.1f)" % (
            i, loc.x, loc.y, loc.z, rot.pitch, rot.yaw, rot.roll))
    if cfg["DRY_RUN"]:
        unreal.log("[splat] DRY_RUN: nothing rendered")
        return

    images_dir = os.path.join(cfg["OUTPUT_DIR"], "images")
    os.makedirs(images_dir, exist_ok=True)

    world = _editor_world()
    render_target = unreal.RenderingLibrary.create_render_target2d(
        world, int(cfg["WIDTH"]), int(cfg["HEIGHT"]), unreal.TextureRenderTargetFormat.RTF_RGBA8)
    first_loc, first_rot = poses[0]
    actor = _spawn(unreal.SceneCapture2D, first_loc, first_rot)
    actor.set_actor_label("SplatDatasetCapture")
    component = actor.get_editor_property("capture_component2d")
    configure_capture(component, cfg, render_target)

    names = []
    with unreal.ScopedSlowTask(len(poses), "Rendering splat dataset") as task:
        task.make_dialog(True)
        for i, (loc, rot) in enumerate(poses):
            if task.should_cancel():
                unreal.log_warning("[splat] cancelled after %d images" % i)
                break
            name = "%04d.png" % i
            actor.set_actor_location_and_rotation(loc, rot, False, True)
            component.capture_scene()
            unreal.RenderingLibrary.export_render_target(world, render_target, images_dir, name)
            names.append(name)
            task.enter_progress_frame(1, "%d / %d" % (i + 1, len(poses)))

    path = write_transforms(cfg, poses[:len(names)], names)
    unreal.log("[splat] wrote %d images and %s" % (len(names), path))
    if not cfg["KEEP_ACTOR"]:
        _destroy(actor)


if __name__ == "__main__" or True:  # UE runs scripts as __main__; keep it simple
    overrides = {}
    for arg in sys.argv[1:]:
        if "=" in arg:
            k, v = arg.split("=", 1)
            if k in CONFIG:
                overrides[k] = type(CONFIG[k])(v) if not isinstance(CONFIG[k], (tuple, bool)) else v
    cfg = dict(CONFIG)
    cfg.update(overrides)
    export(cfg)
