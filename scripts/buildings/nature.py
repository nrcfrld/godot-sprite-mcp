"""Stylized low-poly scenery props (trees, shrubs, rocks) in Blender coordinates.

Each factory returns (foundation, wall, roof, portal) like the building modules so
assemble.capture() can snap it to the ground and reject floating parts. Shapes are
fixed tables, never random, so renders stay deterministic.
"""
import bpy
from mathutils import Vector

from blender_render import beam, finish
from core.painted_materials import BARK, FOLIAGE, PIGMENT, PLASTER, STONE, painted_material

bark = painted_material("Bark", (0.25, 0.14, 0.07), BARK)
leaves = {
    "summer": [painted_material("Leaf green %d" % i, c, FOLIAGE) for i, c in enumerate([(0.16, 0.34, 0.10), (0.20, 0.42, 0.12), (0.12, 0.28, 0.09)])],
    "autumn": [painted_material("Leaf amber %d" % i, c, FOLIAGE) for i, c in enumerate([(0.62, 0.27, 0.06), (0.75, 0.40, 0.08), (0.52, 0.18, 0.05)])],
}
needles = [painted_material("Pine needles %d" % i, c, FOLIAGE) for i, c in enumerate([(0.06, 0.22, 0.12), (0.08, 0.27, 0.14)])]
snow = painted_material("Packed snow", (0.86, 0.90, 0.95), PLASTER)
apple = painted_material("Apple red", (0.55, 0.04, 0.03), PIGMENT, glossy=True)
stone = [painted_material("Field stone %d" % i, c, STONE) for i, c in enumerate([(0.36, 0.36, 0.34), (0.42, 0.41, 0.38)])]

# Directions that face the sprite camera (it looks from +x, -y, +z), for fruit placement.
FRONT = [Vector(v).normalized() for v in ((0.6, -0.7, 0.3), (0.2, -0.9, 0.1), (0.8, -0.3, 0.4), (-0.1, -0.8, 0.5), (0.5, -0.5, -0.2))]


def blob(name, center, radius, mat, subdivisions=2, scale=(1, 1, 1)):
    """Faceted ico-sphere: the low-poly look of the building modules."""
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdivisions, radius=radius, location=center)
    obj = bpy.context.object
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(obj, name, mat)


def root_flare(width):
    return beam("Root flare", (0, 0, 0), (0, 0, 0.3), width, bark, end_width=width * 0.62, sides=8)


# (x, y, z, radius) clusters for a broadleaf crown resting on the trunk top.
CROWN = [(0, 0, 2.35, 0.95), (0.6, 0.2, 2.05, 0.7), (-0.55, -0.1, 2.1, 0.72), (0.1, -0.45, 2.0, 0.65), (-0.1, 0.5, 2.6, 0.7), (0.15, 0.05, 2.95, 0.6)]


def broadleaf(season="summer", fruit=False):
    foundation = root_flare(0.32)
    beam("Trunk", (0, 0, 0.25), (0, 0, 1.75), 0.2, bark, end_width=0.13, sides=8)
    beam("Branch", (0, 0, 1.2), (0.45, 0.1, 1.9), 0.07, bark, end_width=0.04, sides=6)
    crown = leaves[season]
    for i, (x, y, z, r) in enumerate(CROWN):
        blob("Leaf cluster", (x, y, z), r, crown[i % len(crown)])
    if fruit:
        for i, (x, y, z, r) in enumerate(CROWN[:5]):
            spot = Vector((x, y, z)) + FRONT[i] * (r * 0.95)
            blob("Apple", tuple(spot), 0.09, apple, subdivisions=1)
    return foundation, None, (), None


def pine(snowy=False):
    foundation = root_flare(0.22)
    beam("Trunk", (0, 0, 0.25), (0, 0, 0.95), 0.14, bark, end_width=0.11, sides=8)
    for i, (z0, z1, width) in enumerate([(0.6, 2.0, 1.05), (1.4, 2.8, 0.85), (2.2, 3.5, 0.62), (2.9, 4.1, 0.38)]):
        beam("Needle tier", (0, 0, z0), (0, 0, z1), width, needles[i % len(needles)], end_width=0.02, sides=8)
        if snowy:
            # Covers the upper 70% of the tier: slightly wider than the tier at that height.
            t = 0.3
            beam("Snow cap", (0, 0, z0 + (z1 - z0) * t), (0, 0, z1 + 0.03), (width * (1 - t) + 0.02 * t) * 1.1, snow, end_width=0.03, sides=8)
    return foundation, None, (), None


def bush(season="summer"):
    crown = leaves[season]
    parts = [(0, 0, 0.5, 0.5), (0.45, 0.15, 0.4, 0.4), (-0.42, 0.05, 0.38, 0.38), (0.05, -0.35, 0.36, 0.36)]
    foundation = None
    for i, (x, y, z, r) in enumerate(parts):
        obj = blob("Shrub cluster", (x, y, z), r, crown[i % len(crown)])
        foundation = foundation or obj
    return foundation, None, (), None


def rocks():
    foundation = blob("Boulder", (0, 0, 0.325), 0.5, stone[0], subdivisions=1, scale=(1.3, 1, 0.65))
    blob("Stone", (0.62, -0.2, 0.18), 0.3, stone[1], subdivisions=1, scale=(1.1, 1, 0.6))
    return foundation, None, (), None


PROPS = {
    "oak": lambda: broadleaf("summer"),
    "autumn_oak": lambda: broadleaf("autumn"),
    "apple_tree": lambda: broadleaf("summer", fruit=True),
    "pine": lambda: pine(),
    "snowy_pine": lambda: pine(snowy=True),
    "bush": lambda: bush("summer"),
    "autumn_bush": lambda: bush("autumn"),
    "rocks": rocks,
}
