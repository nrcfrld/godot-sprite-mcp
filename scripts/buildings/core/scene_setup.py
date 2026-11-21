"""Shared orthographic camera, lighting and render settings for building sprites."""
import os

import bpy
from mathutils import Vector

# Cycles sampling and the OIDN denoiser can change pixels between Blender releases, so
# renders are only reproducible on this pinned major.minor. Set
# GODOT_SPRITE_ALLOW_ANY_BLENDER=1 to render anyway (output may differ from the reference).
PINNED_BLENDER_VERSION = (5, 2)

CAMERA_TARGET = (0, 0.25, 2.56)
CAMERA_OFFSET = (6, -10, 9)
ORTHOGRAPHIC_SCALE = 12.5
SUN_POSITION = (-3, -4, 7)
SUN_COLOR = (1, 0.86, 0.67)

# Render-quality settings (see "Render Quality" in AGENTS.md; checked by tests/render-quality.test.ts).
# A strong, crisp key with a weak fill and moderate contrast gives readable form and texture;
# a big soft fill, bright world and heavy denoising at low samples is what made renders look like clay.
SUN_ENERGY = 3.0
SUN_ANGLE = 0.06          # radians; small = crisp cast shadows
FILL_ENERGY = 130         # cool area fill, kept well below the key
WORLD_STRENGTH = 0.30     # ambient sky light
RENDER_SAMPLES = 48       # enough that the denoiser keeps surface detail
VIEW_LOOK = "AgX - Medium High Contrast"

SHADOW_TARGET = (0, 0, 0.8)


def light(kind, location, energy, size, color):
    data = bpy.data.lights.new(kind, kind)
    obj = bpy.data.objects.new(kind,data)
    bpy.context.collection.objects.link(obj)
    obj.location = location
    obj.rotation_euler = (Vector(SHADOW_TARGET)-obj.location).to_track_quat("-Z","Y").to_euler()
    data.energy = energy
    data.color = color
    return obj
    if kind == "AREA":
        data.shape = "DISK"
        data.size = size
    else:
        data.angle = size


def check_blender_version():
    found = tuple(bpy.app.version[:2])
    if found != PINNED_BLENDER_VERSION and os.environ.get("GODOT_SPRITE_ALLOW_ANY_BLENDER") != "1":
        raise RuntimeError(
            "BLENDER_VERSION_MISMATCH: renders are pinned to Blender %d.%d for pixel-identical output, found %s. "
            "Install Blender %d.%d or set GODOT_SPRITE_ALLOW_ANY_BLENDER=1."
            % (*PINNED_BLENDER_VERSION, bpy.app.version_string, *PINNED_BLENDER_VERSION)
        )


def configure_sprite_scene():
    check_blender_version()
    scene = bpy.context.scene
    camera_data = bpy.data.cameras.new("Sprite camera")
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = ORTHOGRAPHIC_SCALE
    camera = bpy.data.objects.new("Sprite camera", camera_data)
    bpy.context.collection.objects.link(camera)
    center = Vector(CAMERA_TARGET)
    camera.location = center + Vector(CAMERA_OFFSET)
    camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
    scene.camera = camera
    light("SUN", SUN_POSITION, SUN_ENERGY, SUN_ANGLE, SUN_COLOR)
    light("AREA", (3, -4, 6), FILL_ENERGY, 6, (0.76, 0.87, 1))
    scene.world.use_nodes = True
    background = scene.world.node_tree.nodes.get("Background")
    background.inputs[0].default_value = (0.32, 0.40, 0.51, 1)
    background.inputs[1].default_value = WORLD_STRENGTH
    scene.render.engine = "CYCLES"
    # Fixed sampling: CPU device, constant seed, CPU denoiser (GPU results vary by hardware).
    scene.cycles.device = "CPU"
    scene.cycles.seed = 0
    scene.cycles.use_animated_seed = False
    scene.cycles.samples = RENDER_SAMPLES
    scene.cycles.use_denoising = True
    scene.cycles.denoiser = "OPENIMAGEDENOISE"
    if hasattr(scene.cycles, "denoising_use_gpu"):
        scene.cycles.denoising_use_gpu = False
    # No date/time/render-time metadata in written PNGs.
    for flag in ("use_stamp", "use_stamp_date", "use_stamp_time", "use_stamp_render_time", "use_stamp_frame",
                 "use_stamp_frame_range", "use_stamp_memory", "use_stamp_hostname", "use_stamp_camera",
                 "use_stamp_lens", "use_stamp_scene", "use_stamp_filename", "use_stamp_marker",
                 "use_stamp_sequencer_strip", "use_stamp_note"):
        if hasattr(scene.render, flag):
            setattr(scene.render, flag, False)
    scene.render.resolution_x = 576
    scene.render.resolution_y = 576
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = VIEW_LOOK
    return scene


def render_sprite(output, scene=None):
    scene = scene if scene is not None else configure_sprite_scene()
    scene.render.filepath = str(output)
    bpy.ops.render.render(write_still=True)
