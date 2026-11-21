"""Two-story village inn with a ground-floor tavern and rooms upstairs."""

import math

from blender_render import beam, box, bpy, cedar, darkwood, material, plaster, prism, rng, slate, stones
from core.constants import (
    GLOBAL_DOOR_HEIGHT, GLOBAL_PLINTH_HEIGHT, INN_DEPTH, INN_GUEST_FLOOR_HEIGHT,
    INN_ROOF_PITCH, INN_TAPROOM_HEIGHT, INN_WIDTH,
)

FRONT = -INN_DEPTH / 2
GROUND = GLOBAL_PLINTH_HEIGHT
UPPER = GROUND + INN_TAPROOM_HEIGHT
EAVES = UPPER + INN_GUEST_FLOOR_HEIGHT
GUEST_WINDOW_Z = UPPER + INN_GUEST_FLOOR_HEIGHT * 0.46
ENTRY_X = 2.03
ENTRY_WIDTH = 1.23
BAR_X = -1.14
BAR_WIDTH = 3.36
BAR_SILL = GROUND + 0.92

pine = material("Inn shutters", (0.095, 0.22, 0.19))
amber = material("Warm room windows", (0.74, 0.37, 0.11))
brass = material("Tavern brass", (0.60, 0.35, 0.095), 0.42)
cloth = material("Claret awning", (0.42, 0.082, 0.068))
cream = material("Cream awning", (0.84, 0.65, 0.41))
shadow = material("Bar interior", (0.12, 0.064, 0.038))
carved_lid = material("Keg lid end grain", (0.50, 0.30, 0.149))
bottles = [material("Bottle " + name, color, 0.31) for name, color in [
    ("green", (0.16, 0.30, 0.13)), ("blue", (0.10, 0.26, 0.34)), ("amber", (0.5, 0.24, 0.075)),
]]
tiles = [material("Glazed roof tile " + str(i), color) for i, color in enumerate([
    (0.105, 0.23, 0.22), (0.125, 0.28, 0.25), (0.15, 0.31, 0.28), (0.12, 0.25, 0.25),
])]


def upper_window(x, z):
    box("Room window casing", (x, FRONT - 0.08, z), (1.08, 0.16, 1.19), darkwood)
    box("Warm glazing", (x, FRONT - 0.18, z), (0.83, 0.042, 0.93), amber)
    box("Window mullion", (x, FRONT - 0.218, z), (0.065, 0.062, 0.96), cedar)
    box("Window crossbar", (x, FRONT - 0.218, z), (0.85, 0.062, 0.063), cedar)
    box("Room window sill", (x, FRONT - 0.16, z - 0.575), (1.19, 0.30, 0.10), cedar)
    for side in (-1, 1):
        offset = x + side * 0.695
        box("Painted shutter", (offset, FRONT - 0.088, z), (0.27, 0.086, 1.06), pine)
        for n in (-1, 0, 1):
            box("Shutter slat", (offset + n * 0.067, FRONT - 0.141, z), (0.044, 0.022, 0.94), pine, 0.008)
        for h in (-0.29, 0.30):
            box("Shutter strap", (offset, FRONT - 0.162, z + h), (0.23, 0.035, 0.045), darkwood, 0.01)


def lower_front():
    left_edge = BAR_X - BAR_WIDTH / 2
    right_edge = BAR_X + BAR_WIDTH / 2
    bar_top = GROUND + GLOBAL_DOOR_HEIGHT + 0.23
    wall_left, wall_right = -INN_WIDTH / 2, INN_WIDTH / 2

    # Recess only the serving hatch. The larger shell spans both stories.
    for x1, x2 in [(wall_left, left_edge), (right_edge, wall_right)]:
        box("Tavern front infill", ((x1 + x2) / 2, FRONT + 0.095, (GROUND + UPPER) / 2),
            (x2 - x1, 0.19, INN_TAPROOM_HEIGHT), plaster)
    for z1, z2 in [(GROUND, BAR_SILL), (bar_top, UPPER)]:
        box("Panel around serving hatch", (BAR_X, FRONT + 0.095, (z1 + z2) / 2),
            (BAR_WIDTH, 0.19, z2 - z1), plaster)

    box("Recessed tavern back", (BAR_X, FRONT + 0.65, (BAR_SILL + bar_top) / 2),
        (BAR_WIDTH, 0.24, bar_top - BAR_SILL), shadow)
    for x in (left_edge, right_edge):
        box("Serving hatch jamb", (x, FRONT - 0.06, (BAR_SILL + bar_top) / 2),
            (0.16, 0.24, bar_top - BAR_SILL + 0.15), darkwood)
    box("Serving hatch head", (BAR_X, FRONT - 0.06, bar_top), (BAR_WIDTH + 0.18, 0.24, 0.14), darkwood)
    box("Oak serving counter", (BAR_X, FRONT - 0.15, BAR_SILL), (BAR_WIDTH + 0.25, 0.63, 0.16), cedar, 0.048)
    for i in range(12):
        x = BAR_X + (i - 5.5) * 0.27
        box("Counter apron plank", (x, FRONT - 0.074, GROUND + 0.46), (0.257, 0.16, 0.72), darkwood if i % 3 else cedar)

    for level in (BAR_SILL + 0.18, BAR_SILL + 0.62):
        box("Tavern bottle shelf", (BAR_X, FRONT + 0.42, level), (2.86, 0.31, 0.075), cedar)
        for i in range(8):
            x = BAR_X + (i - 3.5) * 0.335
            body = 0.105 + (i % 3) * 0.011
            y = FRONT + 0.33
            base = level + 0.038
            mat = bottles[i % len(bottles)]
            beam("Bottle body", (x, y, base), (x, y, base + 0.18), body/2, mat, sides=9)
            beam("Bottle shoulder", (x, y, base + 0.18), (x, y, base + 0.26), body/2, mat, body/4, 9)
            beam("Bottle neck", (x, y, base + 0.25), (x, y, base + 0.312), body/4, mat, sides=9)
    for x in (-1.84, -0.39):
        beam("Tankard on counter", (x, FRONT - 0.23, BAR_SILL + 0.08),
            (x, FRONT - 0.23, BAR_SILL + 0.22), 0.067, brass, 0.079, 12)

    # A striped canopy and its rail frame the open counter.
    canopy_depth = 0.51
    canopy_y = FRONT - canopy_depth / 2
    canopy_z = bar_top + 0.12
    for i in range(9):
        x = BAR_X + (i - 4) * 0.40
        fabric = cloth if i % 2 == 0 else cream
        box("Striped tavern awning", (x, canopy_y, canopy_z), (0.40, canopy_depth, 0.066), fabric, 0.016, 0.23)
        box("Awning valance", (x, canopy_y - 0.25, canopy_z - 0.089), (0.389, 0.063, 0.080), fabric, 0.014)
    box("Awning front rail", (BAR_X, canopy_y - 0.23, canopy_z - 0.075), (3.62, 0.060, 0.06), cedar)

    door_z = GROUND + GLOBAL_DOOR_HEIGHT / 2
    portal = box("Inn doorway casing", (ENTRY_X, FRONT - 0.06, door_z),
                 (ENTRY_WIDTH + 0.20, 0.16, GLOBAL_DOOR_HEIGHT), darkwood, 0.037)
    box("Recessed entrance", (ENTRY_X, FRONT - 0.16, door_z),
        (ENTRY_WIDTH - 0.05, 0.11, GLOBAL_DOOR_HEIGHT - 0.14), pine, 0.029)
    for i in range(6):
        x = ENTRY_X + (i - 2.5) * 0.174
        box("Door plank", (x, FRONT - 0.218, door_z - 0.12),
            (0.155, 0.038, GLOBAL_DOOR_HEIGHT - 0.43), pine, 0.012)
    box("Door transom", (ENTRY_X, FRONT - 0.235, GROUND + GLOBAL_DOOR_HEIGHT * 0.81),
        (0.84, 0.045, 0.32), amber, 0.017)
    for side in (-1, 0, 1):
        box("Transom mullion", (ENTRY_X + side*0.23, FRONT - 0.261, GROUND + GLOBAL_DOOR_HEIGHT * 0.81),
            (0.045, 0.035, 0.33), cedar, 0.01)
    box("Brass door latch", (ENTRY_X + 0.33, FRONT - 0.268, GROUND + GLOBAL_DOOR_HEIGHT * 0.46),
        (0.087, 0.06, 0.12), brass, 0.013)

    # A tankard pictogram identifies the tavern at sprite scale.
    sign_y = FRONT - 0.55
    sign_z = UPPER - 0.33
    box("Sign bracket", (1.11, FRONT - 0.24, sign_z + 0.68),
        (0.14, 0.66, 0.095), darkwood)
    for x in (0.82, 1.38):
        beam("Sign hangers", (x, sign_y, sign_z + 0.35), (x, sign_y, sign_z + 0.67), 0.026, darkwood)
    box("Tavern sign casing", (1.10, sign_y, sign_z), (0.92, 0.16, 0.73), darkwood, 0.10)
    box("Sign inset", (1.10, sign_y - 0.091, sign_z), (0.75, 0.056, 0.58), pine, 0.066)
    box("Tankard pictogram", (1.04, sign_y - 0.133, sign_z - 0.02), (0.25, 0.051, 0.29), brass, 0.038)
    box("Tankard foam", (1.04, sign_y - 0.139, sign_z + 0.12), (0.26, 0.064, 0.071), cream, 0.022)
    for z in (sign_z - 0.093, sign_z + 0.054):
        box("Tankard handle", (1.21, sign_y - 0.131, z), (0.13, 0.048, 0.044), brass, 0.014)
    box("Tankard handle", (1.26, sign_y - 0.131, sign_z - 0.018), (0.047, 0.044, 0.15), brass, 0.012)
    return portal


def inn():
    foundation = box("Inn stone foundation", (0, 0, GROUND/2), (INN_WIDTH + 0.22, INN_DEPTH + 0.21, GROUND), slate, 0.075)
    # This continuous rear core supplies the bounding-box reference for sockets.
    shell_height = INN_TAPROOM_HEIGHT + INN_GUEST_FLOOR_HEIGHT
    shell_middle = GROUND + shell_height / 2
    wall = box("Inn rear core", (0, 0.35, shell_middle),
               (INN_WIDTH, INN_DEPTH - 0.70, shell_height), plaster, 0.042)
    for side in (-1, 1):
        box("Inn front wall return", (side * (INN_WIDTH/2 - 0.11), FRONT + 0.42, shell_middle),
            (0.22, 0.71, shell_height), plaster, 0.023)
    box("Inn upper facade", (0, FRONT + 0.20, (UPPER + EAVES)/2),
        (INN_WIDTH, 0.41, INN_GUEST_FLOOR_HEIGHT), plaster, 0.029)
    portal = lower_front()
    for x in (-INN_WIDTH/2 + 0.07, 0.82, INN_WIDTH/2 - 0.07):
        box("Facade post", (x, FRONT - 0.067, shell_middle), (0.15, 0.17, shell_height), cedar)
    for z in (UPPER - 0.04, UPPER + 0.14, EAVES - 0.15):
        box("Front story beam", (0, FRONT - 0.06, z), (INN_WIDTH + 0.11, 0.19, 0.155), cedar)
        box("Side story beam", (INN_WIDTH/2 + 0.04, 0, z), (0.18, INN_DEPTH, 0.155), cedar)
    for x in (-2.13, 0, 2.13):
        upper_window(x, GUEST_WINDOW_Z)
    for bay in (-1.5, -0.5, 0.5, 1.5):
        y = bay * INN_DEPTH * 0.225
        for z, w, h in [
            (GROUND + INN_TAPROOM_HEIGHT * 0.51, 0.64, 0.91),
            (GUEST_WINDOW_Z, 0.72, 1.00),
        ]:
            x = INN_WIDTH/2
            box("Side window casing", (x + 0.051, y, z), (0.15, w, h), darkwood)
            box("Side window glass", (x + 0.14, y, z), (0.042, w - 0.13, h - 0.13), amber)
            box("Side window mullion", (x + 0.167, y, z), (0.043, 0.046, h - 0.10), cedar)
            box("Side window crossbar", (x + 0.167, y, z), (0.043, w - 0.10, 0.048), cedar)
            box("Side sill", (x + 0.116, y, z-h/2), (0.26, w + 0.09, 0.081), cedar)
    for i in range(14):
        x = (i - 6.5)*0.441
        box("Facing foundation stone", (x, FRONT - 0.076, GROUND*0.56),
            (0.421, 0.16, GROUND*0.74), rng.choice(stones), 0.035)

    roof_start = set(bpy.context.scene.objects)
    pitch = INN_ROOF_PITCH
    ridge = EAVES + INN_WIDTH/2*pitch + 0.06
    eave_overhang = 0.25
    gable_overhang = 0.17
    span = INN_WIDTH/2 + eave_overhang
    roof_length = INN_DEPTH + 2*gable_overhang
    # Expose the gable above the entrance so the deeper roof reads in depth,
    # rather than as a single expanse of tiles hanging over the front windows.
    prism("Attic gable", [(-INN_WIDTH/2, FRONT, EAVES), (INN_WIDTH/2, FRONT, EAVES),
                         (0, FRONT, ridge - 0.12)], (0, INN_DEPTH, 0), plaster)
    box("Attic gable tie", (0, FRONT - 0.05, EAVES + 0.012), (INN_WIDTH, 0.16, 0.15), darkwood)
    box("Attic timber", (0, FRONT - 0.063, EAVES + 0.38), (0.14, 0.15, 0.56), cedar)
    for x in (-1.33, 1.33):
        box("Gable brace", (x, FRONT - 0.051, EAVES + 0.21), (0.13, 0.13, 0.35), cedar)
    for side in (-1, 1):
        angle = side * math.atan(pitch)
        boards = box("Continuous roof boards", (side*span/2, 0, ridge - span*pitch/2 - 0.075),
                     (span / math.cos(angle), roof_length, 0.13), darkwood, 0.027)
        boards.rotation_euler.y = angle
        for row in range(9):
            across = span*(row+0.5)/9
            for col in range(17):
                depth = (col - 8) * roof_length/17
                shingle = box("Glazed slate shingle", (side*across, depth, ridge - across*pitch),
                              (span/9/math.cos(angle)+0.033, roof_length/17+0.013, 0.095),
                              rng.choice(tiles), 0.036)
                shingle.rotation_euler.y = angle
        for depth in (-roof_length/2, roof_length/2):
            beam("Gable rake trim", (0, depth, ridge + 0.018), (side*span, depth, ridge - span*pitch + 0.018),
                 0.077, tiles[0], sides=9)
        box("Eave trim", (side*span, 0, ridge-span*pitch+0.016), (0.12, roof_length + 0.07, 0.11), tiles[0])
    beam("Glazed ridge cap", (0, -roof_length/2, ridge+0.047), (0, roof_length/2, ridge+0.047),
         0.105, tiles[0], sides=12)
    return foundation, wall, set(bpy.context.scene.objects) - roof_start, portal


def entry_steps():
    lower = GLOBAL_PLINTH_HEIGHT * 0.58
    width = ENTRY_WIDTH + 0.43
    foundation = box("Lower inn step", (0, -0.20, lower/2), (width, 0.72, lower), stones[1], 0.04)
    box("Inn landing", (0, -0.026, (lower + GLOBAL_PLINTH_HEIGHT)/2),
        (width - 0.14, 0.36, GLOBAL_PLINTH_HEIGHT - lower), slate, 0.036)
    return foundation, None, (), None


def taproom_kegs():
    """A grounded prop group for the exterior of the bar."""
    foundation = box("Keg stand", (0, 0, 0.045), (0.99, 0.66, 0.09), darkwood, 0.04)
    for x, depth, size in ((-0.23, 0.035, 1.0), (0.25, -0.10, 0.81)):
        base, h, radius = 0.09, 0.63 * size, 0.236 * size
        beam("Keg lower staves", (x, depth, base), (x, depth, base+h*0.50),
             radius*0.84, cedar, radius, 14)
        beam("Keg upper staves", (x, depth, base+h*0.50), (x, depth, base+h),
             radius, cedar, radius*0.84, 14)
        for factor in (0.18, 0.81):
            z = base+h*factor
            beam("Iron keg hoop", (x, depth, z-0.035), (x, depth, z+0.035),
                 radius*0.945, darkwood, sides=14)
        beam("Recessed keg lid", (x, depth, base+h-0.01), (x, depth, base+h+0.014),
             radius*0.76, carved_lid, sides=14)
    return foundation, None, (), None
