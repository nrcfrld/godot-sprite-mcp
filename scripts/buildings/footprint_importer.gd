extends Node2D
## Build Godot runtime geometry from the generated layout, with embedded data
## available when a Godot export omits raw JSON files.

@export_file("*.json") var layout_path: String
@export_multiline var embedded_geometry: String
@export_flags_2d_physics var collision_layer: int = 1
@export_flags_2d_navigation var navigation_layers: int = 1


func _ready() -> void:
	var data := _read_geometry()
	if data.is_empty():
		push_error("Could not load building footprint geometry: " + layout_path)
		return
	if data.get("version", 0) != 1:
		push_error("Unsupported building footprint geometry version")
		return
	for footprint: Dictionary in data.get("collision", []):
		var body := StaticBody2D.new()
		body.name = String(footprint.id)
		body.collision_layer = collision_layer
		body.collision_mask = 0
		var collider := CollisionPolygon2D.new()
		collider.polygon = _points(footprint.polygon)
		body.add_child(collider)
		add_child(body)
	var navigation: Variant = data.get("navigation")
	if navigation is Dictionary:
		var polygon := NavigationPolygon.new()
		polygon.agent_radius = 0.0
		polygon.vertices = _points(navigation.vertices)
		for indices: Array in navigation.polygons:
			polygon.add_polygon(PackedInt32Array(indices))
		var region := NavigationRegion2D.new()
		region.name = "Walkable"
		region.navigation_layers = navigation_layers
		region.navigation_polygon = polygon
		add_child(region)


func _read_geometry() -> Dictionary:
	var path := layout_path
	if not path.begins_with("res://") and not path.begins_with("user://"):
		path = get_parent().scene_file_path.get_base_dir().path_join(path)
	if FileAccess.file_exists(path):
		var layout: Variant = JSON.parse_string(FileAccess.get_file_as_string(path))
		if layout is Dictionary and layout.get("geometry") is Dictionary:
			return layout.geometry
		return {}
	var embedded: Variant = JSON.parse_string(embedded_geometry)
	return embedded if embedded is Dictionary else {}


func _points(pairs: Array) -> PackedVector2Array:
	var result := PackedVector2Array()
	for pair: Array in pairs:
		result.append(Vector2(float(pair[0]), float(pair[1])))
	return result
