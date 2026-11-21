"""Shared orthographic camera, lighting and render settings for building sprites."""
import bpy
from mathutils import Vector

CAMERA_TARGET = (0, 0.25, 2.56)
CAMERA_OFFSET = (6, -10, 9)
ORTHOGRAPHIC_SCALE = 12.5
SUN_POSITION = (-3, -4, 7)
SUN_COLOR = (1, 0.86, 0.67)

def light(kind, location, energy, size, color):
    data = bpy.data.lights.new(kind, kind)
    obj = bpy.data.objects.new(kind,data)
    bpy.context.collection.objects.link(obj)
    obj.location = location
    obj.rotation_euler = (Vector((0,0,0.8))-obj.location).to_track_quat("-Z","Y").to_euler()
    data.energy = energy
    data.color = color
    if kind == "AREA":
        data.shape = "DISK"
        data.size = size
    else:
        data.angle = size


def configure_sprite_scene():
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
    light("SUN", SUN_POSITION, 2.2, 0.16, SUN_COLOR)
    light("AREA", (3, -4, 6), 265, 6, (0.76, 0.87, 1))
    scene.world.use_nodes = True
    background = scene.world.node_tree.nodes.get("Background")
    background.inputs[0].default_value = (0.32, 0.40, 0.51, 1)
    background.inputs[1].default_value = 0.43
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 12
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 576
    scene.render.resolution_y = 576
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.view_settings.view_transform = "AgX"
    return scene


def render_sprite(output, scene=None):
    scene = scene if scene is not None else configure_sprite_scene()
    scene.render.filepath = str(output)
    bpy.ops.render.render(write_still=True)
