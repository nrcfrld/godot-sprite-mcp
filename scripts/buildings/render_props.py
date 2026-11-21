"""Render scenery props with the shared building camera. Run with Blender; arguments follow --.

    blender --background --factory-startup --python render_props.py -- --output-dir DIR [--props oak,pine]
"""
import argparse
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

from assemble import capture
from blender_render import bpy
from core.scene_setup import configure_sprite_scene, render_sprite
from nature import PROPS


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--props", default=",".join(PROPS), help="Comma-separated prop ids (default: all)")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    names = [n for n in args.props.split(",") if n]
    unknown = [n for n in names if n not in PROPS]
    if unknown:
        parser.error(f"unknown props: {', '.join(unknown)}; known: {', '.join(PROPS)}")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for name in names:
        bpy.ops.object.select_all(action="SELECT")
        bpy.ops.object.delete(use_global=False)
        capture(name, PROPS[name])  # snaps to Z=0 and rejects floating parts
        scene = configure_sprite_scene()
        bpy.context.view_layer.update()
        render_sprite(args.output_dir / f"{name}.png", scene)


if __name__ == "__main__":
    main()
