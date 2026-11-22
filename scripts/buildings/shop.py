"""Half-timbered village grocer with a cross gable and street-side produce stands."""
from math import cos, pi, sin, sqrt
from random import Random

from mathutils import Vector

from blender_render import beam, box, bpy, darkwood, finish, prism
from core.constants import GLOBAL_DOOR_HEIGHT, GLOBAL_PLINTH_HEIGHT, GLOBAL_WALL_HEIGHT
from core.painted_materials import (
    FOLIAGE, PIGMENT, PLASTER, POST, ROOF, STONE, TEXTILE, TIMBER, painted_material,
)

WIDTH = 7.8
DEPTH = 4.1
FRONT = -DEPTH / 2
FLOOR = GLOBAL_PLINTH_HEIGHT
EAVES = FLOOR + GLOBAL_WALL_HEIGHT
DOOR_WIDTH = 1.36
STALL_X = (-2.23, 2.23)
ROOF_SPAN = 2.30
ROOF_LENGTH = WIDTH / 2 + 0.24
GABLE_SPAN = 2.06
GABLE_FRONT = -2.42
SLOPE = 0.73
GABLE_SLOPE = -GABLE_FRONT * SLOPE / GABLE_SPAN
RIDGE = EAVES + 0.14 + ROOF_SPAN * SLOPE

oak = painted_material("Grocer honey oak", (0.51, 0.24, 0.075), TIMBER)
posts = painted_material("Grocer upright oak", (0.46, 0.19, 0.058), POST)
plaster = painted_material("Grocer warm limewash", (0.88, 0.73, 0.52), PLASTER)
mortar = painted_material("Grocer masonry mortar", (0.29, 0.23, 0.17), STONE)
stone = [painted_material(f"Grocer sandstone {i}", color, STONE) for i, color in enumerate(
    ((0.44, 0.34, 0.23), (0.60, 0.48, 0.34), (0.70, 0.55, 0.37), (0.51, 0.44, 0.36))
)]
blue = [painted_material(f"Indigo glazed shingle {i}", color, ROOF)
        for i, color in enumerate(((0.036, 0.077, 0.23), (0.045, 0.092, 0.27),
                                   (0.056, 0.110, 0.30), (0.042, 0.088, 0.25)))]
roof_deck = painted_material("Deep indigo roof deck", (0.025, 0.044, 0.105), ROOF)
canvas = [painted_material("Crimson canvas", (0.65, 0.035, 0.027), TEXTILE),
          painted_material("Marigold canvas", (0.96, 0.56, 0.088), TEXTILE)]
glass = painted_material("Honey glass", (1.0, 0.47, 0.044), PIGMENT, glossy=True)
glass_shadow = painted_material("Amber glass", (0.43, 0.13, 0.022), PIGMENT, glossy=True)
attic_glass = painted_material("Blue attic glass", (0.083, 0.13, 0.18), PIGMENT, glossy=True)
iron = painted_material("Blackened copper", (0.095, 0.061, 0.032), PIGMENT, glossy=True)
terracotta = painted_material("Chimney terracotta", (0.56, 0.174, 0.062), STONE)
leaves = [painted_material(f"Grocer leaf {i}", color, FOLIAGE) for i, color in enumerate(
    ((0.18, 0.30, 0.035), (0.30, 0.42, 0.049), (0.093, 0.19, 0.024))
)]
petals = [painted_material("Cream petals", (0.93, 0.89, 0.72), PIGMENT),
          painted_material("Pink petals", (0.8, 0.21, 0.28), PIGMENT)]
produce = [painted_material(name, color, PIGMENT, glossy=True) for name, color in (
    ("Apple", (0.72, 0.041, 0.022)), ("Pear", (0.65, 0.64, 0.055)),
    ("Plum", (0.26, 0.061, 0.23)), ("Pumpkin", (0.90, 0.30, 0.028)),
    ("Cabbage", (0.41, 0.57, 0.11)), ("Tomato", (0.80, 0.071, 0.023)),
)]


def ellipsoid(name, center, radii, surface):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=1, location=center)
    obj = finish(bpy.context.object, name, surface)
    obj.scale = radii
    for face in obj.data.polygons:
        face.use_smooth = True
    return obj


def solid(name, points, offset, surface, bevel=0):
    # prism() expects the profile normal to point in the extrusion direction.
    axis = Vector(offset)
    winding = sum(Vector(a).cross(Vector(b)).dot(axis) for a, b in zip(points, points[1:]+points[:1]))
    obj = prism(name, points if winding > 0 else points[::-1], offset, surface)
    if bevel:
        modifier = obj.modifiers.new("Soft edge", "BEVEL")
        modifier.width = bevel
        modifier.segments = 2
    return obj


def front_shape(name, points, depth, thickness, surface, bevel=0):
    return solid(name, [(x, depth, z) for x, z in points], (0, thickness, 0), surface, bevel)


def arch_outline(x, spring, half, rise):
    return [(x + half*cos(i*pi/12), spring + rise*sin(i*pi/12)) for i in range(13)]


def front_window(x, y, sill, width, height, surface, arched=False, display=False):
    half = width/2
    spring = sill + height * (0.72 if arched else 1)
    rise = sill + height - spring
    if arched:
        pane = [(x-half, sill), (x+half, sill), *arch_outline(x, spring, half, rise)]
        front_shape("Arched pane", pane, y, 0.075, surface)
        outer = arch_outline(x, spring, half+0.09, rise+0.09)
        inner = arch_outline(x, spring, half-0.016, rise-0.016)
        front_shape("Arched oak lintel", [*outer, *reversed(inner)], y-0.085, 0.13, oak, 0.018)
    else:
        box("Rectangular pane", (x, y+0.035, sill+height/2), (width, 0.075, height), surface)
        box("Window head", (x, y-0.04, sill+height), (width+0.19, 0.15, 0.105), oak)
    for dx in (-half, half):
        box("Window jamb", (x+dx, y-0.036, (sill+spring)/2), (0.105, 0.15, spring-sill+0.05), posts)
    dividers = (-width/6, width/6) if display else (0,)
    for dx in dividers:
        top = spring + rise*sqrt(1-(dx/half)**2)
        box("Window mullion", (x+dx, y-0.06, (sill+top)/2), (0.052, 0.105, top-sill), oak, 0.011)
    transom = sill+height*0.48
    box("Window transom", (x, y-0.06, transom), (width, 0.11, 0.060), oak, 0.012)
    box("Oak windowsill", (x, y-0.054, sill), (width+0.24, 0.25, 0.11), oak)

    if display:
        for row, base in enumerate((sill+0.053, transom+0.033)):
            for col, dx in enumerate((-width/3, 0, width/3)):
                r = 0.074 + 0.014*((row+col) % 3)
                jar(x+dx, y-0.052, base, r, 0.20 if col == 1 else 0.15,
                    glass if (row+col) % 2 else terracotta)


def jar(x, y, base, radius, height, surface):
    beam("Preserve jar", (x, y, base), (x, y, base+height), radius, surface, radius*0.84, 12)
    beam("Jar lid", (x, y, base+height), (x, y, base+height+0.033), radius*0.88, oak, sides=12)


def flower_box(x, y, z, width, side=False):
    def point(offset, outward, height):
        return (x+outward, y+offset, height) if side else (x+offset, y-outward, height)

    dimensions = (0.26, width, 0.19) if side else (width, 0.26, 0.19)
    box("Flower box", point(0, 0.095, z), dimensions, oak, 0.022)
    dimensions = (0.31, width+0.06, 0.05) if side else (width+0.06, 0.31, 0.05)
    box("Flower box lip", point(0, 0.095, z+0.083), dimensions, posts, 0.013)
    for i in range(11):
        u = width * (i/11 - 0.45)
        dz = 0.14 + 0.07*sin(i*3)
        ellipsoid("Trailing foliage", point(u, 0.17+0.055*cos(i), z+dz),
                  (0.13, 0.13, 0.12 if i % 3 else 0.21), leaves[i % len(leaves)])
        center = point(u, 0.23, z+dz+0.08)
        for j in range(5):
            angle = j*2*pi/5
            petal = (center[0]+0.036*cos(angle), center[1]+0.036*sin(angle), center[2])
            ellipsoid("Blossom petal", petal, (0.029, 0.029, 0.018), petals[i % 2])
        ellipsoid("Blossom center", (center[0], center[1], center[2]+0.014), (0.023, 0.023, 0.018), glass)


def closeup_details():
    for x in STALL_X:
        front_window(x, FRONT-0.073, FLOOR+0.53, 1.32, 1.15, glass_shadow, arched=True, display=True)
    for x in (-0.99, 0.99):
        z = FLOOR+1.49
        y = FRONT-0.17
        beam("Lantern hook", (x, FRONT, z+0.31), (x, y-0.05, z+0.31), 0.024, iron)
        beam("Lantern crown", (x, y-0.05, z+0.12), (x, y-0.05, z+0.31), 0.13, iron, 0.028, 6)
        beam("Lantern glass", (x, y-0.05, z-0.13), (x, y-0.05, z+0.12), 0.076, glass, 0.10, 6)
        beam("Lantern foot", (x, y-0.05, z-0.16), (x, y-0.05, z-0.10), 0.068, iron, 0.095, 6)
        for i in range(4):
            a = i*pi/2
            beam("Lantern cage", (x+0.075*cos(a), y-0.05+0.075*sin(a), z-0.12),
                 (x+0.102*cos(a), y-0.05+0.102*sin(a), z+0.12), 0.012, iron)

    x = -3.34
    for i in range(3):
        base = FLOOR+0.35+i*0.40
        box("Outdoor shelf", (x, FRONT-0.13, base), (0.65, 0.29, 0.077), oak)
        jar(x-0.14, FRONT-0.14, base+0.035, 0.094, 0.21, terracotta)
        jar(x+0.13, FRONT-0.14, base+0.035, 0.083, 0.17, glass)

    x = 3.31
    beam("Banner hanger", (x-0.29, FRONT-0.15, FLOOR+1.82), (x+0.33, FRONT-0.15, FLOOR+1.82), 0.046, oak)
    top = FLOOR+1.81
    front_shape("Shop banner", [(x-.24, top), (x-.24, top-.64), (x, top-.73), (x+.24, top-.64),
                                 (x+.24, top)], FRONT-0.19, 0.046, canvas[0], 0.016)
    box("Banner panel", (x, FRONT-0.197, top-.28), (0.42, 0.026, 0.48), canvas[1], 0.021)
    ellipsoid("Banner apple emblem", (x, FRONT-0.219, top-.29), (0.115, 0.025, 0.091), canvas[0])
    ellipsoid("Banner apple leaf", (x+.042, FRONT-0.220, top-.19), (0.052, 0.023, 0.026), leaves[0])

    x, y, sill = WIDTH/2, -0.72, FLOOR+0.63
    box("Side window amber panes", (x+0.034, y, sill+0.53), (0.09, 0.90, 1.06), glass)
    for dy in (-0.45, 0, 0.45):
        box("Side window mullion", (x+0.09, y+dy, sill+0.53), (0.13, 0.075, 1.10), oak)
    for dz in (0, 0.53, 1.06):
        box("Side window rail", (x+0.09, y, sill+dz), (0.15, 1.03, 0.085), oak)
    for dy in (-0.62, 0.62):
        box("Side shutter", (x+0.10, y+dy, sill+0.53), (0.15, 0.29, 1.04), posts)
        for dz in (0.20, 0.81):
            box("Shutter hinge", (x+0.182, y+dy, sill+dz), (0.026, 0.23, 0.044), iron, 0.008)
    flower_box(x+0.08, y, sill-0.07, 0.95, side=True)


def awning():
    width = 5.9
    count = 12
    for i in range(count):
        x = width*((i+0.5)/count-0.5)
        half = width/count/2
        fabric = canvas[i % 2]
        high, low = EAVES+0.25, EAVES-0.105
        y0, y1 = FRONT-0.035, FRONT-0.97
        # A shallow bow between the wall rail and the front rail catches the light.
        profile = [(y0+(y1-y0)*t, high+(low-high)*t-0.045*sin(pi*t)) for t in (0, .25, .5, .75, 1)]
        front = [(x-half, y, z) for y, z in profile]
        front.extend((x-half, y, z-0.026) for y, z in reversed(profile))
        solid("Awning canvas panel", front, (2*half-0.008, 0, 0), fabric)
        hem = [(x+(half-0.005)*cos(j*pi/10), low-0.16*sin(j*pi/10)) for j in range(11)]
        front_shape("Scalloped canvas valance", hem, y1-0.035, 0.038, fabric, 0.009)
    for x in (-2.90, 2.90):
        beam("Awning brace", (x, FRONT, EAVES-0.37), (x, FRONT-0.92, EAVES-0.12), 0.043, posts)


def roof_tile(name, plane, surface):
    if len(plane) >= 3:
        solid(name, plane, (0, 0, -0.076), surface, 0.018)


def clip_polygon(polygon, distance):
    """Clip a tile in plan at a roof valley."""
    clipped = []
    for a, b in zip(polygon, polygon[1:] + polygon[:1]):
        da, db = distance(*a), distance(*b)
        if da >= 0:
            clipped.append(a)
        if (da < -1e-7 and db > 1e-7) or (da > 1e-7 and db < -1e-7):
            t = da / (da-db)
            clipped.append((a[0]+t*(b[0]-a[0]), a[1]+t*(b[1]-a[1])))
    return clipped


def gabled_roof():
    start = set(bpy.context.scene.objects)
    gable_base = RIDGE+GABLE_FRONT*SLOPE
    prism("Side gables", [(-WIDTH/2, FRONT, EAVES), (-WIDTH/2, -FRONT, EAVES),
                         (-WIDTH/2, 0, RIDGE-0.08)], (WIDTH, 0, 0), plaster)
    # The shallow projection houses the attic display without thickening the whole facade.
    front_shape("Central cross gable", [(-GABLE_SPAN, gable_base-0.07), (GABLE_SPAN, gable_base-0.07),
                                        (0, RIDGE-0.06)], GABLE_FRONT+0.055,
                FRONT-GABLE_FRONT+0.02, plaster)
    front_window(0, GABLE_FRONT-0.02, gable_base+0.21, 0.83, 0.83, attic_glass, arched=True)
    flower_box(0, GABLE_FRONT-0.10, gable_base+0.15, 1.24)
    box("Central gable tie beam", (0, GABLE_FRONT-0.02, gable_base), (GABLE_SPAN*2, 0.21, 0.14), oak)
    for y in (-ROOF_SPAN, ROOF_SPAN):
        box("Main eave fascia", (0, y, EAVES+0.07), (2*ROOF_LENGTH, 0.19, 0.15), oak)
    for side in (-1, 1):
        for x, z0, z1 in ((0.63, 0, 1.06), (1.21, 0, 0.65)):
            box("Cross gable stud", (side*x, GABLE_FRONT-0.012, gable_base+(z0+z1)/2),
                (0.12, 0.148, z1-z0), posts)
        beam("Central gable rake", (0, GABLE_FRONT-0.024, RIDGE-0.025),
             (side*GABLE_SPAN, GABLE_FRONT-0.024, gable_base-0.025), 0.102, oak, sides=4)
        for x in (-ROOF_LENGTH, ROOF_LENGTH):
            beam("End gable rake", (x, 0, RIDGE-0.045),
                 (x, side*ROOF_SPAN, EAVES+0.075), 0.095, oak, sides=4)

    for side in (-1, 1):
        solid("Main roof decking", [(-ROOF_LENGTH, 0, RIDGE-0.043), (ROOF_LENGTH, 0, RIDGE-0.043),
                                   (ROOF_LENGTH, side*ROOF_SPAN, EAVES+0.097),
                                   (-ROOF_LENGTH, side*ROOF_SPAN, EAVES+0.097)], (0, 0, -0.083), roof_deck)
        solid("Cross gable decking", [(0, 0, RIDGE-0.018), (0, GABLE_FRONT, RIDGE-0.018),
                                      (side*GABLE_SPAN, GABLE_FRONT, gable_base-0.018)],
              (0, 0, -0.08), roof_deck)
        for row in range(7):
            a, b = row*ROOF_SPAN/7+0.008, (row+1)*ROOF_SPAN/7-0.005
            step = ROOF_LENGTH/11
            shift = step/2 if row % 2 else 0
            for col in range(-12, 11):
                x0 = max(-ROOF_LENGTH, col*step+shift+0.007)
                x1 = min(ROOF_LENGTH, (col+1)*step+shift-0.007)
                if x0 >= x1:
                    continue
                rectangle = [(x0, a), (x1, a), (x1, b), (x0, b)]
                # The front valley divides the roof into two visible wings.
                plans = (rectangle,) if side > 0 else tuple(
                    clip_polygon(rectangle, lambda x, d: x*wing*GABLE_SLOPE-d*SLOPE)
                    for wing in (-1, 1)
                )
                for plan in plans:
                    roof_tile("Main glazed roof tile", [(x, side*d, RIDGE-d*SLOPE) for x, d in plan],
                              blue[(row*3+col*5) % len(blue)])
        for row in range(6):
            a = row*GABLE_SPAN/6+0.007
            b = (row+1)*GABLE_SPAN/6-0.006
            for col in range(8):
                d0, d1 = col*-GABLE_FRONT/8+0.008, (col+1)*-GABLE_FRONT/8
                plan = clip_polygon([(a, d0), (b, d0), (b, d1), (a, d1)],
                                    lambda x, d: d*SLOPE-x*GABLE_SLOPE+0.014)
                roof_tile("Cross gable glazed tile", [(side*x, -d, RIDGE-x*GABLE_SLOPE+0.023) for x, d in plan],
                          blue[(row*5+col*3) % len(blue)])

    for i in range(22):
        a = (i/11-1)*ROOF_LENGTH
        b = ((i+1)/11-1)*ROOF_LENGTH
        if i not in (10, 11):
            beam("Main glazed ridge roll", (a, 0, RIDGE+0.025), (b-0.014, 0, RIDGE+0.025),
                 0.094, blue[i % len(blue)], sides=12)
    for i in range(8):
        a = GABLE_FRONT*(1-i/8)
        b = GABLE_FRONT*(1-(i+1)/8)
        beam("Gable glazed ridge roll", (0, a, RIDGE+0.051), (0, b-0.01, RIDGE+0.051),
             0.102, blue[i % len(blue)], sides=12)

    for x in (-2.88, 2.88):
        dormer(x)

    # This footing projects through the ridge. The separate chimney docks on its top face.
    box("Chimney roof flashing", (2.38, 0.10, RIDGE+0.027),
                   (0.85, 0.77, 0.25), stone[0], 0.03)
    return set(bpy.context.scene.objects)-start


def light_shopfront():
    for x in (-0.99, 0.99):
        light = bpy.data.lights.new("Grocer lantern glow", "POINT")
        light.color = (1, 0.56, 0.20)
        light.energy = 23
        light.shadow_soft_size = 0.13
        lamp = bpy.data.objects.new("Grocer lantern glow", light)
        bpy.context.collection.objects.link(lamp)
        lamp.location = (x, FRONT-0.42, FLOOR+1.49)


def dormer(x):
    y, base = -1.88, RIDGE-1.88*SLOPE-0.073
    width = 0.84
    head = base+0.66
    box("Dormer housing", (x, y+0.26, (head+base)/2), (width, 0.61, head-base), plaster)
    front_window(x, y-0.068, base+0.10, 0.50, 0.46, glass)
    # Two courses on a short shed roof. The upper course runs into the main slope.
    span, pitch = 0.94, 0.43
    for row in range(3):
        d0, d1 = row*span/3, (row+1)*span/3
        for col in range(3):
            lx, rx = x-0.55+col*1.10/3+0.008, x-0.55+(col+1)*1.10/3-0.008
            plan = [(lx, d0), (rx, d0), (rx, d1-0.009), (lx, d1-0.009)]
            roof_tile("Dormer glazed shingle", [(a, y-0.20+b, head+b*pitch) for a, b in plan],
                      blue[(row+col) % len(blue)])
    box("Dormer eave", (x, y-0.16, head-0.045), (1.11, 0.16, 0.10), oak)


def market_shop():
    foundation = box("Grocer stone foundation", (0, 0, FLOOR/2), (WIDTH, DEPTH, FLOOR), mortar, 0.035)
    rng = Random(114)
    for row in range(2):
        z = (row+0.5)*FLOOR/2
        for i in range(17):
            x = WIDTH*((i+0.5)/17-0.5)
            # Keep the threshold flush so its stair socket meets the plinth.
            if abs(x) > DOOR_WIDTH/2+0.30:
                box("Front sandstone block", (x, FRONT, z), (WIDTH/17-0.014, 0.16, FLOOR/2-0.014),
                    rng.choice(stone), 0.042)
        for i in range(9):
            y = DEPTH*((i+0.5)/9-0.5)
            box("Side sandstone block", (WIDTH/2, y, z), (0.19, DEPTH/9-0.018, FLOOR/2-0.014),
                rng.choice(stone), 0.043)

    wing = (WIDTH-DOOR_WIDTH)/2
    for side in (-1, 1):
        box("Ivory shop facade", (side*(DOOR_WIDTH+wing)/2, 0, FLOOR+GLOBAL_WALL_HEIGHT/2),
            (wing, DEPTH, GLOBAL_WALL_HEIGHT), plaster)
    box("Recessed doorway back", (0, FRONT+0.62, FLOOR+GLOBAL_DOOR_HEIGHT/2),
        (DOOR_WIDTH, 0.12, GLOBAL_DOOR_HEIGHT), darkwood)
    for i in range(7):
        box("Recess floorboard", (0, FRONT+(i+0.5)*0.09, FLOOR+0.012),
            (DOOR_WIDTH, 0.088, 0.022), darkwood, 0.005)
    portal = box("Entrance oak header", (0, FRONT-0.062, FLOOR+GLOBAL_DOOR_HEIGHT+0.062),
                 (DOOR_WIDTH+0.25, 0.23, 0.124), oak)
    wall = box("Full-width timber lintel", (0, 0, (EAVES+FLOOR+GLOBAL_DOOR_HEIGHT)/2),
               (WIDTH, DEPTH, EAVES-FLOOR-GLOBAL_DOOR_HEIGHT), plaster, 0.012)
    for x in (-3.79, -2.97, -0.71, 0.71, 2.97, 3.79):
        box("Full height facade post", (x, FRONT-0.048, FLOOR+GLOBAL_WALL_HEIGHT/2),
            (0.16, 0.24, GLOBAL_WALL_HEIGHT), posts, 0.025)
    for y in (FRONT+0.10, -FRONT-0.10):
        box("Side corner post", (WIDTH/2, y, FLOOR+GLOBAL_WALL_HEIGHT/2),
            (0.19, 0.21, GLOBAL_WALL_HEIGHT), posts)
    for z in (FLOOR+0.12, EAVES-0.12):
        for side in (-1, 1):
            box("Facade oak rail", (side*(DOOR_WIDTH+wing)/2, FRONT-0.065, z),
                (wing, 0.18, 0.15), oak)
        box("Side oak rail", (WIDTH/2+0.045, 0, z), (0.16, DEPTH, 0.15), oak)
    for side in (-1, 1):
        beam("Eave knee brace", (side*3.77, FRONT-0.10, EAVES-0.53),
             (side*3.30, FRONT-0.10, EAVES-0.07), 0.085, oak, sides=4)
    closeup_details()
    awning()
    roof = gabled_roof()
    return foundation, wall, roof, portal


def shop_steps():
    top = FLOOR * 0.53
    base = box("Grocer lower stone step", (0, 0, top/2), (1.66, 0.67, top), stone[0], 0.033)
    for i in range(3):
        x = (i-1)*0.48
        for z, y, depth, h in ((top-0.04, -0.18, 0.31, 0.08), ((top+FLOOR)/2, 0.135, 0.40, FLOOR-top)):
            box("Step sandstone tread", (x, y, z), (0.47, depth, h), stone[i+1], 0.027)
    return base, None, (), None


def chimney():
    footprint = box("Chimney plinth molding", (0, 0, 0.052), (0.72, 0.66, 0.104), stone[0], 0.025)
    box("Chimney masonry core", (0, 0, 0.50), (0.61, 0.55, 0.88), mortar, 0.026)
    for i in range(5):
        z = 0.15+i*0.18
        widths = (0.36, 0.28) if i % 2 else (0.28, 0.36)
        for y in (-0.255, 0.255):
            for j, width in enumerate(widths):
                x = -0.32+sum(widths[:j])+width/2
                box("Chimney bond course", (x, y, z), (width-0.012, 0.112, 0.166),
                    stone[(i+j) % len(stone)], 0.035)
        for y in (-0.111, 0.111):
            box("Chimney side course", (0.283, y, z), (0.11, 0.21, 0.166), stone[i % 4], 0.032)
    box("Chimney sandstone crown", (0, 0, 1.02), (0.72, 0.65, 0.16), stone[2], 0.044)

    # A hollow tapered pot keeps the opening visible from the sprite camera.
    rings = ((0.21, 1.095), (0.185, 1.38), (0.237, 1.39), (0.237, 1.465),
             (0.171, 1.465), (0.157, 1.20))
    count = 20
    verts = [(r*cos(2*pi*i/count), r*sin(2*pi*i/count), z) for r, z in rings for i in range(count)]
    faces = [(j*count+i, j*count+(i+1) % count, (j+1)*count+(i+1) % count, (j+1)*count+i)
             for j in range(len(rings)-1) for i in range(count)]
    faces.append(tuple(reversed(range((len(rings)-1)*count, len(rings)*count))))
    mesh = bpy.data.meshes.new("Open terracotta pot")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new("Open terracotta pot", mesh)
    bpy.context.collection.objects.link(obj)
    finish(obj, "Open terracotta pot", terracotta, 0.012)
    return footprint, None, (), None


def produce_stand(selection):
    width, depth = 1.83, 0.74
    base = box("Stand stone footing", (0, 0, 0.046), (width, depth, 0.092), stone[0], 0.029)
    for x in (-0.83, 0.83):
        for y in (-0.28, 0.28):
            box("Produce stand leg", (x, y, 0.39), (0.15, 0.14, 0.67), posts)
    box("Produce stand lower shelf", (0, 0, 0.23), (1.79, 0.71, 0.10), oak)
    box("Produce tray", (0, 0, 0.70), (1.83, 0.70, 0.09), oak, tilt=0.26)
    for y, z in ((-0.34, 0.68), (0.34, 0.85)):
        box("Produce tray rim", (0, y, z), (1.83, 0.062, 0.21), oak)
    for x in (-0.88, -0.29, 0.29, 0.88):
        box("Produce tray divider", (x, 0, 0.77), (0.055, 0.70, 0.16), posts, tilt=0.26)
    for x in (-0.78, 0.78):
        ellipsoid("Iron tray nail", (x, -0.372, 0.68), (0.026, 0.011, 0.026), iron)
    for x in (-0.46, 0.46):
        box("Shelf crate base", (x, 0.07, 0.30), (0.61, 0.45, 0.05), posts)
        for z in (0.36, 0.45):
            for y in (-0.16, 0.30):
                box("Crate slat", (x, y, z), (0.63, 0.048, 0.076), oak, 0.01)
            for dx in (-0.30, 0.30):
                box("Crate end", (x+dx, 0.07, z), (0.044, 0.49, 0.10), posts, 0.01)

    for bin_x, kind in zip((-0.59, 0, 0.59), selection):
        if kind == 4:
            ellipsoid("Cabbage head", (bin_x, 0.095, 0.91), (0.25, 0.25, 0.23), produce[kind])
            for j in range(8):
                a = j*pi/4
                leaf = ellipsoid("Cabbage folded leaf", (bin_x+0.15*cos(a), 0.095+0.15*sin(a), 0.955),
                                 (0.12, 0.069, 0.155), leaves[j % 2])
                leaf.rotation_euler = (0.46, 0.0, a)
        else:
            radius = (0.115, 0.10, 0.078, 0.145, 0, 0.113)[kind]
            for i, (dx, y) in enumerate(((-0.14, -0.15), (0.13, -0.14), (-0.13, 0.11), (0.13, 0.12), (0, 0.23))):
                r = radius*(0.82+0.12*(i % 3))
                z = 0.748 + y*0.25 + r*0.73
                height = r*(1.2 if kind == 1 else 0.9)
                name = ("Apple", "Pear", "Plum", "Pumpkin", "Cabbage", "Tomato")[kind]
                ellipsoid(name, (bin_x+dx, y, z), (r, r, height), produce[kind])
                if kind != 2:
                    beam("Produce stem", (bin_x+dx, y, z+height-0.012), (bin_x+dx+0.015, y, z+height+0.036),
                         0.017, leaves[0], 0.013, 6)
    return base, None, (), None
