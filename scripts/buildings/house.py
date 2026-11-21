"""One-storey starter house authored on the village scale contract."""
import math

from blender_render import beam, box, bpy, cedar, darkwood, plaster, prism, rng, slate
from core.constants import GLOBAL_DOOR_HEIGHT, GLOBAL_PLINTH_HEIGHT, GLOBAL_WALL_HEIGHT
from inn import amber, pine, tiles

WIDTH = 4.75
DEPTH = 3.75
FRONT = -DEPTH / 2
EAVES = GLOBAL_PLINTH_HEIGHT + GLOBAL_WALL_HEIGHT


def house():
    floor = GLOBAL_PLINTH_HEIGHT
    foundation = box("Stone plinth", (0, 0, floor/2), (WIDTH+0.14, DEPTH+0.14, floor), slate, 0.05)
    wall = box("House walls", (0, 0, floor+GLOBAL_WALL_HEIGHT/2),
               (WIDTH, DEPTH, GLOBAL_WALL_HEIGHT), plaster)
    for x in (-WIDTH/2+0.05, -0.72, 0.7, WIDTH/2-0.05):
        box("Facade post", (x, FRONT-0.04, floor+GLOBAL_WALL_HEIGHT/2),
            (0.15, 0.15, GLOBAL_WALL_HEIGHT), cedar)
    for z in (floor+0.08, EAVES-0.1):
        box("Front timber", (0, FRONT-0.03, z), (WIDTH, 0.17, 0.13), cedar)
        box("Side timber", (WIDTH/2+0.04, 0, z), (0.15, DEPTH, 0.13), cedar)
    z = floor + GLOBAL_DOOR_HEIGHT/2
    portal = box("Door casing", (0, FRONT-0.055, z), (1.3, 0.18, GLOBAL_DOOR_HEIGHT), darkwood)
    box("Painted entrance", (0, FRONT-0.147, z), (1.10, 0.065, GLOBAL_DOOR_HEIGHT-0.13), pine)
    for x in (-0.39, -0.20, 0, 0.20, 0.39):
        box("Door board", (x, FRONT-0.186, z), (0.17, 0.034, GLOBAL_DOOR_HEIGHT-0.21), pine, 0.009)
    box("Brass latch", (0.34, FRONT-0.208, z), (0.085, 0.045, 0.10), amber, 0.013)
    for x in (-1.50, 1.49):
        window_z = floor+GLOBAL_WALL_HEIGHT*0.61
        box("Front window frame", (x, FRONT-0.047, window_z), (0.88, 0.15, 0.90), darkwood)
        box("Window glazing", (x, FRONT-0.124, window_z), (0.70, 0.04, 0.72), amber)
        box("Window mullion", (x, FRONT-0.148, window_z), (0.049, 0.039, 0.73), cedar)
        box("Window sill", (x, FRONT-0.09, window_z-0.45), (0.97, 0.24, 0.12), cedar)
    for y in (-0.86, 0.94):
        window_z = floor+GLOBAL_WALL_HEIGHT*0.61
        box("Side window frame", (WIDTH/2+0.04, y, window_z), (0.13, 0.87, 0.89), darkwood)
        box("Side window glazing", (WIDTH/2+0.113, y, window_z), (0.035, 0.69, 0.72), amber)
        box("Side window mullion", (WIDTH/2+0.13, y, window_z), (0.037, 0.052, 0.73), cedar)
    roof_start = set(bpy.context.scene.objects)
    pitch = 0.44
    overhang = 0.25
    span = WIDTH/2 + overhang
    length = DEPTH + 2*overhang
    ridge = EAVES + WIDTH/2*pitch + 0.07
    prism("Front and rear gables", [(-WIDTH/2, FRONT, EAVES), (WIDTH/2, FRONT, EAVES),
                                    (0, FRONT, ridge-0.1)], (0, DEPTH, 0), plaster)
    box("Gable stud", (0, FRONT-0.04, EAVES+0.34), (0.13, 0.13, 0.70), cedar)
    for side in (-1, 1):
        angle = side*math.atan(pitch)
        roof = box("Roof backing", (side*span/2, 0, ridge-span*pitch/2-0.062),
                   (span/math.cos(angle), length, 0.13), darkwood, 0.022)
        roof.rotation_euler.y = angle
        for row in range(7):
            x = (row+0.5)*span/7
            for col in range(11):
                y = ((col+0.5)/11-0.5)*length
                tile = box("House roof tile", (side*x, y, ridge-x*pitch),
                           (span/7/math.cos(angle)+0.03, length/11+0.014, 0.09), rng.choice(tiles), 0.025)
                tile.rotation_euler.y = angle
        for y in (-length/2, length/2):
            beam("Gable rake", (0, y, ridge), (side*span, y, ridge-span*pitch), 0.07, tiles[0], sides=8)
    beam("Ridge cap", (0, -length/2, ridge+0.038), (0, length/2, ridge+0.038), 0.09, tiles[0], sides=10)
    return foundation, wall, set(bpy.context.scene.objects)-roof_start, portal
