"""Authoring kit for oblique (three-quarter, front-facade) sprite assets.

An asset script is a plain Python file that defines ``build(kit)``. It models the asset in
meters with +X to the right, +Y away from the viewer (depth) and +Z up, standing on Z = 0
with the ground pivot at the world origin. The renderer (render_oblique.py) then shears the
finished scene into the oblique projection and renders every component and pass.

Example::

    def build(kit):
        wall = kit.material("Plaster", (0.81, 0.65, 0.40), kit.PLASTER)
        kit.box("Body", (0, 2, 1.5), (6, 4, 3), wall, component="body")
        door = kit.box("Leaf", (0.5, 0.02, 1.0), (1.0, 0.06, 2.0), kit.material("Oak", (0.4, 0.2, 0.1), kit.TIMBER))
        kit.component(door, "door", hinge=((0, 0.02, 0), (0, 0, 1)), angles=[0, 25, 50, 75, 100])
        kit.marker("entrance", (0.5, -0.4, 0))

Only painted materials are available (see core/painted_materials.py and the Render
Quality rules in AGENTS.md): ``kit.material`` and ``kit.glow_material`` wrap them.
"""
import math
import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "buildings"))

from core.painted_materials import (  # noqa: E402  (path set above)
    BARK, FLOORBOARD, FOLIAGE, PIGMENT, PLASTER, POST, ROOF, STONE, TEXTILE, TIMBER, Paint, painted_material,
)

COMPONENT_KEY = "oblique_component"
GLOW_KEY = "oblique_glow"

_components = {}
_markers = {}
_footprints = {}
_bounds = []

# Frame being built for animated assets (module-level FRAMES > 1); always 0 otherwise.
frame = 0


def reset():
    _components.clear()
    _markers.clear()
    _footprints.clear()
    _bounds.clear()


# --- materials -------------------------------------------------------------------------

def material(name, color, paint=PLASTER, glossy=False):
    """A painted material. ``color`` is linear RGB (0..1)."""
    return painted_material(name, color, paint, glossy)


def glow_material(name, color, glow, strength=6.0, paint=PIGMENT):
    """A painted material that lights up in the emission pass (windows, lanterns).

    ``color`` is its daytime look in the color pass; ``glow`` (linear RGB) and ``strength``
    define the light it gives off at night. The color pass never shows the glow.
    """
    mat = painted_material(name, color, paint, glossy=True)
    mat[GLOW_KEY] = (*glow, strength)
    return mat


# --- geometry --------------------------------------------------------------------------

def _finish(obj, name, mat, bevel, component):
    obj.name = name
    if mat is not None:
        obj.data.materials.append(mat)
    if bevel:
        mod = obj.modifiers.new("Rounded edges", "BEVEL")
        mod.width = bevel
        mod.segments = 2
        obj.modifiers.new("Weighted normals", "WEIGHTED_NORMAL")
    obj[COMPONENT_KEY] = component
    return obj


def box(name, center, size, mat, bevel=0.02, component="body"):
    bpy.ops.mesh.primitive_cube_add(size=1, location=center)
    obj = bpy.context.object
    obj.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return _finish(obj, name, mat, bevel, component)


def cylinder(name, center, radius, depth, mat, vertices=16, axis="Z", bevel=0.0, component="body"):
    rotation = {"X": (0, math.pi / 2, 0), "Y": (math.pi / 2, 0, 0), "Z": (0, 0, 0)}[axis]
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=center, rotation=rotation)
    obj = bpy.context.object
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return _finish(obj, name, mat, bevel, component)


def sphere(name, center, radius, mat, subdivisions=2, scale=(1, 1, 1), component="body"):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdivisions, radius=radius, location=center)
    obj = bpy.context.object
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    bpy.ops.object.shade_smooth()
    return _finish(obj, name, mat, 0, component)


def prism(name, outline, offset, mat, component="body"):
    """Extrude a closed polygon ``outline`` (list of 3D points) along ``offset``.

    Use it for gable ends, roof slabs and anything that is a profile pushed along an axis.
    """
    front = [tuple(p) for p in outline]
    back = [(x + offset[0], y + offset[1], z + offset[2]) for x, y, z in front]
    n = len(front)
    faces = [tuple(range(n))[::-1], tuple(range(n, 2 * n))]
    faces.extend((i, (i + 1) % n, (i + 1) % n + n, i + n) for i in range(n))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(front + back, [], faces)
    mesh.validate()
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    # Consistent outward normals whatever the outline winding.
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    obj.select_set(False)
    return _finish(obj, name, mat, 0, component)


def gable_roof(name, x0, x1, y0, y1, eave_z, ridge_z, thickness, mat, overhang=0.3, component="roof"):
    """A two-slope roof whose ridge runs along X (left to right), the common front-gable-less house roof.

    Slopes face the viewer (-Y) and away (+Y). ``overhang`` extends past every wall edge.
    """
    xa, xb = x0 - overhang, x1 + overhang
    ya, yb = y0 - overhang, y1 + overhang
    ym = (y0 + y1) / 2
    drop = (ridge_z - eave_z) * overhang / max(1e-6, ym - y0)
    za = eave_z - drop
    profile = [(xa, ya, za), (xa, ym, ridge_z), (xa, yb, za), (xa, yb, za - thickness), (xa, ym, ridge_z - thickness), (xa, ya, za - thickness)]
    return prism(name, profile, (xb - xa, 0, 0), mat, component=component)


def join(name, objects):
    """Merge several objects (same component) into one."""
    if not objects:
        raise ValueError("join() needs at least one object")
    component = objects[0].get(COMPONENT_KEY, "body")
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.convert(target="MESH")
    bpy.ops.object.join()
    joined = bpy.context.view_layer.objects.active
    joined.name = name
    joined[COMPONENT_KEY] = component
    return joined


# --- metadata --------------------------------------------------------------------------

def component(objects, name, hinge=None, angles=None, sort_offset=0):
    """Assign objects to a component and optionally make it a hinged, multi-pose component.

    ``hinge`` is ``(point, axis)`` in meters; ``angles`` (degrees, positive = counter-clockwise
    seen from the axis tip) renders one frame per angle, e.g. a door's opening sequence.
    """
    if not isinstance(objects, (list, tuple)):
        objects = [objects]
    for obj in objects:
        obj[COMPONENT_KEY] = name
    spec = _components.setdefault(name, {"name": name})
    if hinge is not None:
        point, axis = hinge
        spec["hinge"] = {"point": list(point), "axis": list(Vector(axis).normalized())}
        spec["angles"] = list(angles or [0])
    spec["sort_offset"] = sort_offset
    return objects


def marker(name, location):
    """A named point (meters) reported in world units relative to the ground pivot, e.g. a door threshold."""
    _markers[name] = list(location)


def footprint(name, points):
    """A ground polygon (list of (x, y) meters at Z = 0) reported projected, e.g. collision."""
    _footprints[name] = [list(p) for p in points]


def bounds(low, high):
    """Fix the rendered canvas to this box (meters, before projection) instead of fitting the geometry.

    Required by animated assets so every frame shares one canvas and ground anchor.
    """
    _bounds[:] = [tuple(low), tuple(high)]


def canvas(left, top, right, bottom):
    """Fix the rendered canvas in projected world units relative to the ground pivot (x right, y down).

    Easier than bounds() for oblique assets: a box in meters grows a lot once sheared.
    """
    _bounds[:] = [("canvas", left, top, right, bottom)]


def metadata():
    return {"components": dict(_components), "markers": dict(_markers), "footprints": dict(_footprints)}
