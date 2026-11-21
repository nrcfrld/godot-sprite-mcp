extends SceneTree
## Run with Godot's real renderer (not --headless) in a project with the
## exported Inn ground floor at res://floors/village_inn_ground.tscn.

class Probe extends Node2D:
	func _draw() -> void:
		draw_rect(Rect2(-5, -28, 10, 28), Color(1, 0, 1))

var viewport: SubViewport
var masks: Dictionary = {}

func _initialize() -> void:
	call_deferred("run_audit")

func run_audit() -> void:
	viewport = SubViewport.new()
	viewport.size = Vector2i(576, 576)
	viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	root.add_child(viewport)
	var arguments := OS.get_cmdline_user_args()
	var path := arguments[0] if not arguments.is_empty() else "res://floors/village_inn_ground.tscn"
	var packed := load(path) as PackedScene
	if packed == null:
		return fail_audit("Generated ground scene did not load")
	var room := packed.instantiate()
	viewport.add_child(room)
	var sort_root := room.get_node("YSort") as Node2D
	if not sort_root.y_sort_enabled:
		return fail_audit("Furniture lacks a Y-sorted parent")
	for piece in sort_root.get_children():
		var sprite := piece as Sprite2D
		var texture := sprite.texture
		if texture is CanvasTexture:
			texture = texture.diffuse_texture
		masks[sprite.name] = [Vector2i((sprite.position + sprite.offset).round()), texture.get_image()]

	var probe := Probe.new()
	sort_root.add_child(probe)
	for name in ["round_table", "bar_counter"]:
		var target := sort_root.get_node(name) as Sprite2D
		if target.centered or target.position == target.position + target.offset or target.z_index != probe.z_index:
			return fail_audit("Invalid foot-pivot configuration for " + name)
		var summary := await audit_orbit(probe, target)
		if not summary.is_empty():
			return fail_audit(summary)
	quit()

func audit_orbit(probe: Node2D, target: Sprite2D) -> String:
	var front_frames := 0
	var back_frames := 0
	var front_pixels := 0
	var back_pixels := 0
	var bad_pixels := 0
	# The path spans both sides of the sort origin. Pixels overlapping unrelated
	# sprites are excluded so the test isolates this object's draw order.
	var radius_x := 26.0 if target.name == "round_table" else 49.0
	for step in range(48):
		var angle := TAU * (step + 0.5) / 48.0
		probe.position = (target.position + Vector2(cos(angle) * radius_x, sin(angle) * 13.0)).round()
		if absf(probe.position.y - target.position.y) <= 1.0:
			continue
		await process_frame
		await RenderingServer.frame_post_draw
		var rendered := viewport.get_texture().get_image()
		if rendered == null or rendered.is_empty():
			return "Godot produced no GPU-rendered viewport pixels"
		var front := probe.position.y > target.position.y
		var checked := 0
		for y in range(int(probe.position.y) - 26, int(probe.position.y) - 2):
			for x in range(int(probe.position.x) - 3, int(probe.position.x) + 3):
				var pixel := Vector2i(x, y)
				if not isolated_opaque_pixel(target.name, pixel):
					continue
				var color := rendered.get_pixelv(pixel)
				var visible := color.r > 0.88 and color.b > 0.88 and color.g < 0.12
				checked += 1
				if visible != front:
					bad_pixels += 1
		if checked > 0:
			if front:
				front_frames += 1
				front_pixels += checked
			else:
				back_frames += 1
				back_pixels += checked
	print(JSON.stringify({
		"asset": target.name, "frontFrames": front_frames, "backFrames": back_frames,
		"frontPixels": front_pixels, "backPixels": back_pixels, "unexpectedPixels": bad_pixels,
	}))
	if front_frames < 3 or back_frames < 3:
		return "Insufficient visible overlap in orbit around " + str(target.name)
	if bad_pixels > 0:
		return "Incorrect overlap pixels while walking around " + str(target.name)
	return ""

func isolated_opaque_pixel(target: StringName, pixel: Vector2i) -> bool:
	for d in [Vector2i.ZERO, Vector2i(-1, 0), Vector2i(1, 0), Vector2i(0, -1), Vector2i(0, 1)]:
		if alpha_at(target, pixel + d) < 0.99:
			return false
	for name in masks:
		if name != target and alpha_at(name, pixel) > 0:
			return false
	return true

func alpha_at(name: StringName, pixel: Vector2i) -> float:
	var origin: Vector2i = masks[name][0]
	var image: Image = masks[name][1]
	var p := pixel - origin
	if not Rect2i(Vector2i.ZERO, image.get_size()).has_point(p):
		return 0.0
	return image.get_pixelv(p).a

func fail_audit(message: String) -> void:
	printerr(message)
	quit(1)
