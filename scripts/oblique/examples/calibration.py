"""Calibration asset: a 6 x 4 x 3 m block with a hinged door, a glowing window, a gable roof
and a 1.45 m reference post. Used by tests and to check a project's projection settings."""


def build(kit):
    plaster = kit.material("Plaster", (0.81, 0.65, 0.40), kit.PLASTER)
    oak = kit.material("Oak", (0.43, 0.22, 0.09), kit.TIMBER)
    tile = kit.material("Roof tile", (0.55, 0.20, 0.10), kit.ROOF)
    glass = kit.glow_material("Window", (0.10, 0.14, 0.20), (1.0, 0.72, 0.38), strength=8)
    kit.box("Body", (0, 2, 1.5), (6, 4, 3), plaster)
    kit.box("Window", (1.8, -0.01, 1.7), (0.9, 0.04, 0.9), glass, bevel=0)
    kit.box("Doorway", (-1.2, -0.005, 1.0), (1.1, 0.02, 2.0), kit.material("Dark", (0.03, 0.02, 0.02), kit.PIGMENT), bevel=0)
    leaf = kit.box("Door leaf", (-1.2, -0.06, 1.0), (1.0, 0.06, 1.95), oak, component="door")
    kit.component(leaf, "door", hinge=((-1.7, -0.06, 0), (0, 0, 1)), angles=[0, 25, 50, 75, 100])
    kit.gable_roof("Roof", -3, 3, 0, 4, 3.0, 4.6, 0.18, tile)
    kit.box("Reference post", (-4, 0.5, 0.725), (0.25, 0.25, 1.45), oak, component="reference")
    kit.marker("door_threshold", (-1.2, -0.06, 0))
    kit.footprint("body", [(-3, 0), (3, 0), (3, 4), (-3, 4)])
