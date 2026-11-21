"""Y-up, axis-aligned layout for building modules. Independent of Blender."""
from dataclasses import dataclass

EPSILON = 1e-5


@dataclass(frozen=True)
class Point:
    x: float
    y: float
    z: float

    def __add__(self, other):
        return Point(self.x + other.x, self.y + other.y, self.z + other.z)

    def __sub__(self, other):
        return Point(self.x - other.x, self.y - other.y, self.z - other.z)


@dataclass(frozen=True)
class AABB:
    low: Point
    high: Point

    @classmethod
    def enclosing(cls, points):
        points = tuple(points)
        return cls(
            Point(*(min(getattr(p, axis) for p in points) for axis in "xyz")),
            Point(*(max(getattr(p, axis) for p in points) for axis in "xyz")),
        )

    @property
    def center(self):
        return Point(*((getattr(self.low, a) + getattr(self.high, a)) / 2 for a in "xyz"))

    @property
    def size(self):
        return self.high - self.low

    def moved(self, delta):
        return AABB(self.low + delta, self.high + delta)

    def intersects(self, other):
        return all(
            min(getattr(self.high, axis), getattr(other.high, axis))
            - max(getattr(self.low, axis), getattr(other.low, axis)) > EPSILON
            for axis in "xyz"
        )


@dataclass(frozen=True)
class Volume:
    name: str
    bounds: AABB

    def moved(self, delta):
        return Volume(self.name, self.bounds.moved(delta))


def ground_pivot(foundation):
    """Center in plan on the foundation and use its underside for vertical zero."""
    return Point(foundation.center.x, foundation.low.y, foundation.center.z)


def roof_apex_socket(roof):
    return Point(roof.center.x, roof.high.y, roof.center.z)


def building_sockets(wall, roof):
    # Keep the wing sockets behind the entrance, toward the front third of each side.
    side_depth = wall.low.z + wall.size.z * 0.35
    return {
        "left_wing_socket": Point(wall.low.x, 0, side_depth),
        "right_wing_socket": Point(wall.high.x, 0, side_depth),
        "roof_apex_socket": roof_apex_socket(roof),
    }


def attach_tower(side, socket, wall, building, tower_wall, tower):
    """Dock outside the roof and connect to the wall below the eaves."""
    left = side == "left"

    # Try the socket depth first, then neighboring bays on that same wall.
    half_width = min(0.13, tower_wall.size.z * 0.19)
    steps = (0, *(step for distance in range(1, 25) for step in (-distance, distance)))
    for step in steps:
        depth = socket.z + step * wall.size.z / 72
        if depth - half_width <= wall.low.z or depth + half_width >= wall.high.z:
            continue
        dz = depth - tower_wall.center.z
        # A high steeple can extend over part of the exterior without impacting
        # the lower nave. Only shapes sharing height and depth limit the snap.
        limits = []
        for main in building:
            a = main.bounds
            for part in tower:
                b = part.bounds
                if (min(a.high.y, b.high.y) - max(a.low.y, b.low.y) > EPSILON
                    and min(a.high.z, b.high.z + dz) - max(a.low.z, b.low.z + dz) > EPSILON):
                    limits.append(a.low.x - b.high.x if left else a.high.x - b.low.x)
        if not limits:
            continue
        wall_contact = socket.x - (tower_wall.high.x if left else tower_wall.low.x)
        limits.append(wall_contact)
        anchor_x = min(limits) - 0.015 if left else max(limits) + 0.015
        translation = Point(anchor_x, 0, dz)
        inner_wall = translation.x + (tower_wall.high.x if left else tower_wall.low.x)
        a, b = sorted((inner_wall, socket.x))
        base = wall.low.y + wall.size.y * 0.39
        top = min(base + wall.size.y * 0.30, wall.high.y)
        link = AABB(Point(a, base, depth - half_width), Point(b, top, depth + half_width))
        obstacles = (*building, *(volume.moved(translation) for volume in tower))
        if not any(link.intersects(volume.bounds) for volume in obstacles):
            return translation, link
    raise ValueError(f"No clear {side}_wing_socket connection between the tower and the wall")


def attach_to_side(module, socket, side):
    """Align the module's inward bounding-box face to an exterior socket."""
    if side == "front":
        return Point(socket.x - module.center.x, 0, socket.z - module.high.z)
    if side == "back":
        return Point(socket.x - module.center.x, 0, socket.z - module.low.z)
    if side == "left":
        return Point(socket.x - module.high.x, 0, socket.z - module.center.z)
    if side == "right":
        return Point(socket.x - module.low.x, 0, socket.z - module.center.z)
    raise ValueError(f"Unknown exterior side: {side}")


def attach_stairs(stairs, entrance_x, building):
    """Meet the foremost low masonry within the entry stair width."""
    x = entrance_x - stairs.center.x
    low, high = stairs.low.x + x, stairs.high.x + x
    landing_z = min(
        a.low.z for volume in building
        if (a := volume.bounds).low.y < stairs.high.y - EPSILON
        and min(high, a.high.x) - max(low, a.low.x) > EPSILON
    )
    return attach_to_side(stairs, Point(entrance_x, 0, landing_z), "front")


def reject_intersections(groups):
    """Reject overlap across assemblies. Face contact and internal joins are valid."""
    existing = []
    for group, volumes in groups:
        conflict = first_intersection(volumes, existing)
        if conflict:
            volume, other_group, other = conflict
            raise ValueError(f"AABB collision: {group}/{volume.name} intersects {other_group}/{other.name}")
        existing.extend((group, volume) for volume in volumes)


def first_intersection(volumes, obstacles):
    for volume in volumes:
        for other_group, other in obstacles:
            if volume.bounds.intersects(other.bounds):
                return volume, other_group, other
    return None


def reject_blocked_clearances(groups, clearances):
    for passage in clearances:
        for group, volumes in groups:
            for volume in volumes:
                if volume.bounds.intersects(passage.bounds):
                    raise ValueError(f"{group}/{volume.name} blocks {passage.name}")


def bounds_touch(a, b, tolerance):
    return all(
        min(getattr(a.high, axis), getattr(b.high, axis))
        >= max(getattr(a.low, axis), getattr(b.low, axis)) - tolerance
        for axis in "xyz"
    )


def reject_unsupported(group, volumes, tolerance=0.026):
    """Reject disconnected mesh groups with no contact chain to the support plane."""
    supported = [volume for volume in volumes if abs(volume.bounds.low.y) <= EPSILON]
    remaining = [volume for volume in volumes if abs(volume.bounds.low.y) > EPSILON]
    while supported:
        support = supported.pop()
        neighbors = [volume for volume in remaining if bounds_touch(volume.bounds, support.bounds, tolerance)]
        supported.extend(neighbors)
        remaining = [volume for volume in remaining if volume not in neighbors]
    if remaining:
        names = ", ".join(volume.name for volume in remaining[:4])
        raise ValueError(f"Unsupported geometry in {group}: {names}; no contact chain to the foundation")
