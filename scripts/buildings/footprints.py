"""World-space floor rectangles and their projected collision/navigation geometry."""
from dataclasses import dataclass
from math import isfinite

from layout import Point


@dataclass(frozen=True)
class Footprint:
    left: float
    front: float
    right: float
    back: float

    def __post_init__(self):
        if not all(isfinite(v) for v in (self.left, self.front, self.right, self.back)):
            raise ValueError("Footprint coordinates must be finite")
        if self.left >= self.right or self.front >= self.back:
            raise ValueError("Footprint must have positive width and depth")

    @classmethod
    def from_bounds(cls, bounds):
        return cls(*(round(value, 6) for value in (
            bounds.low.x, bounds.low.z, bounds.high.x, bounds.high.z,
        )))

    def padded(self, amount):
        return Footprint(self.left-amount, self.front-amount, self.right+amount, self.back+amount)

    def contains(self, x, z):
        return self.left <= x <= self.right and self.front <= z <= self.back

    def corners(self, height):
        return (
            Point(self.left, height, self.front), Point(self.right, height, self.front),
            Point(self.right, height, self.back), Point(self.left, height, self.back),
        )


def navigation_cells(floor, blockers, clearance):
    """Partition a floor along every obstacle edge so free cells share full edges."""
    inside = floor.padded(-clearance)
    blocked = tuple(obstacle.padded(clearance) for obstacle in blockers)
    xs = {inside.left, inside.right}
    zs = {inside.front, inside.back}
    for region in blocked:
        xs.update(round(x, 6) for x in (region.left, region.right) if inside.left < x < inside.right)
        zs.update(round(z, 6) for z in (region.front, region.back) if inside.front < z < inside.back)
    xs, zs = sorted(xs), sorted(zs)
    for x0, x1 in zip(xs, xs[1:]):
        for z0, z1 in zip(zs, zs[1:]):
            if x1-x0 <= 1e-5 or z1-z0 <= 1e-5:
                continue
            if not any(region.contains((x0+x1)/2, (z0+z1)/2) for region in blocked):
                yield Footprint(x0, z0, x1, z1)


def project_geometry(blockers, height, project, floor=None, clearance=0.14):
    collision = [
        {"id": name, "polygon": [project(p) for p in region.corners(height)]}
        for name, region in blockers
    ]
    navigation = None
    if floor is not None:
        points = {}
        polygons = []
        for cell in navigation_cells(floor, (region for _, region in blockers), clearance):
            polygon = []
            for corner in cell.corners(height):
                pixel = tuple(project(corner))
                polygon.append(points.setdefault(pixel, len(points)))
            polygons.append(polygon)
        if not polygons:
            raise ValueError("No walkable area remains after applying collision clearance")
        navigation = {"clearanceWorldUnits": clearance, "vertices": list(points), "polygons": polygons}
    return {"version": 1, "collision": collision, "navigation": navigation}
