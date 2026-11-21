extends SceneTree
## Loads every generated resource in the readiness project and checks it is usable.
## Run after `--import`: godot --headless --path <project> --script res://readiness_verify.gd
## Prints one line `READINESS_RESULT {json}` and exits 1 if anything failed.

var loaded := 0
var failed: Array[String] = []
var details := {}


func _initialize() -> void:
	call_deferred("run")


func run() -> void:
	for path in walk("res://"):
		if path.ends_with(".tres"):
			check_resource(path)
		elif path.ends_with(".tscn"):
			check_scene(path)
		elif path.ends_with(".png"):
			check_texture(path)
	print("READINESS_RESULT ", JSON.stringify({"loaded": loaded, "failed": failed, "details": details}))
	quit(0 if failed.is_empty() else 1)


func walk(dir_path: String) -> Array[String]:
	var out: Array[String] = []
	var dir := DirAccess.open(dir_path)
	if dir == null:
		return out
	for name in dir.get_directories():
		if not name.begins_with("."):
			out.append_array(walk(dir_path.path_join(name)))
	for name in dir.get_files():
		out.append(dir_path.path_join(name))
	out.sort()
	return out


func fail(path: String, why: String) -> void:
	failed.append("%s: %s" % [path, why])


func check_texture(path: String) -> void:
	var tex := load(path) as Texture2D
	if tex == null or tex.get_width() <= 0:
		fail(path, "texture did not import")
		return
	loaded += 1


func check_atlas_frame(path: String, tex: Texture2D, where: String) -> bool:
	if tex == null:
		fail(path, "%s has no texture" % where)
		return false
	if tex is AtlasTexture:
		var atlas := (tex as AtlasTexture).atlas
		if atlas == null:
			fail(path, "%s AtlasTexture has no atlas" % where)
			return false
		var region := (tex as AtlasTexture).region
		var size := Vector2(atlas.get_width(), atlas.get_height())
		if region.position.x < 0 or region.position.y < 0 or region.end.x > size.x or region.end.y > size.y:
			fail(path, "%s region %s outside atlas %s" % [where, region, size])
			return false
		if atlas is CanvasTexture:
			var canvas := atlas as CanvasTexture
			if canvas.diffuse_texture == null:
				fail(path, "%s CanvasTexture has no diffuse texture" % where)
				return false
			if canvas.normal_texture == null:
				fail(path, "%s CanvasTexture has no normal texture" % where)
				return false
	if tex.get_width() <= 0 or tex.get_height() <= 0:
		fail(path, "%s texture has zero size" % where)
		return false
	return true


func check_resource(path: String) -> void:
	var res := load(path)
	if res == null:
		fail(path, "failed to load")
		return
	if res is SpriteFrames:
		var frames := res as SpriteFrames
		var names := frames.get_animation_names()
		if names.is_empty():
			fail(path, "SpriteFrames has no animations")
			return
		var total := 0
		for anim in names:
			var count := frames.get_frame_count(anim)
			if count == 0:
				fail(path, "animation %s has no frames" % anim)
				return
			for i in count:
				if not check_atlas_frame(path, frames.get_frame_texture(anim, i), "%s[%d]" % [anim, i]):
					return
			total += count
		details[path] = {"animations": names.size(), "frames": total}
	loaded += 1


func check_scene(path: String) -> void:
	var packed := load(path) as PackedScene
	if packed == null:
		fail(path, "failed to load PackedScene")
		return
	var root := packed.instantiate()
	if root == null:
		fail(path, "failed to instantiate")
		return
	var sprites := 0
	var stack: Array[Node] = [root]
	while not stack.is_empty():
		var node: Node = stack.pop_back()
		stack.append_array(node.get_children())
		if node is Sprite2D:
			sprites += 1
			if not check_atlas_frame(path, (node as Sprite2D).texture, "Sprite2D %s" % node.name):
				root.free()
				return
		elif node is AnimatedSprite2D:
			var frames := (node as AnimatedSprite2D).sprite_frames
			if frames == null:
				fail(path, "AnimatedSprite2D %s has no SpriteFrames" % node.name)
				root.free()
				return
	details[path] = {"nodes": count_nodes(root), "sprites": sprites}
	root.free()
	loaded += 1


func count_nodes(node: Node) -> int:
	var n := 1
	for child in node.get_children():
		n += count_nodes(child)
	return n
