"""Mesh primitives and an orthographic sprite camera for Blender."""
import random

import bpy
from mathutils import Vector

from core.painted_materials import PLASTER, STONE, TIMBER, painted_material

rng = random.Random(114)

def finish(obj, name, mat, bevel=0):
    obj.name = name
    obj.data.materials.append(mat)
    if bevel:
        mod = obj.modifiers.new("Rounded edges", "BEVEL")
        mod.width = bevel
        mod.segments = 2
        obj.modifiers.new("Weighted normals", "WEIGHTED_NORMAL")
    return obj


def box(name, pos, size, mat, bevel=0.025, tilt=0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=pos)
    obj = bpy.context.object
    obj.dimensions = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.rotation_euler.x = tilt
    return finish(obj, name, mat, bevel)


def beam(name, start, end, width, mat, end_width=None, sides=9):
    start, end = Vector(start), Vector(end)
    bpy.ops.mesh.primitive_cone_add(vertices=sides, radius1=width, radius2=end_width or width, depth=(end-start).length, location=(start+end)/2)
    obj = bpy.context.object
    obj.rotation_euler = (end-start).to_track_quat("Z", "Y").to_euler()
    return finish(obj, name, mat, 0.02)


def prism(name, front, offset, mat):
    vertices = front + [(x+offset[0], y+offset[1], z+offset[2]) for x,y,z in front]
    sides = len(front)
    faces = [tuple(range(sides))[::-1], tuple(range(sides, sides*2))]
    faces.extend((i, (i+1) % sides, (i+1) % sides + sides, i+sides) for i in range(sides))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return finish(obj, name, mat)


plaster = painted_material("Ivory plaster", (0.81, 0.65, 0.40), PLASTER)
cedar = painted_material("Golden cedar", (0.43, 0.22, 0.093), TIMBER)
darkwood = painted_material("Dark oiled wood", (0.20, 0.084, 0.038), TIMBER)
slate = painted_material("Stone paving", (0.34, 0.38, 0.32), STONE)
stones = [painted_material("Fieldstone %d" % i, c, STONE) for i, c in enumerate([(0.32,0.37,0.32),(0.41,0.43,0.36),(0.29,0.32,0.29),(0.46,0.45,0.37)])]
