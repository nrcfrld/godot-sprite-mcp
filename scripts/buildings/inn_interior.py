"""Cutaway meshes and room plans for the two Inn floors."""
import math
from dataclasses import dataclass
from functools import partial

from blender_render import beam, box, bpy, rng
from core.constants import GLOBAL_PLINTH_HEIGHT, INN_DEPTH, INN_GUEST_FLOOR_HEIGHT, INN_TAPROOM_HEIGHT, INN_WIDTH
from core.painted_materials import FLOORBOARD, PIGMENT, PLASTER, POST, TEXTILE, TIMBER, painted_material
from footprints import Footprint
from inn import BAR_WIDTH, BAR_X, ENTRY_WIDTH, ENTRY_X
from layout import AABB, Point, Volume

HALF_WIDTH = INN_WIDTH / 2
HALF_DEPTH = INN_DEPTH / 2
DECK = GLOBAL_PLINTH_HEIGHT
WALL = 0.16
STAIR_X = HALF_WIDTH - 0.94
STAIR_WIDTH = 1.10
STAIR_FRONT = -1.34
STAIR_BACK = HALF_DEPTH - 0.91
STAIR_STEPS = 16
STAIR_TREAD = (STAIR_BACK - STAIR_FRONT) / STAIR_STEPS
STAIR_RISE = INN_TAPROOM_HEIGHT / STAIR_STEPS
WELL_LEFT = STAIR_X - 0.62
WELL_RIGHT = STAIR_X + 0.62
ROOM_DIVIDER_X = -0.40
ROOM_DOORS = (-1.42, 1.43)
ROOM_DOOR_WIDTH = 0.83
BAR_WALL_HEIGHT = INN_TAPROOM_HEIGHT * 0.61
GUEST_WALL_HEIGHT = INN_GUEST_FLOOR_HEIGHT * 0.64

planks = [
    painted_material(f"Brushed oak {index}", color, FLOORBOARD)
    for index, color in enumerate(((0.40, 0.237, 0.11), (0.52, 0.31, 0.148), (0.465, 0.283, 0.139), (0.36, 0.214, 0.102)))
]
cedar = painted_material("Brushed cedar", (0.43, 0.22, 0.093), TIMBER)
darkwood = painted_material("Dark stained timber", (0.22, 0.10, 0.045), TIMBER)
posts = painted_material("Vertical timber grain", (0.38, 0.177, 0.078), POST)
plaster = painted_material("Mottled limewash", (0.77, 0.66, 0.46), PLASTER)
pine = painted_material("Blue-green painted wood", (0.095, 0.25, 0.23), PIGMENT)
amber = painted_material("Warm trunk hardware", (0.74, 0.37, 0.11), PIGMENT)
linen = painted_material("Unbleached linen", (0.82, 0.72, 0.53), TEXTILE)
moss = painted_material("Sage bedspread", (0.20, 0.36, 0.30), TEXTILE)
rust = painted_material("Brick red bedspread", (0.51, 0.169, 0.115), TEXTILE)
runner = painted_material("Woven runner", (0.24, 0.37, 0.32), TEXTILE)
binding = painted_material("Rug border", (0.60, 0.47, 0.28), TEXTILE)
bottles = [
    painted_material(f"Tinted bottle {i}", color, PIGMENT)
    for i, color in enumerate(((0.16, 0.31, 0.14), (0.10, 0.25, 0.32), (0.49, 0.23, 0.07)))
]


@dataclass(frozen=True)
class Fixture:
    name: str
    build: object
    x: float
    depth: float
    layer: str = "ysort"


@dataclass(frozen=True)
class FloorPlan:
    shell: object
    fixtures: tuple
    clearances: tuple
    markers: dict
    elevation: float
    lanterns: tuple


def lantern_positions(upper):
    height = GUEST_WALL_HEIGHT if upper else BAR_WALL_HEIGHT
    x_values = (-2.46, 2.96) if upper else (-2.78, 1.61)
    return tuple((x, HALF_DEPTH-WALL-0.33, DECK+height*0.82) for x in x_values)


def wall_details(upper, rear_face):
    for x, depth, z in lantern_positions(upper):
        box("Wall sconce", (x, rear_face-0.04, z), (0.13, 0.09, 0.25), darkwood)
        box("Lantern bracket", (x, (depth+rear_face)/2, z+0.165),
            (0.057, rear_face-depth+0.13, 0.054), darkwood)
        box("Amber lantern", (x, depth, z), (0.17, 0.15, 0.24), amber)
        for dz in (-0.12, 0.12):
            box("Lantern cap", (x, depth, z+dz), (0.20, 0.19, 0.038), darkwood)
    height = GUEST_WALL_HEIGHT if upper else BAR_WALL_HEIGHT
    z = DECK + height*0.70
    if upper:
        x = -1.05
        box("Rear guest window frame", (x, rear_face-0.035, z), (1.14, 0.09, 0.71), cedar)
        box("Rear window glazing", (x, rear_face-0.09, z), (0.95, 0.025, 0.53), pine)
        box("Rear window crossbar", (x, rear_face-0.11, z), (0.96, 0.042, 0.046), cedar)
        box("Rear window mullion", (x, rear_face-0.11, z), (0.055, 0.042, 0.55), cedar)
        box("Rear window sill", (x, rear_face-0.09, z-0.32), (1.21, 0.21, 0.08), cedar)
    else:
        # Small landscape on the left wall, with the picture facing the room.
        left_face = -HALF_WIDTH + WALL
        box("Tavern picture frame", (left_face+0.045, -0.78, z), (0.10, 0.77, 0.57), darkwood)
        box("Tavern picture canvas", (left_face+0.105, -0.78, z), (0.027, 0.62, 0.41), linen)
        box("Landscape horizon", (left_face+0.124, -0.78, z-0.075), (0.019, 0.58, 0.13), pine)
        box("Landscape sun", (left_face+0.132, -0.94, z+0.094), (0.016, 0.13, 0.12), amber)


def deck_panel(x0, x1, y0, y1, index):
    return box(f"Floor base {index}", ((x0+x1)/2, (y0+y1)/2, DECK/2-0.042),
               (x1-x0, y1-y0, DECK-0.084), darkwood, 0.018)


def floor_shell(upper):
    # The landing and floor opening share the staircase footprint from below.
    left, right = -HALF_WIDTH, HALF_WIDTH
    front, back = -HALF_DEPTH, HALF_DEPTH
    full_deck = (left, right, front, back)
    sections = [
        (left, WELL_LEFT, front, back), (WELL_RIGHT, right, front, back),
        (WELL_LEFT, WELL_RIGHT, front, STAIR_FRONT), (WELL_LEFT, WELL_RIGHT, STAIR_BACK, back),
    ] if upper else [full_deck]
    panels = [deck_panel(*region, index) for index, region in enumerate(sections)]
    bpy.ops.object.select_all(action="DESELECT")
    for panel in panels:
        panel.select_set(True)
    bpy.context.view_layer.objects.active = panels[0]
    if upper:
        bpy.ops.object.join()
    foundation = bpy.context.object

    for x0, x1, y0, y1 in sections:
        rows = max(1, round((x1-x0) / 0.24))
        row_width = (x1-x0) / rows
        for row in range(rows):
            x = x0 + (row+0.5)*row_width
            y = y0
            while y < y1-0.04:
                end = min(y1, y+rng.uniform(0.78, 1.50))
                box("Oak floorboard", (x, (y+end)/2, DECK-0.043),
                    (row_width-0.013, end-y-0.010, 0.086), rng.choice(planks), 0.006)
                y = end

    ceiling_line = GUEST_WALL_HEIGHT if upper else BAR_WALL_HEIGHT
    rear_wall = box("Rear cutaway wall", (0, back-WALL/2, DECK+ceiling_line/2),
                    (INN_WIDTH, WALL, ceiling_line), plaster, 0.023)
    box("Left cutaway wall", (left+WALL/2, 0, DECK+ceiling_line/2),
        (WALL, INN_DEPTH-WALL*2, ceiling_line), plaster, 0.023)
    for level, height in ((DECK+0.065, 0.13), (DECK+ceiling_line-0.035, 0.09)):
        box("Rear timber trim", (0, back-WALL-0.032, level), (INN_WIDTH-WALL*2, 0.065, height), cedar)
        box("Left timber trim", (left+WALL+0.032, 0, level), (0.065, INN_DEPTH-WALL*2, height), cedar)
    for x in (left+0.31, 0, right-0.31):
        box("Rear wall post", (x, back-WALL-0.033, DECK+ceiling_line/2), (0.13, 0.082, ceiling_line), posts)
    for y in (front+0.31, 0, back-0.31):
        box("Left wall post", (left+WALL+0.033, y, DECK+ceiling_line/2), (0.082, 0.13, ceiling_line), posts)
    wall_details(upper, back-WALL)
    # Leave the foreground open for gameplay legibility.
    if upper:
        stairwell()
    return foundation, rear_wall, (), None


def stairwell():
    run = STAIR_BACK-STAIR_FRONT
    for x in (WELL_LEFT-0.16, WELL_RIGHT+0.15):
        for depth in (STAIR_FRONT+0.06, (STAIR_FRONT+STAIR_BACK)/2, STAIR_BACK-0.06):
            box("Stairwell post", (x, depth, DECK+0.31), (0.10, 0.10, 0.62), posts)
        box("Stairwell rail", (x, (STAIR_FRONT+STAIR_BACK)/2, DECK+0.63),
            (0.095, run, 0.09), darkwood)
    box("Stairwell front cap", (STAIR_X, STAIR_FRONT-0.13, DECK+0.17), (1.54, 0.095, 0.34), cedar)
    for offset in (1, 0):
        height = DECK-offset*STAIR_RISE
        depth = STAIR_BACK-(offset+0.5)*STAIR_TREAD
        box("Visible stair tread", (STAIR_X, depth, height-0.030),
            (STAIR_WIDTH, STAIR_TREAD, 0.060), cedar, 0.007)
        if offset == 0:
            box("Landing riser", (STAIR_X, depth-STAIR_TREAD/2+0.026, height-STAIR_RISE/2),
                (STAIR_WIDTH-0.05, 0.052, STAIR_RISE), darkwood, 0.006)


def partition(width, length):
    height = GUEST_WALL_HEIGHT * 0.35
    base = box("Guest partition", (0, 0, height/2), (width, length, height), plaster, 0.008)
    box("Partition cap", (0, 0, height), (width, length, 0.055), cedar, 0.008)
    return base, None, (), None


def room_partitions():
    # Short wall sections have independent sort origins in the isometric view.
    join_x = ROOM_DIVIDER_X-WALL/2-0.012
    left = -HALF_WIDTH+WALL+0.08
    step = (join_x-left)/3
    for i in range(3):
        yield Fixture(f"room_partition_{i+1}", partial(partition, step, WALL), left+(i+0.5)*step, 0)
    edges = (
        (-HALF_DEPTH, ROOM_DOORS[0]-ROOM_DOOR_WIDTH/2),
        (ROOM_DOORS[0]+ROOM_DOOR_WIDTH/2, ROOM_DOORS[1]-ROOM_DOOR_WIDTH/2),
        (ROOM_DOORS[1]+ROOM_DOOR_WIDTH/2, HALF_DEPTH-WALL-0.074),
    )
    for i, (start, end) in enumerate(edges, 1):
        count = math.ceil((end-start)/0.82)
        step = (end-start)/count
        for j in range(count):
            yield Fixture(f"corridor_partition_{i}_{j+1}", partial(partition, WALL, step),
                          ROOM_DIVIDER_X, start+(j+0.5)*step)


def back_bar():
    base = box("Taproom bar footing", (0, 0, 0.07), (2.88, 0.63, 0.14), darkwood)
    box("Panelled counter", (0, 0, 0.51), (2.82, 0.55, 0.88), cedar)
    for x in (-1.22, -0.61, 0, 0.61, 1.22):
        box("Counter front batten", (x, -0.295, 0.50), (0.083, 0.055, 0.75), posts)
    box("Bar countertop", (0, 0, 0.99), (2.96, 0.69, 0.15), cedar)
    for x in (-0.98, 0.88):
        beam("Tankard", (x, -0.13, 1.065), (x, -0.13, 1.24), 0.088, linen, 0.105, 12)
    return base, None, (), None


def bottle_cabinet():
    base = box("Bottle shelf plinth", (0, 0, 0.05), (2.39, 0.33, 0.10), darkwood)
    box("Cabinet back", (0, 0.12, 0.91), (2.39, 0.08, 1.72), pine)
    for x in (-1.15, 1.15):
        box("Shelf side", (x, 0, 0.91), (0.10, 0.33, 1.72), cedar)
    for level in (0.54, 0.91, 1.28):
        box("Bottle shelf", (0, -0.015, level), (2.31, 0.31, 0.058), cedar)
        for i, x in enumerate((-0.95, -0.64, -0.32, 0, 0.34, 0.65, 0.94)):
            bottle = bottles[(i+round(level*10)) % len(bottles)]
            foot = level+0.029
            beam("Bottle glass", (x, -0.05, foot), (x, -0.05, foot+0.18), 0.068, bottle, 0.056, 10)
            beam("Bottle neck", (x, -0.05, foot+0.17), (x, -0.05, foot+0.265), 0.033, bottle, sides=10)
    return base, None, (), None


def serving_ledge():
    base = box("Hatch pedestal", (0, 0, 0.065), (BAR_WIDTH, 0.43, 0.13), darkwood)
    box("Serving hatch apron", (0, 0, 0.48), (BAR_WIDTH, 0.38, 0.79), cedar)
    box("Street-service counter", (0, 0, 0.92), (BAR_WIDTH+0.13, 0.48, 0.13), cedar)
    return base, None, (), None


def round_table():
    base = box("Table foot", (0, 0, 0.045), (0.46, 0.42, 0.09), darkwood)
    beam("Turned table pedestal", (0, 0, 0.085), (0, 0, 0.69), 0.14, cedar, 0.11, 10)
    beam("Round tabletop", (0, 0, 0.69), (0, 0, 0.81), 0.43, cedar, sides=20)
    return base, None, (), None


def stool():
    base = beam("Stool leg", (0, 0, 0), (0, 0, 0.38), 0.093, darkwood, 0.072, 10)
    beam("Stool seat", (0, 0, 0.38), (0, 0, 0.46), 0.198, pine, sides=14)
    return base, None, (), None


def staircase():
    run = STAIR_BACK - STAIR_FRONT
    count = STAIR_STEPS
    rise, tread = STAIR_RISE, STAIR_TREAD
    base = box("First tread", (0, -run/2+tread/2, rise/2), (STAIR_WIDTH, tread, rise), cedar, 0.012)
    for i in range(1, count):
        height = rise*(i+1)
        depth = -run/2+i*tread
        box("Tavern stair tread", (0, depth+tread/2, height-0.032),
            (STAIR_WIDTH, tread, 0.064), cedar, 0.009)
        box("Stair riser", (0, depth+0.035, height-rise/2),
            (STAIR_WIDTH-0.045, 0.070, rise), darkwood, 0.008)
    front, back = -run/2+0.13, run/2-0.14
    low, high = rise-0.09, INN_TAPROOM_HEIGHT-0.19
    length = math.hypot(back-front, high-low)
    tilt = math.atan2(high-low, back-front)
    for x in (-STAIR_WIDTH/2+0.09, STAIR_WIDTH/2-0.09):
        box("Stair stringer", (x, (front+back)/2, (low+high)/2),
            (0.13, length, 0.16), darkwood, 0.014, tilt)
        box("Landing support", (x, back, high/2),
            (0.15, 0.16, high), posts, 0.013)
    for step in (0, 5, 10, count-1):
        depth = -run/2+(step+0.5)*tread
        z = rise*(step+1)
        box("Stair rail upright", (-STAIR_WIDTH/2+0.05, depth, z+0.36), (0.077, 0.077, 0.72), darkwood)
    beam("Stair handrail", (-STAIR_WIDTH/2+0.05, -run/2+tread/2, rise+0.72),
         (-STAIR_WIDTH/2+0.05, run/2-tread/2, INN_TAPROOM_HEIGHT+0.72), 0.059, darkwood, sides=8)
    return base, None, (), None


def bed(cover):
    base = box("Bed foot", (0, 0, 0.065), (1.92, 0.88, 0.13), darkwood)
    box("Cedar bed frame", (0, 0, 0.22), (1.97, 0.92, 0.27), cedar, 0.042)
    box("Linen mattress", (-0.02, 0, 0.43), (1.76, 0.84, 0.23), linen, 0.096)
    box("Headboard", (-0.95, 0, 0.43), (0.13, 0.94, 0.72), cedar, 0.048)
    box("Footboard", (0.95, 0, 0.32), (0.12, 0.94, 0.52), cedar, 0.035)
    box("Pillow", (-0.62, 0, 0.585), (0.35, 0.69, 0.14), linen, 0.061)
    box("Guest quilt", (0.29, 0, 0.56), (1.12, 0.88, 0.105), cover, 0.039)
    for x in (-0.13, 0.66):
        box("Quilt ribbon", (x, 0, 0.619), (0.038, 0.83, 0.016), binding, 0.005)
    for y in (-0.335, 0.335):
        for index in range(10):
            box("Quilt stitch", (-0.172+index*0.103, y, 0.615),
                (0.049, 0.016, 0.012), linen, 0.003)
    return base, None, (), None


def chest():
    base = box("Guest trunk footing", (0, 0, 0.065), (0.72, 0.46, 0.13), darkwood)
    box("Guest trunk", (0, 0, 0.26), (0.71, 0.44, 0.38), cedar, 0.043)
    for x in (-0.23, 0.23):
        box("Trunk strap", (x, 0, 0.47), (0.069, 0.46, 0.035), darkwood)
    box("Trunk clasp", (0, -0.227, 0.36), (0.13, 0.037, 0.10), amber)
    return base, None, (), None


def hall_rug():
    base = box("Runner backing", (0, 0, 0.012), (0.85, 3.64, 0.024), binding, 0.01)
    box("Woven corridor runner", (0, 0, 0.024), (0.76, 3.51, 0.015), runner, 0.008)
    return base, None, (), None


def entrance_mat():
    base = box("Door mat backing", (0, 0, 0.012), (1.11, 0.62, 0.024), binding, 0.015)
    box("Coir mat", (0, 0, 0.023), (1.02, 0.52, 0.017), runner, 0.013)
    for x in (-0.42, 0.42):
        box("Threshold border stripe", (x, 0, 0.032), (0.052, 0.49, 0.008), linen, 0.005)
    return base, None, (), None


def table_fixtures():
    for suffix, x, depth in (("", -1.89, 0.23), ("_hatch", -0.92, -1.04)):
        yield Fixture(f"round_table{suffix}", round_table, x, depth)
        for label, delta in (("left", -0.65), ("right", 0.65)):
            yield Fixture(f"stool_{label}{suffix}", stool, x+delta, depth)


def route(name, x0, x1, y0, y1):
    # Rugs and thresholds can sit below the walking clearance.
    return Volume(name, AABB(Point(x0, DECK+0.05, y0), Point(x1, DECK+1.8, y1)))


def validate_floor_dimensions(level):
    front, back = -HALF_DEPTH, HALF_DEPTH
    if INN_WIDTH <= 2*WALL or INN_DEPTH <= 2*WALL:
        raise ValueError("Inn floor is too small to fit its perimeter walls")
    if not (-HALF_WIDTH+WALL < ENTRY_X-ENTRY_WIDTH/2 < ENTRY_X+ENTRY_WIDTH/2 < HALF_WIDTH-WALL):
        raise ValueError("Inn floor width cannot fit the entrance opening")
    if not (front+WALL < STAIR_FRONT < STAIR_BACK < back-WALL):
        raise ValueError("Inn floor depth cannot fit the staircase and landing")
    if level == "upper":
        door_starts = [door-ROOM_DOOR_WIDTH/2 for door in ROOM_DOORS]
        door_ends = [door+ROOM_DOOR_WIDTH/2 for door in ROOM_DOORS]
        if not (front < door_starts[0] < door_ends[0] < door_starts[1] < door_ends[1] < back-WALL-0.074):
            raise ValueError("Inn upper floor depth cannot fit both guest-room doors and their partitions")
        if WELL_LEFT-0.23-(ROOM_DIVIDER_X+WALL/2) < ROOM_DOOR_WIDTH:
            raise ValueError("Inn upper floor width cannot fit the guest corridor beside the stairwell")


def interior_footprints(level):
    floor = Footprint(-HALF_WIDTH, -HALF_DEPTH, HALF_WIDTH, HALF_DEPTH)
    left, front, right, back = floor.left, floor.front, floor.right, floor.back
    # The visible rear and left walls use their mesh footprints. The open
    # cutaway edges need boundary colliders at the same floor-slab edge.
    guards = [("right_edge", Footprint(right-WALL, front, right, back))]
    if level == "ground":
        guards.extend([
            ("front_left", Footprint(left, front, ENTRY_X-ENTRY_WIDTH/2, front+WALL)),
            ("front_right", Footprint(ENTRY_X+ENTRY_WIDTH/2, front, right, front+WALL)),
        ])
    else:
        guards.extend([
            ("front_edge", Footprint(left, front, right, front+WALL)),
            ("stairwell_opening", Footprint(WELL_LEFT, STAIR_FRONT, WELL_RIGHT, STAIR_BACK)),
        ])
    return floor, guards


def floor_plan(level):
    validate_floor_dimensions(level)
    if level == "ground":
        return FloorPlan(
            partial(floor_shell, False),
            (
                Fixture("bottle_cabinet", bottle_cabinet, -1.36, 2.36),
                Fixture("bar_counter", back_bar, -1.28, 1.46),
                Fixture("street_serving_hatch", serving_ledge, BAR_X, -2.43),
                *table_fixtures(),
                Fixture("staircase", staircase, STAIR_X, STAIR_FRONT+STAIR_TREAD/2, "shell"),
                Fixture("entrance_mat", entrance_mat, ENTRY_X, -HALF_DEPTH+0.36, "floor"),
            ),
            (route("Entry and stair approach", ENTRY_X-ENTRY_WIDTH/2, STAIR_X+0.60, -HALF_DEPTH, STAIR_FRONT),),
            {"entry": Point(ENTRY_X, DECK, -HALF_DEPTH+0.36), "stairs": Point(STAIR_X, DECK, STAIR_FRONT)},
            DECK,
            lantern_positions(False),
        )
    if level == "upper":
        return FloorPlan(
            partial(floor_shell, True),
            (
                *room_partitions(),
                Fixture("bed", partial(bed, moss), -1.79, -1.87),
                Fixture("bed_north", partial(bed, rust), -1.79, 1.95),
                Fixture("trunk_south", chest, -2.53, -0.58),
                Fixture("trunk_north", chest, -2.53, 0.61),
                Fixture("rug", hall_rug, 0.54, -0.14, "floor"),
            ),
            (
                route("Guest corridor", ROOM_DIVIDER_X+WALL/2+0.02, WELL_LEFT-0.23, -2.50, 2.57),
                *(route(f"Guest doorway {i}", -0.76, ROOM_DIVIDER_X+0.11, y-0.35, y+0.35)
                  for i, y in enumerate(ROOM_DOORS, 1)),
                route("Stairwell opening", WELL_LEFT+0.06, WELL_RIGHT-0.06, STAIR_FRONT, STAIR_BACK),
                route("Upper stair landing", 0.75, WELL_RIGHT, STAIR_BACK+0.06, HALF_DEPTH-WALL-0.08),
            ),
            {
                "stairs": Point(STAIR_X, DECK, STAIR_BACK+0.38),
                **{f"guest_room_{i}": Point(ROOM_DIVIDER_X, DECK, y) for i, y in enumerate(ROOM_DOORS, 1)},
            },
            DECK + INN_TAPROOM_HEIGHT,
            lantern_positions(True),
        )
    raise ValueError(f"Unknown Inn interior floor: {level}")
