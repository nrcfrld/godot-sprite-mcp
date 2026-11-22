"""Validate and render a modular building. Run with Blender; arguments follow --."""
import argparse
from dataclasses import asdict, dataclass
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

from blender_render import bpy, box
from church import belfry, carved_stone, nave, roof_cross, stairs
from core.constants import GLOBAL_DOOR_HEIGHT, GLOBAL_PLINTH_HEIGHT, LPC_REFERENCE_HEIGHT_METERS, METERS_PER_UNIT
from core.scene_setup import ORTHOGRAPHIC_SCALE, configure_sprite_scene, render_sprite
from footprints import Footprint, project_geometry
from house import house
from inn import BAR_X, BAR_WIDTH, entry_steps, inn, taproom_kegs
from inn_interior import DECK, floor_plan, interior_footprints
from layout import (
    AABB, EPSILON, Point, Volume, attach_stairs, attach_to_side, attach_tower, building_sockets,
    first_intersection, ground_pivot, reject_blocked_clearances, reject_intersections, reject_unsupported,
    roof_apex_socket,
)
from shop import DOOR_WIDTH, STALL_X, chimney, light_shopfront, market_shop, produce_stand, shop_steps
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view


def layout_point(point):
    # Blender is Z-up. The layout and its exported socket metadata are Y-up.
    return Point(point.x, point.z, point.y)


def blender_point(point):
    return Vector((point.x, point.z, point.y))


def bounds(objects):
    graph = bpy.context.evaluated_depsgraph_get()
    points = []
    for obj in objects:
        evaluated = obj.evaluated_get(graph)
        points.extend(layout_point(evaluated.matrix_world @ Vector(p)) for p in evaluated.bound_box)
    return AABB.enclosing(points)


def volumes(objects):
    return tuple(Volume(obj.name, bounds((obj,))) for obj in objects)


def apex_bounds(roof):
    # Use the topmost piece's footprint. An asymmetric overhang shifts the
    # center of the entire roof away from the ridge.
    return max((bounds((obj,)) for obj in roof), key=lambda a: a.high.y)


@dataclass
class Module:
    root: object
    objects: tuple
    foundation: object
    wall: object
    roof: tuple
    portal: object

    def place(self, socket):
        self.root.location = blender_point(socket)
        bpy.context.view_layer.update()


def reset_module_pivot(module, reference):
    pivot = ground_pivot(bounds(reference))
    for obj in module.objects:
        obj.parent = module.root
        obj.location -= blender_point(pivot)
    bpy.context.view_layer.update()


def snap_to_ground(module):
    reset_module_pivot(module, (module.foundation,))
    if abs(bounds((module.foundation,)).low.y) > EPSILON or bounds(module.objects).low.y < -EPSILON:
        raise ValueError(f"{module.root.name} geometry must sit on its normalized foundation at Blender Z=0")
    reject_unsupported(module.root.name, volumes(module.objects))


def capture(name, factory, grounded=True):
    old_objects = set(bpy.context.scene.objects)
    foundation, wall, roof, portal = factory() or (None, None, (), None)
    objects = tuple(sorted(set(bpy.context.scene.objects) - old_objects, key=lambda o: o.name))
    root = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(root)
    bpy.context.view_layer.update()
    module = Module(root, objects, foundation, wall, tuple(roof), portal)
    if grounded:
        snap_to_ground(module)
    else:
        reset_module_pivot(module, objects)
    return module


def place_grounded_front(name, factory, facade_x, main_volumes):
    module = capture(name, factory)
    origin = attach_stairs(bounds(module.objects), facade_x, main_volumes)
    module.place(origin)
    return module, origin


def place_entry(main, main_volumes, factory):
    portal = bounds((main.portal,))
    return place_grounded_front("Entry stair", factory, portal.center.x, main_volumes)


def church_layout(side):
    main = capture("Main building", lambda: nave(side))
    main_wall = bounds((main.wall,))
    sockets = building_sockets(main_wall, apex_bounds(main.roof))
    main_volumes = volumes(main.objects)

    entry, stair_socket = place_entry(main, main_volumes, stairs)
    portal = bounds((main.portal,))
    door_clearance = AABB(
        Point(portal.low.x - 0.12, portal.low.y, portal.low.z - 1.10),
        Point(portal.high.x + 0.12, portal.high.y, portal.low.z),
    )
    groups = [("main", main_volumes), ("stairs", volumes(entry.objects))]
    feet = [("building", main.foundation), ("entry_steps", entry.foundation)]

    active_roof = main.roof
    cross_surface = "main"
    tower_origin = None
    connection = None
    if side != "none":
        tower = capture("Bell tower", belfry)
        tower_origin, connection = attach_tower(
            side, sockets[f"{side}_wing_socket"], main_wall, main_volumes,
            bounds((tower.wall,)), volumes(tower.objects),
        )
        tower.place(tower_origin)
        feet.append(("tower", tower.foundation))
        connection_mesh = box("Masonry wall connection", blender_point(connection.center), blender_point(connection.size), carved_stone, 0)
        bpy.context.view_layer.update()
        # The connector bridges wall and tower above ground, so instead of snapping it to Z=0
        # it must touch both: a contact chain from the ground through the nave or the tower.
        reject_unsupported("wall connection", (*main_volumes, *volumes(tower.objects), *volumes((connection_mesh,))))
        additions = [("tower", volumes(tower.objects)), ("wall connection", volumes((connection_mesh,)))]
        for group, shapes in additions:
            for shape in shapes:
                if shape.bounds.intersects(door_clearance):
                    raise ValueError(f"{group}/{shape.name} blocks the entrance")
        groups.extend(additions)
        active_roof = tower.roof
        cross_surface = "tower"

    # Ornament conflict exclusion: try each roof apex (the tower first), relocate the cross to
    # the first one that is clear, and disable it only when every apex is blocked.
    ornament = capture("Roof cross", roof_cross, grounded=False)
    blockers = [(group, volume) for group, shapes in groups for volume in shapes]
    candidates = [(cross_surface, roof_apex_socket(apex_bounds(active_roof)))]
    if cross_surface != "main":
        candidates.append(("main", roof_apex_socket(apex_bounds(main.roof))))
    cross_socket = None
    for surface, socket in candidates:
        ornament.place(socket)
        ornament_volumes = volumes(ornament.objects)
        if not first_intersection(ornament_volumes, blockers):
            cross_surface, cross_socket = surface, socket
            groups.append(("roof cross", ornament_volumes))
            break
    if cross_socket is None:
        for item in (*ornament.objects, ornament.root):
            bpy.data.objects.remove(item, do_unlink=True)
        cross_surface = None

    # Geometry has its final world transforms. All overlaps across models must
    # be resolved before the renderer or exporter is invoked.
    reject_intersections(groups)
    return {
        "upAxis": "Y",
        "sockets": {name: asdict(socket) for name, socket in sockets.items()},
        "entrance_socket": asdict(stair_socket),
        "doorClearance": asdict(door_clearance),
        "towerSide": side,
        "towerOrigin": asdict(tower_origin) if tower_origin is not None else None,
        "wallConnection": asdict(connection) if connection is not None else None,
        "crossOn": cross_surface,
        "crossSocket": asdict(cross_socket) if cross_socket is not None else None,
        "doorHeightWorldUnits": bounds((main.portal,)).size.y,
    }, feet


def inn_layout():
    main = capture("Inn and bar", inn)
    main_volumes = volumes(main.objects)
    entry, stair_socket = place_entry(main, main_volumes, entry_steps)
    kegs, keg_origin = place_grounded_front("Bar kegs", taproom_kegs, BAR_X - BAR_WIDTH * 0.39, main_volumes)
    reject_intersections([("main", main_volumes), ("stairs", volumes(entry.objects)), ("kegs", volumes(kegs.objects))])
    sockets = building_sockets(bounds((main.wall,)), apex_bounds(main.roof))
    return {
        "upAxis": "Y",
        "building": "inn",
        "floors": ["bar", "guest_rooms"],
        "sockets": {name: asdict(socket) for name, socket in sockets.items()},
        "entrance_socket": asdict(stair_socket),
        "taproom_kegs": asdict(keg_origin),
        "doorHeightWorldUnits": bounds((main.portal,)).size.y,
    }, [("building", main.foundation), ("entry_steps", entry.foundation), ("kegs", kegs.foundation)]


def house_layout():
    main = capture("Village house", house)
    entry, stair_socket = place_entry(main, volumes(main.objects), entry_steps)
    reject_intersections([("main", volumes(main.objects)), ("stairs", volumes(entry.objects))])
    return {
        "upAxis": "Y", "building": "house",
        "entrance_socket": asdict(stair_socket),
        "doorHeightWorldUnits": bounds((main.portal,)).size.y,
    }, [("building", main.foundation), ("entry_steps", entry.foundation)]


def shop_layout():
    main = capture("Village produce shop", market_shop)
    main_volumes = volumes(main.objects)
    wall = bounds((main.wall,))
    entry, stair_socket = place_entry(main, main_volumes, shop_steps)
    groups = [("main", main_volumes), ("stairs", volumes(entry.objects))]
    feet = [("building", main.foundation), ("entry_steps", entry.foundation)]
    # The cross-gable caps share a height. Use the front cap as the authored socket.
    apex = next(obj for obj in main.roof if obj.name == "Gable glazed ridge roll")
    sockets = building_sockets(wall, bounds((apex,)))

    for side, x, produce in zip(("left", "right"), STALL_X, ((0, 1, 2), (3, 4, 5))):
        name = f"produce_{side}"
        stand, origin = place_grounded_front(name, lambda: produce_stand(produce), x, main_volumes)
        groups.append((name, volumes(stand.objects)))
        feet.append((name, stand.foundation))
        sockets[f"{name}_socket"] = origin

    stack = capture("Chimney", chimney)
    flashing = bounds(tuple(obj for obj in main.roof if obj.name == "Chimney roof flashing"))
    socket = Point(flashing.center.x, flashing.high.y, flashing.low.z)
    stack.place(attach_to_side(bounds(stack.objects), socket, "back") + Point(0, socket.y, 0))
    stack_volumes = volumes(stack.objects)
    groups.append(("chimney", stack_volumes))
    reject_intersections(groups)
    reject_unsupported("Shop chimney", (*main_volumes, *stack_volumes))

    door = AABB(Point(-DOOR_WIDTH/2+0.06, GLOBAL_PLINTH_HEIGHT, stair_socket.z-0.6),
                Point(DOOR_WIDTH/2-0.06, GLOBAL_PLINTH_HEIGHT+GLOBAL_DOOR_HEIGHT, wall.low.z))
    reject_blocked_clearances(groups, (Volume("shop entrance", door),))
    sockets["chimney_socket"] = socket
    return {
        "upAxis": "Y", "building": "shop",
        "sockets": {name: asdict(point) for name, point in sockets.items()},
        "entrance_socket": asdict(stair_socket),
        "doorClearance": asdict(door),
        "doorHeightWorldUnits": GLOBAL_DOOR_HEIGHT,
    }, feet


def keg_layout():
    module = capture("Village kegs", taproom_kegs)
    return {
        "upAxis": "Y", "building": "kegs",
        "heightWorldUnits": bounds(module.objects).size.y,
    }, [("kegs", module.foundation)]


def inn_interior_layout(level):
    plan = floor_plan(level)
    shell = capture("Floor cutaway", plan.shell)
    static = list(shell.objects)
    layers = []
    groups = [("shell", volumes(shell.objects))]
    floor, blockers = interior_footprints(level)
    boundaries = [obj for obj in shell.objects if obj.name.startswith((
        "Rear cutaway wall", "Left cutaway wall", "Stairwell rail", "Stairwell front cap",
    ))]
    blockers.extend(
        (f"shell_boundary_{index}", Footprint.from_bounds(bounds((obj,))))
        for index, obj in enumerate(boundaries, 1)
    )
    feet = []
    for fixture in plan.fixtures:
        module = capture(fixture.name, fixture.build)
        origin = Point(fixture.x, DECK, fixture.depth)
        module.place(origin)
        contact = Footprint.from_bounds(bounds((module.foundation,)))
        if not (floor.contains(contact.left, contact.front) and floor.contains(contact.right, contact.back)):
            raise ValueError(f"{fixture.name} has a footprint outside the Inn floor")
        groups.append((fixture.name, volumes(module.objects)))
        if fixture.layer == "shell":
            static.extend(module.objects)
            feet.append((fixture.name, module.foundation))
            feet.extend(
                (f"{fixture.name}_post_{index}", mesh)
                for index, mesh in enumerate((m for m in module.objects if m.name.startswith("Landing support")), 1)
            )
        else:
            layers.append((fixture, module, origin))
            if fixture.layer == "ysort":
                feet.append((fixture.name, module.foundation))
    reject_intersections(groups)
    reject_blocked_clearances(groups, plan.clearances)
    metadata = {
        "upAxis": "Y",
        "building": "inn",
        "interior": level,
        "floorElevation": plan.elevation,
        "markers": {name: asdict(marker) for name, marker in plan.markers.items()},
    }
    blockers.extend(footprints_for(feet))
    return plan, static, layers, metadata, floor, blockers


def footprints_for(feet):
    return [(name, Footprint.from_bounds(bounds((mesh,)))) for name, mesh in feet]


def add_lantern_lights(positions):
    for x, depth, height in positions:
        light = bpy.data.lights.new("Inn candlelight", "POINT")
        light.color = (1.0, 0.63, 0.31)
        light.energy = 34.0
        light.shadow_soft_size = 0.40
        lamp = bpy.data.objects.new("Inn candlelight", light)
        bpy.context.collection.objects.link(lamp)
        lamp.location = (x, depth-0.23, height-0.08)


def projected(scene, point):
    return world_to_camera_view(scene, scene.camera, blender_point(point))


def sprite_point(scene, point):
    uv = projected(scene, point)
    return [round(uv.x * scene.render.resolution_x, 4),
            round((1-uv.y) * scene.render.resolution_y, 4)]


def scale_report(scene, height, metadata):
    origin = Point(0, height, 0)
    feet = sprite_point(scene, origin)
    above = sprite_point(scene, origin + Point(0, 1, 0))
    vertical_pixels = round((feet[1]-above[1])/METERS_PER_UNIT, 4)
    scale = {
        "version": 1,
        "metersPerWorldUnit": METERS_PER_UNIT,
        "orthographicPixelsPerMeter": scene.render.resolution_x / ORTHOGRAPHIC_SCALE / METERS_PER_UNIT,
        "verticalPixelsPerMeter": vertical_pixels,
        "groundPivot": feet,
        "referenceActorHeightMeters": LPC_REFERENCE_HEIGHT_METERS,
    }
    if "doorHeightWorldUnits" in metadata:
        meters = round(metadata["doorHeightWorldUnits"] * METERS_PER_UNIT, 5)
        scale["doorHeightMeters"] = meters
        scale["doorHeightPixels"] = round(vertical_pixels * meters, 4)
    return scale


def export_glb(path):
    # Export the validated 3D assembly, without the sprite camera or lights.
    bpy.ops.object.select_all(action="DESELECT")
    for obj in bpy.context.scene.objects:
        if obj.type in {"MESH", "EMPTY"}:
            obj.select_set(True)
    status = bpy.ops.export_scene.gltf(
        filepath=str(path), export_format="GLB", use_selection=True,
        export_cameras=False, export_lights=False, export_animations=False, export_yup=True,
    )
    if "FINISHED" not in status:
        raise RuntimeError("Blender did not write the GLB")


def set_render_region(scene, objects):
    # Retain the original frame and projection. Render only the region that
    # can contain this fixture, with padding for the denoiser at its edges.
    aabb = bounds(objects)
    corners = [
        projected(scene, Point(x, y, z))
        for x in (aabb.low.x, aabb.high.x)
        for y in (aabb.low.y, aabb.high.y)
        for z in (aabb.low.z, aabb.high.z)
    ]
    pad_x = 12 / scene.render.resolution_x
    pad_y = 12 / scene.render.resolution_y
    scene.render.use_border = True
    scene.render.use_crop_to_border = False
    scene.render.border_min_x = max(0, min(p.x for p in corners) - pad_x)
    scene.render.border_max_x = min(1, max(p.x for p in corners) + pad_x)
    scene.render.border_min_y = max(0, min(p.y for p in corners) - pad_y)
    scene.render.border_max_y = min(1, max(p.y for p in corners) + pad_y)


def render_interior(assembly, output):
    plan, shell, fixtures, metadata, floor, blockers = assembly
    scene = configure_sprite_scene()
    add_lantern_lights(plan.lanterns)
    bpy.context.view_layer.update()
    metadata["screenMarkers"] = {name: sprite_point(scene, p) for name, p in plan.markers.items()}
    metadata["geometry"] = project_geometry(blockers, DECK, lambda p: sprite_point(scene, p), floor)
    metadata["scale"] = scale_report(scene, DECK, metadata)
    render_sprite(output, scene)
    directory = output.parent / "layers"
    directory.mkdir(parents=True, exist_ok=True)

    # Shell is independent of movable furniture. When rendering each fixture,
    # retain the shell for indirect lighting while hiding it from the camera.
    for _, module, _ in fixtures:
        for mesh in module.objects:
            mesh.hide_render = True
    render_sprite(directory / "shell.png", scene)
    entries = [{"id": "shell", "layer": "shell", "anchor": [0, 0]}]
    for mesh in shell:
        mesh.visible_camera = False
    for fixture, module, origin in fixtures:
        for mesh in module.objects:
            mesh.hide_render = False
        set_render_region(scene, module.objects)
        render_sprite(directory / f"{fixture.name}.png", scene)
        for mesh in module.objects:
            mesh.hide_render = True
        entries.append({"id": fixture.name, "layer": fixture.layer, "anchor": sprite_point(scene, origin)})
    metadata["layers"] = entries
    return metadata


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--building", choices=("church", "inn", "house", "shop", "kegs"), default="church")
    parser.add_argument("--interior", choices=("ground", "upper"))
    parser.add_argument("--tower", choices=("left", "right", "none"), default="left")
    parser.add_argument("--output", type=Path, required=True, help="Destination for the assembled PNG")
    parser.add_argument("--glb", type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    if args.interior and args.building != "inn":
        parser.error("--interior applies to the inn template")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    layouts = {
        "church": lambda: church_layout(args.tower), "inn": inn_layout,
        "house": house_layout, "shop": shop_layout, "kegs": keg_layout,
    }
    try:
        assembly = inn_interior_layout(args.interior) if args.interior else layouts[args.building]()
    except ValueError as error:
        parser.exit(2, f"BUILDING_LAYOUT_REJECTED: {error}\n")
    if args.glb:
        export_glb(args.glb)
    if args.interior:
        metadata = render_interior(assembly, args.output)
    else:
        metadata, feet = assembly
        scene = configure_sprite_scene()
        if args.building == "shop":
            light_shopfront()
        bpy.context.view_layer.update()
        metadata["geometry"] = project_geometry(footprints_for(feet), 0, lambda p: sprite_point(scene, p))
        metadata["scale"] = scale_report(scene, 0, metadata)
        render_sprite(args.output, scene)
    args.output.with_suffix(".layout.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
