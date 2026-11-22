"""Render an asset script in an oblique (three-quarter, front-facade) projection.

Run by scripts/oblique/oblique.ts:

    blender --background --factory-startup --python-exit-code 1 --python render_oblique.py -- \
        --scene asset.py --out workdir --config config.json

Projection: the facade plane (X/Z) is drawn undistorted, verticals stay vertical, and every
meter of depth (+Y) moves the image by ``depth = [dx, dy]`` meters to the right and up. This is
an oblique parallel projection, which a Blender camera cannot do by itself, so the finished
scene is sheared (x += dx*y, z += dy*y) and rendered with an orthographic camera looking
straight along +Y. Lights are authored in that final render space (not sheared), so "front-left
above" reads the same on screen for any depth axis; shadows fall on the sheared ground plane.

Outputs in --out (all PNGs share one canvas and one ground anchor):
  <component>.png / <component>.<i>.png     lit color, one per pose for hinged components
  <component>.normal.png (.<i>.normal.png)  camera-space normals, Godot convention (green = up)
  <component>.emission.png (.<i>...)        only glow materials, for night lighting (if any)
  shadow.png                                cast + contact shadow on the ground, alpha only
  render.json                               canvas, anchor, scale, components, markers, footprints
"""
import argparse
import importlib.util
import json
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "buildings"))

import oblique_kit as kit  # noqa: E402
from core.scene_setup import PINNED_BLENDER_VERSION, check_blender_version  # noqa: E402

VIEW_LOOK = "AgX - Medium High Contrast"
WORLD_COLOR = (0.32, 0.40, 0.51)
FILL_COLOR = (0.76, 0.87, 1.0)


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--scene", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--config", required=True)
    return parser.parse_args(argv)


def clear_scene():
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.lights, bpy.data.cameras):
        for item in list(block):
            block.remove(item)


def load_asset(path):
    spec = importlib.util.spec_from_file_location("oblique_asset", path)
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, os.path.dirname(os.path.abspath(path)))
    spec.loader.exec_module(module)
    if not hasattr(module, "build"):
        raise RuntimeError("OBLIQUE_SCENE_INVALID: asset script must define build(kit)")
    return module


def shear_matrix(dx, dy):
    m = Matrix.Identity(4)
    m[0][1] = dx  # x += dx * y
    m[2][1] = dy  # z += dy * y
    return m


def bake_objects():
    """Apply modifiers and transforms so every mesh holds plain world-space vertices."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    meshes = [o for o in bpy.data.objects if o.type in {"MESH", "CURVE", "FONT", "META", "SURFACE"}]
    baked = []
    for obj in meshes:
        evaluated = obj.evaluated_get(depsgraph)
        data = bpy.data.meshes.new_from_object(evaluated, preserve_all_data_layers=True, depsgraph=depsgraph)
        data.transform(obj.matrix_world)
        component = obj.get(kit.COMPONENT_KEY, "body")
        name = obj.name
        bpy.data.objects.remove(obj, do_unlink=True)
        new = bpy.data.objects.new(name, data)
        bpy.context.collection.objects.link(new)
        new[kit.COMPONENT_KEY] = component
        baked.append(new)
    return sorted(baked, key=lambda o: o.name)


def hinge_matrix(spec, angle):
    if not spec or "hinge" not in spec or not angle:
        return Matrix.Identity(4)
    point = Vector(spec["hinge"]["point"])
    axis = Vector(spec["hinge"]["axis"])
    return Matrix.Translation(point) @ Matrix.Rotation(math.radians(angle), 4, axis) @ Matrix.Translation(-point)


class Rig:
    def __init__(self, objects, config, specs):
        self.objects = objects
        self.config = config
        self.specs = specs
        self.dx, self.dy = config["depth"]
        self.shear = shear_matrix(self.dx, self.dy)
        self.originals = {o.name: o.data.copy() for o in objects}
        self.pixel = 1.0 / (config["unitsPerMeter"] * config["pxPerUnit"])
        self.pose = {}
        self.components = sorted({o[kit.COMPONENT_KEY] for o in objects})

    def apply_pose(self, pose):
        """pose: component -> angle. Rebuild each mesh as shear @ hinge(angle) @ original."""
        self.pose = dict(pose)
        for obj in self.objects:
            comp = obj[kit.COMPONENT_KEY]
            matrix = self.shear @ hinge_matrix(self.specs.get(comp), pose.get(comp, 0))
            fresh = self.originals[obj.name].copy()
            fresh.transform(matrix)
            old = obj.data
            obj.data = fresh
            bpy.data.meshes.remove(old)

    def projected(self, point):
        p = self.shear @ Vector((*point, 1.0)) if len(point) == 3 else self.shear @ Vector((point[0], point[1], 0, 1))
        return Vector((p.x, p.z))

    def sun_direction(self):
        """Key light travel direction in render space (x right, y into the image, z up).

        Lights are authored in render space, not sheared, so "front-left above" means the same
        thing on screen whatever the depth axis is.
        """
        return Vector(self.config["sunDirection"]).normalized()

    def extent(self):
        """Projected bounds over every pose, plus the ground hit of every vertex along the sun."""
        if kit._bounds and kit._bounds[0][0] == "canvas":
            _, left, top, right, bottom = kit._bounds[0]
            upm = self.config["unitsPerMeter"]
            return left / upm, right / upm, -bottom / upm, -top / upm
        if kit._bounds:
            (x0, y0, z0), (x1, y1, z1) = kit._bounds
            corners = [self.shear @ Vector((x, y, z)) for x in (x0, x1) for y in (y0, y1) for z in (z0, z1)]
            return min(c.x for c in corners), max(c.x for c in corners), min(c.z for c in corners), max(c.z for c in corners)
        sun = self.sun_direction()
        dy = self.dy
        xs, zs = [], []
        poses = [{}]
        for comp, spec in self.specs.items():
            for angle in spec.get("angles", []):
                poses.append({comp: angle})
        for pose in poses:
            for obj in self.objects:
                comp = obj[kit.COMPONENT_KEY]
                hinge = hinge_matrix(self.specs.get(comp), pose.get(comp, 0))
                for v in self.originals[obj.name].vertices:
                    s = self.shear @ (hinge @ v.co)
                    xs.append(s.x)
                    zs.append(s.z)
                    # Where this vertex's shadow lands on the sheared ground plane z = dy * y.
                    lift = s.z - dy * s.y
                    fall = sun.z - dy * sun.y
                    if lift > 1e-6 and fall < -1e-6:
                        hit = s - sun * (lift / fall)
                        xs.append(hit.x)
                        zs.append(hit.z)
        if not xs:
            raise RuntimeError("OBLIQUE_SCENE_EMPTY: build(kit) created no mesh")
        return min(xs), max(xs), min(zs), max(zs)


def setup_scene(rig):
    scene = bpy.context.scene
    config = rig.config
    pad = config["padding"]
    px = rig.pixel
    x0, x1, z0, z1 = rig.extent()
    left = math.floor(x0 / px) - pad
    right = math.ceil(x1 / px) + pad
    bottom = math.floor(z0 / px) - pad
    top = math.ceil(z1 / px) + pad
    width, height = right - left, top - bottom
    if max(width, height) > config["maxSide"]:
        raise RuntimeError("OBLIQUE_CANVAS_TOO_LARGE: %dx%d px exceeds maxSide %d; lower pxPerUnit or split the asset"
                           % (width, height, config["maxSide"]))

    cam_data = bpy.data.cameras.new("Oblique camera")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = max(width, height) * px
    cam_data.sensor_fit = "AUTO"
    cam_data.clip_start = 0.01
    cam_data.clip_end = 1000
    camera = bpy.data.objects.new("Oblique camera", cam_data)
    bpy.context.collection.objects.link(camera)
    camera.location = ((left + width / 2) * px, -200.0, (bottom + height / 2) * px)
    camera.rotation_euler = (math.pi / 2, 0, 0)
    scene.camera = camera

    sun = bpy.data.objects.new("Key", bpy.data.lights.new("Key", "SUN"))
    bpy.context.collection.objects.link(sun)
    sun.rotation_euler = rig.sun_direction().to_track_quat("-Z", "Y").to_euler()
    sun.data.energy = config["sunEnergy"]
    sun.data.angle = config["sunAngle"]
    sun.data.color = config["sunColor"]
    fill_dir = Vector((-0.6, 0.5, -0.6)).normalized()
    fill = bpy.data.objects.new("Fill", bpy.data.lights.new("Fill", "SUN"))
    bpy.context.collection.objects.link(fill)
    fill.rotation_euler = fill_dir.normalized().to_track_quat("-Z", "Y").to_euler()
    fill.data.energy = config["fillEnergy"]
    fill.data.angle = 0.5
    fill.data.color = FILL_COLOR

    # Shadow catcher: the ground plane (Z = 0 before shearing) under everything.
    size = (width + height) * px * 2
    bpy.ops.mesh.primitive_plane_add(size=1, location=(0, 0, 0))
    ground = bpy.context.object
    ground.name = "Ground catcher"
    ground.scale = (size, size, 1)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    ground.data.transform(rig.shear)
    ground.is_shadow_catcher = True

    scene.world = scene.world or bpy.data.worlds.new("World")
    scene.world.use_nodes = True
    background = scene.world.node_tree.nodes.get("Background")
    background.inputs[0].default_value = (*WORLD_COLOR, 1)
    background.inputs[1].default_value = config["worldStrength"]

    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.seed = 0
    scene.cycles.use_animated_seed = False
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"
    for flag in dir(scene.render):
        if flag.startswith("use_stamp"):
            try:
                setattr(scene.render, flag, False)
            except (AttributeError, TypeError):
                pass
    return {"width": width, "height": height, "left": left, "top": top, "ground": ground, "sun": sun, "fill": fill}


def set_color_mode(scene, samples, denoise, view):
    scene.cycles.samples = samples
    scene.cycles.use_denoising = denoise
    if denoise:
        scene.cycles.denoiser = "OPENIMAGEDENOISE"
        if hasattr(scene.cycles, "denoising_use_gpu"):
            scene.cycles.denoising_use_gpu = False
    scene.view_settings.view_transform = view
    scene.view_settings.look = VIEW_LOOK if view == "AgX" else "None"


def render(scene, path):
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def emission_material(name, color, strength):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    emit = nodes.new("ShaderNodeEmission")
    emit.inputs["Color"].default_value = (*color, 1)
    emit.inputs["Strength"].default_value = strength
    links.new(emit.outputs[0], out.inputs["Surface"])
    return mat


def holdout_material():
    mat = bpy.data.materials.new("Oblique holdout")
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    hold = nodes.new("ShaderNodeHoldout")
    links.new(hold.outputs[0], out.inputs["Surface"])
    return mat


def normal_material():
    """Camera-space normal as color: x right, y up, z toward the camera, mapped to 0..1."""
    mat = bpy.data.materials.new("Oblique normal")
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    geo = nodes.new("ShaderNodeNewGeometry")
    xf = nodes.new("ShaderNodeVectorTransform")
    xf.vector_type = "NORMAL"
    xf.convert_from = "WORLD"
    xf.convert_to = "CAMERA"
    # Cycles camera space points +Z into the scene, so flip Z: a camera-facing normal becomes +Z.
    scale = nodes.new("ShaderNodeVectorMath")
    scale.operation = "MULTIPLY_ADD"
    scale.inputs[1].default_value = (0.5, 0.5, -0.5)
    scale.inputs[2].default_value = (0.5, 0.5, 0.5)
    emit = nodes.new("ShaderNodeEmission")
    emit.inputs["Strength"].default_value = 1.0
    links.new(geo.outputs["Normal"], xf.inputs["Vector"])
    links.new(xf.outputs["Vector"], scale.inputs[0])
    links.new(scale.outputs["Vector"], emit.inputs["Color"])
    links.new(emit.outputs[0], out.inputs["Surface"])
    return mat


ANIMATED = set()


def isolate(rig, comp):
    """Render only ``comp``'s visible pixels.

    Other static components become holdouts: they still occlude (a wall in front of a roof cuts
    the roof layer) and cast shadows, but leave transparent pixels, so each layer holds exactly
    what is visible of it and layers composite in any order. Hinged components (doors) are
    hidden instead, both from the camera and from shadows: a holdout door would punch a hole in
    the wall behind it, and its closed shadow would freeze on the wall it swings away from.
    """
    for obj in rig.objects:
        other = obj[kit.COMPONENT_KEY]
        # Animated components are hidden like hinged ones: a holdout copy of one frame's water would
        # punch that frame's shape into the static rock for every other frame.
        hinged = "hinge" in rig.specs.get(other, {}) or other in ANIMATED
        obj.is_holdout = other != comp and not hinged
        obj.visible_camera = other == comp or not hinged
        obj.visible_shadow = other == comp or not hinged


def glow_of(mat):
    if mat is None or kit.GLOW_KEY not in mat:
        return None
    return tuple(mat[kit.GLOW_KEY])


def main():
    args = parse_args()
    check_blender_version()
    config = json.load(open(args.config))
    os.makedirs(args.out, exist_ok=True)
    clear_scene()
    kit.reset()
    kit.frame = 0
    module = load_asset(args.scene)
    frame_count = int(getattr(module, "FRAMES", 1))
    ANIMATED.clear()
    ANIMATED.update(getattr(module, "ANIMATED", ()) if frame_count > 1 else ())
    module.build(kit)
    if ANIMATED and not kit._bounds:
        raise RuntimeError("OBLIQUE_SCENE_INVALID: animated assets must call kit.canvas() or kit.bounds() so frames share one canvas")
    meta = kit.metadata()
    objects = bake_objects()
    for comp in {o[kit.COMPONENT_KEY] for o in objects}:
        meta["components"].setdefault(comp, {"name": comp, "sort_offset": 0})
    specs = meta["components"]
    for name, spec in specs.items():
        if not any(o[kit.COMPONENT_KEY] == name for o in objects):
            raise RuntimeError("OBLIQUE_SCENE_INVALID: component %r has no geometry" % name)
    rig = Rig(objects, config, specs)
    rig.apply_pose({})
    scene = bpy.context.scene
    canvas = setup_scene(rig)
    ground, upm = canvas["ground"], config["unitsPerMeter"]

    passes = set(config["passes"])
    holdout = holdout_material()
    normal_mat = normal_material()
    results = {}
    for comp in rig.components:
        spec = specs[comp]
        angles = spec.get("angles") or [None]
        frames = []
        glow_used = any(glow_of(s.material) for o in objects if o[kit.COMPONENT_KEY] == comp for s in o.material_slots)
        for index, angle in enumerate(angles):
            rig.apply_pose({comp: angle or 0})
            isolate(rig, comp)
            # The catcher exists only for the shadow pass; elsewhere it must not occlude light either,
            # or ground geometry dipping below Z = 0 (furrows, hollows) renders in its shadow.
            ground.hide_render = True
            stem = comp if angle is None else "%s.%d" % (comp, index)
            if comp in ANIMATED:
                stem = "%s.f%02d" % (comp, 0)
            frame = {"angle": angle, "color": stem + ".png"}
            if comp in ANIMATED:
                frame["frame"] = 0
            # Lit color.
            set_color_mode(scene, config["samples"], config.get("denoise", True), "AgX")
            render(scene, os.path.join(args.out, frame["color"]))
            # Normals.
            if "normal" in passes:
                bpy.context.view_layer.material_override = normal_mat
                set_color_mode(scene, config["normalSamples"], False, "Raw")
                frame["normal"] = stem + ".normal.png"
                render(scene, os.path.join(args.out, frame["normal"]))
                bpy.context.view_layer.material_override = None
            # Emission: glow materials only, everything else holds out (occludes, transparent).
            if "emission" in passes and glow_used:
                saved = []
                frame_glow = 0.0
                for obj in objects:
                    if obj[kit.COMPONENT_KEY] != comp:
                        continue
                    for slot in obj.material_slots:
                        saved.append((slot, slot.material))
                        glow = glow_of(slot.material)
                        slot.material = emission_material("Glow", glow[:3], 1.0) if glow else holdout
                        if glow:
                            frame_glow = max(frame_glow, glow[3])
                energies = (canvas["sun"].data.energy, canvas["fill"].data.energy)
                canvas["sun"].data.energy = canvas["fill"].data.energy = 0
                strength = scene.world.node_tree.nodes["Background"].inputs[1].default_value
                scene.world.node_tree.nodes["Background"].inputs[1].default_value = 0
                set_color_mode(scene, config["emissionSamples"], False, "Standard")
                frame["emission"] = stem + ".emission.png"
                # The PNG holds the glow color at strength 1; the game scales it by this intensity.
                frame["emissionStrength"] = frame_glow
                render(scene, os.path.join(args.out, frame["emission"]))
                scene.world.node_tree.nodes["Background"].inputs[1].default_value = strength
                canvas["sun"].data.energy, canvas["fill"].data.energy = energies
                for slot, mat in saved:
                    slot.material = mat
            frames.append(frame)
        results[comp] = {
            "frames": frames,
            "sortOffset": spec.get("sort_offset", 0),
            **({"hinge": {"point": world_units(rig, spec["hinge"]["point"], upm), "axis": spec["hinge"]["axis"]}} if "hinge" in spec else {}),
        }
    rig.apply_pose({})

    if "shadow" in passes:
        for obj in objects:
            obj.is_holdout = False
            obj.visible_camera = False
            obj.visible_shadow = True
        ground.hide_render = False
        ground.visible_camera = True
        set_color_mode(scene, config["samples"], config.get("denoise", True), "Standard")
        render(scene, os.path.join(args.out, "shadow.png"))

    # Remaining frames of animated components: rebuild the scene for each frame and render only the
    # animated parts (static parts hold out), on the same fixed canvas.
    for index in range(1, frame_count):
        clear_scene()
        kit.reset()
        kit.frame = index
        module.build(kit)
        frame_objects = bake_objects()
        frame_rig = Rig(frame_objects, config, specs)
        frame_rig.apply_pose({})
        frame_canvas = setup_scene(frame_rig)
        if [frame_canvas[k] for k in ("width", "height", "left", "top")] != [canvas[k] for k in ("width", "height", "left", "top")]:
            raise RuntimeError("OBLIQUE_SCENE_INVALID: frame %d changed the canvas" % index)
        frame_ground = frame_canvas["ground"]
        frame_normal = normal_material()
        for comp in sorted(ANIMATED):
            isolate(frame_rig, comp)
            frame_ground.hide_render = True
            stem = "%s.f%02d" % (comp, index)
            entry = {"angle": None, "frame": index, "color": stem + ".png"}
            set_color_mode(scene, config["samples"], config.get("denoise", True), "AgX")
            render(scene, os.path.join(args.out, entry["color"]))
            if "normal" in passes:
                bpy.context.view_layer.material_override = frame_normal
                set_color_mode(scene, config["normalSamples"], False, "Raw")
                entry["normal"] = stem + ".normal.png"
                render(scene, os.path.join(args.out, entry["normal"]))
                bpy.context.view_layer.material_override = None
            results[comp]["frames"].append(entry)

    report = {
        "blenderVersion": bpy.app.version_string,
        "pinnedBlender": "%d.%d" % PINNED_BLENDER_VERSION,
        "width": canvas["width"],
        "height": canvas["height"],
        # Pixel position of the ground pivot (world origin) in every PNG.
        "anchor": [-canvas["left"], canvas["top"]],
        "pixelsPerUnit": config["pxPerUnit"],
        "unitsPerMeter": upm,
        "depth": config["depth"],
        "components": results,
        "markers": {k: world_units(rig, v, upm) for k, v in sorted(meta["markers"].items())},
        "footprints": {k: [world_units(rig, (p[0], p[1], 0), upm) for p in pts] for k, pts in sorted(meta["footprints"].items())},
        "shadow": "shadow.png" if "shadow" in passes else None,
    }
    json.dump(report, open(os.path.join(args.out, "render.json"), "w"), indent=2, sort_keys=True)


def world_units(rig, point, upm):
    """Projected point in game world units relative to the ground pivot (x right, y down)."""
    p = rig.projected(point)
    return [round(p.x * upm, 3), round(-p.y * upm, 3)]


if __name__ == "__main__":
    main()
