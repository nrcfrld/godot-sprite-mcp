"""Matte procedural color for reading 3D meshes as illustrated sprites."""
from dataclasses import dataclass

from blender_render import material


@dataclass(frozen=True)
class Paint:
    scale: tuple[float, float, float]
    # Three color swatches across the brush pattern, relative to the base pigment.
    shade: tuple[float, float, float]
    distortion: float = 0.21


FLOORBOARD = Paint((22, 2.0, 12), (0.57, 0.95, 1.18), 0.38)
TIMBER = Paint((2.6, 10, 16), (0.53, 0.94, 1.19), 0.28)
POST = Paint((15, 13, 2.7), (0.53, 0.95, 1.16), 0.30)
PLASTER = Paint((2.3, 2.3, 3.2), (0.74, 0.98, 1.14), 0.18)
TEXTILE = Paint((7.5, 12, 10), (0.71, 0.98, 1.12), 0.28)
PIGMENT = Paint((9.5, 9.5, 8.0), (0.73, 0.98, 1.13), 0.24)


def shade(color, multiplier, tint):
    return (*(min(1, channel * multiplier * hue) for channel, hue in zip(color, tint)), 1)


def painted_material(name, color, paint):
    mat = material(name, color, roughness=1.0)
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    shader = nodes.get("Principled BSDF")
    # Broad diffuse value holds the form. Near-zero specular keeps the
    # wooden and cloth highlights in the paint pattern rather than a sheen.
    shader.inputs["Specular IOR Level"].default_value = 0.035
    shader.inputs["Coat Weight"].default_value = 0
    shader.inputs["Emission Strength"].default_value = 0.14

    position = nodes.new("ShaderNodeNewGeometry")
    stretch = nodes.new("ShaderNodeVectorMath")
    stretch.operation = "MULTIPLY"
    stretch.inputs[1].default_value = paint.scale
    links.new(position.outputs["Position"], stretch.inputs[0])

    strokes = nodes.new("ShaderNodeTexNoise")
    strokes.label = "Uneven brush strokes"
    strokes.inputs["Scale"].default_value = 1
    strokes.inputs["Detail"].default_value = 2.2
    strokes.inputs["Roughness"].default_value = 0.58
    strokes.inputs["Distortion"].default_value = paint.distortion
    links.new(stretch.outputs["Vector"], strokes.inputs["Vector"])

    paper = nodes.new("ShaderNodeTexNoise")
    paper.label = "Fine pigment flecks"
    paper.inputs["Scale"].default_value = 33
    paper.inputs["Detail"].default_value = 1
    links.new(position.outputs["Position"], paper.inputs["Vector"])

    mix = nodes.new("ShaderNodeMixRGB")
    mix.inputs[0].default_value = 0.15
    links.new(strokes.outputs["Fac"], mix.inputs[1])
    links.new(paper.outputs["Fac"], mix.inputs[2])

    tones = nodes.new("ShaderNodeValToRGB")
    tones.label = "Paint swatches"
    stops = (tones.color_ramp.elements[0], tones.color_ramp.elements.new(0.49), tones.color_ramp.elements[-1])
    tints = ((0.95, 0.99, 1.09), (1.0, 1.0, 1.0), (1.07, 1.02, 0.93))
    for element, location, modifier, tint in zip(stops, (0.28, 0.49, 0.72), paint.shade, tints):
        element.position = location
        element.color = shade(color, modifier, tint)
    links.new(mix.outputs["Color"], tones.inputs["Fac"])
    links.new(tones.outputs["Color"], shader.inputs["Base Color"])
    links.new(tones.outputs["Color"], shader.inputs["Emission Color"])
    return mat
