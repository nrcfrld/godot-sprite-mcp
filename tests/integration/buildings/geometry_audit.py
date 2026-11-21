"""Exercise the authored Blender building modules on the shared camera."""
from dataclasses import replace
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path.cwd() / "scripts/buildings"))

import assemble
from assemble import bounds, capture, sprite_point
from blender_render import bpy, box, cedar
from church import nave
from core.constants import GLOBAL_DOOR_HEIGHT
from core.scene_setup import ORTHOGRAPHIC_SCALE, configure_sprite_scene, render_sprite
from inn import inn, taproom_kegs
from inn_interior import DECK, floor_plan
from layout import Point


def reset():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)


def audit_scale(output):
    report = []
    for name, factory in (("chapel", lambda: nave("none")), ("inn", inn), ("kegs", taproom_kegs)):
        reset()
        model = capture(name, factory)
        scene = configure_sprite_scene()
        bpy.context.view_layer.update()
        portal = bounds((model.portal,)) if model.portal is not None else None
        model_bounds = bounds(model.objects)
        floor = bounds((model.foundation,))
        contact = Point(floor.center.x, floor.low.y, floor.center.z)
        sample = portal or model_bounds
        x, depth = sample.center.x, sample.center.z
        top_pixel = sprite_point(scene, Point(x, sample.high.y, depth))[1]
        bottom_pixel = sprite_point(scene, Point(x, sample.low.y, depth))[1]
        report.append({
            "id": name,
            "orthoPixelsPerUnit": scene.render.resolution_x / ORTHOGRAPHIC_SCALE,
            "boundsHeight": round(sample.size.y, 5),
            "projectedHeightPixels": round(bottom_pixel - top_pixel, 4),
            "contact": sprite_point(scene, contact),
        })
        if name == "kegs":
            render_sprite(output / "kegs.png", scene)
    assert report[0]["boundsHeight"] == report[1]["boundsHeight"] == GLOBAL_DOOR_HEIGHT, report
    assert abs(report[0]["projectedHeightPixels"] - report[1]["projectedHeightPixels"]) < 0.001, report
    assert 0.30 < report[2]["boundsHeight"] / GLOBAL_DOOR_HEIGHT < 0.40, report

    reset()
    scene = configure_sprite_scene()
    pivots = {}
    for fixture in floor_plan("ground").fixtures:
        if fixture.name not in ("round_table", "bar_counter"):
            continue
        model = capture(fixture.name, fixture.build)
        model.place(Point(fixture.x, DECK, fixture.depth))
        foot = bounds((model.foundation,))
        assert abs(foot.low.y-DECK) < 1e-5, (fixture.name, foot)
        pivots[fixture.name] = sprite_point(scene, Point(foot.center.x, foot.low.y, foot.center.z))
    (output / "scale.json").write_text(json.dumps({"assets": report, "fixturePivots": pivots}, indent=2) + "\n")
    print(json.dumps({"assets": report, "fixturePivots": pivots}))


def audit_stress():
    reset()
    plan = floor_plan("ground")
    moved = tuple(replace(fixture, x=2.03, depth=-1.83) if fixture.name == "round_table" else fixture
                  for fixture in plan.fixtures)
    original = assemble.floor_plan
    assemble.floor_plan = lambda _level: replace(plan, fixtures=moved)
    try:
        try:
            assemble.inn_interior_layout("ground")
        except ValueError as error:
            assert "round_table" in str(error) and "blocks Entry and stair approach" in str(error), error
            print("Door blockage rejected:", error)
        else:
            raise AssertionError("Engine accepted the blocked entry")
    finally:
        assemble.floor_plan = original

    reset()

    def unsupported_prop():
        foot = box("Floor base", (0, 0, 0.10), (1, 1, 0.20), cedar)
        box("Disconnected beam", (0, 0, 1.20), (0.18, 0.18, 0.34), cedar)
        return foot, None, (), None

    try:
        capture("Floating part probe", unsupported_prop)
    except ValueError as error:
        assert "Unsupported geometry" in str(error) and "Disconnected beam" in str(error), error
        print("Floating part rejected:", error)
    else:
        raise AssertionError("Engine accepted a beam without a contact chain to the foundation")


if __name__ == "__main__":
    destination = Path(sys.argv[sys.argv.index("--") + 1])
    destination.mkdir(parents=True, exist_ok=True)
    audit_scale(destination)
    audit_stress()
