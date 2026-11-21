extends SceneTree
## Run headless after importing the generated bar, guest_rooms, and inn scenes.

const RADIUS := 3.0
var actor: CharacterBody2D
var failure := ""


func _initialize() -> void:
	call_deferred("probe")


func probe() -> void:
	var bar := await mount("bar")
	if not await test_hits(bar, ["round_table", "shell_boundary_1", "staircase_post_1"]):
		return fail_test(failure)
	if not await test_entrance(bar):
		return fail_test(failure)
	bar.free()
	await physics_frame

	var exterior := await mount("inn")
	if not await test_hits(exterior, ["building"]):
		return fail_test(failure)
	exterior.free()
	await physics_frame

	var upper := await mount("guest_rooms")
	if not await test_hits(upper, ["stairwell_opening"]):
		return fail_test(failure)
	if not await test_navigation(upper):
		return fail_test(failure)
	print("PASS building, wall, tabletop support, stair post, entrance and upper navigation")
	quit()


func mount(name: String) -> Node2D:
	var names := ["bar", "guest_rooms", "inn"]
	var arguments := OS.get_cmdline_user_args()
	var path := arguments[names.find(name)] if arguments.size() == 3 else "res://buildings/" + name + ".tscn"
	var packed := load(path) as PackedScene
	var room := packed.instantiate() as Node2D
	root.add_child(room)
	actor = CharacterBody2D.new()
	var feet := CollisionShape2D.new()
	var shape := CircleShape2D.new()
	shape.radius = RADIUS
	feet.shape = shape
	actor.add_child(feet)
	room.add_child(actor)
	await physics_frame
	await physics_frame
	return room


func collider(room: Node2D, id: String) -> CollisionPolygon2D:
	var body := room.get_node_or_null("Geometry/" + id) as StaticBody2D
	if body == null or body.get_child_count() != 1:
		failure = "Missing imported StaticBody2D: " + id
		return null
	return body.get_child(0) as CollisionPolygon2D


func test_hits(room: Node2D, ids: Array) -> bool:
	for id: String in ids:
		var shape := collider(room, id)
		if shape == null:
			return false
		var center := Vector2.ZERO
		for p in shape.polygon:
			center += shape.to_global(p)
		center /= shape.polygon.size()
		var matched := false
		for index in shape.polygon.size():
			var a := shape.to_global(shape.polygon[index])
			var b := shape.to_global(shape.polygon[(index+1) % shape.polygon.size()])
			var middle := (a+b)*0.5
			var normal := (b-a).normalized().orthogonal()
			if normal.dot(middle-center) < 0:
				normal = -normal
			actor.global_position = middle + normal*10.0
			await physics_frame
			var hit := actor.move_and_collide(-normal*18.0, false, 0.01)
			if hit == null or hit.get_collider() != shape.get_parent():
				continue
			var distance := (actor.global_position-middle).dot(normal)
			if absf(distance-RADIUS) <= 0.30:
				print("%s contact at %.2f px from the footprint (radius %.1f px)" % [id, distance, RADIUS])
				matched = true
				break
		if not matched:
			failure = "Actor did not stop at the projected footprint edge: " + id
			return false
	return true


func test_entrance(room: Node2D) -> bool:
	var front := collider(room, "front_left")
	if front == null:
		return false
	var inward := (front.polygon[3]-front.polygon[0]).normalized()
	var entry := room.get_node("Markers/entry") as Marker2D
	actor.global_position = entry.global_position - inward*28.0
	await physics_frame
	var hit := actor.move_and_collide(inward*28.0)
	if hit != null or actor.global_position.distance_to(entry.global_position) > 0.1:
		failure = "Entrance is blocked"
		return false
	print("Entrance: character crossed the front edge to the spawn marker")
	return true


func test_navigation(room: Node2D) -> bool:
	var hole := collider(room, "stairwell_opening")
	if hole == null:
		return false
	var nav := room.get_node_or_null("Geometry/Walkable") as NavigationRegion2D
	if nav == null:
		failure = "Rooms lack an imported NavigationRegion2D"
		return false
	var front := (hole.polygon[0]+hole.polygon[1])*0.5
	var back := (hole.polygon[2]+hole.polygon[3])*0.5
	var start := hole.to_global(front-(back-front).normalized()*26.0)
	var landing := room.get_node("Markers/stairs") as Marker2D
	var map := nav.get_navigation_map()
	var path := NavigationServer2D.map_get_path(map, start, landing.global_position, true)
	if path.size() < 3 or path[0].distance_to(start) > 1 or path[-1].distance_to(landing.global_position) > 1:
		failure = "No complete navigation path around the stairwell: " + str(path)
		return false
	for index in range(1, path.size()):
		var start_point := hole.to_local(path[index-1])
		var end_point := hole.to_local(path[index])
		for sample in range(33):
			if Geometry2D.is_point_in_polygon(start_point.lerp(end_point, sample/32.0), hole.polygon):
				failure = "Navigation path crossed the stairwell"
				return false
	actor.global_position = path[0]
	for index in range(1, path.size()):
		await physics_frame
		if actor.move_and_collide(path[index]-actor.global_position) != null:
			failure = "Character hit an obstacle while following the navigation path"
			return false
	print("Navigation: %d waypoints skirt the stairwell and reach the landing" % path.size())
	return true


func fail_test(message: String) -> void:
	printerr(message)
	quit(1)
