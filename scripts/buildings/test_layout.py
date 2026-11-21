import unittest

from footprints import Footprint, navigation_cells
from layout import (
    AABB, Point, Volume, attach_stairs, attach_tower, building_sockets,
    ground_pivot, reject_blocked_clearances, reject_intersections, reject_unsupported,
)


def region(x1, y1, z1, x2, y2, z2):
    return AABB(Point(x1, y1, z1), Point(x2, y2, z2))


class BuildingLayoutTests(unittest.TestCase):
    def test_ground_pivot_uses_foundation_underside(self):
        foundation = region(4, 2.5, -3, 8, 2.8, 1)
        pivot = ground_pivot(foundation)
        placed = foundation.moved(Point(0, 0, 0) - pivot)
        self.assertEqual(pivot, Point(6, 2.5, -1))
        self.assertEqual(placed.low.y, 0)

    def test_tower_docks_on_both_walls_below_the_roof(self):
        wall = region(-2, 0, -3, 2, 2.8, 3)
        roof = region(-2.3, 2.8, -3.3, 2.3, 4, 3.3)
        tower_wall = region(-1, 0, -1, 1, 5, 1)
        steeple = region(-1.9, 5, -1.9, 1.9, 6, 1.9)
        building = (Volume("wall", wall), Volume("roof", roof))
        tower = (Volume("shaft", tower_wall), Volume("steeple", steeple))
        sockets = building_sockets(wall, roof)

        for side, expected in [("left", -3.315), ("right", 3.315)]:
            with self.subTest(side=side):
                socket = sockets[f"{side}_wing_socket"]
                offset, collar = attach_tower(side, socket, wall, building, tower_wall, tower)
                placed = tuple(volume.moved(offset) for volume in tower)
                self.assertAlmostEqual(offset.x, expected)
                self.assertEqual(offset.y, 0)
                self.assertLess(collar.high.y, roof.low.y)
                wall_face = collar.high.x if side == "left" else collar.low.x
                self.assertEqual(wall_face, socket.x)
                reject_intersections([
                    ("building", building), ("tower", placed),
                    ("collar", (Volume("connection", collar),)),
                ])

    def test_stair_contact_uses_the_low_footing(self):
        stair = region(-1, 0, -1, 1, 0.3, 0)
        footing = Volume("footing", region(-2, 0, -2.2, 2, 0.3, 2))
        door = Volume("door", region(-0.8, 0.31, -2.5, 0.8, 2, -2))
        position = attach_stairs(stair, 0.2, (footing, door))

        self.assertEqual(position, Point(0.2, 0, -2.2))
        self.assertFalse(stair.moved(position).intersects(footing.bounds))

    def test_collision_gate_rejects_penetration_but_accepts_contact(self):
        wall = Volume("wall", region(0, 0, 0, 2, 2, 2))
        tower = Volume("shaft", region(2, 0.1, 0.5, 3, 2, 1.5))
        reject_intersections([("main", (wall,)), ("tower", (tower,))])

        intruding = tower.moved(Point(-0.01, 0, 0))
        with self.assertRaisesRegex(ValueError, "tower/shaft intersects main/wall"):
            reject_intersections([("main", (wall,)), ("tower", (intruding,))])

    def test_interior_doorway_clearance_allows_threshold_but_rejects_furniture(self):
        doorway = Volume("Guest doorway", region(-1, 0.35, -0.4, 1, 2, 0.4))
        threshold = Volume("threshold", region(-1, 0.30, -0.3, 0, 0.35, 0.3))
        cabinet = Volume("cabinet", region(0.5, 0.30, -0.2, 0.9, 1.2, 0.2))
        reject_blocked_clearances([("shell", (threshold,))], (doorway,))

        with self.assertRaisesRegex(ValueError, "furniture/cabinet blocks Guest doorway"):
            reject_blocked_clearances([("furniture", (cabinet,))], (doorway,))

    def test_detached_geometry_requires_a_contact_chain(self):
        floor = Volume("footing", region(0, 0, 0, 1, 0.3, 1))
        post = Volume("post", region(0.3, 0.3, 0.3, 0.7, 1, 0.7))
        beam = Volume("beam", region(0.2, 1, 0.35, 0.8, 1.1, 0.65))
        reject_unsupported("covered entry", (floor, post, beam))

        with self.assertRaisesRegex(ValueError, "Unsupported geometry.*beam"):
            reject_unsupported("covered entry", (floor, beam))

    def test_nav_cells_exclude_stairwell_and_agent_clearance(self):
        floor = Footprint(0, 0, 5, 4)
        hole = Footprint(2, 1, 3, 3)
        cells = list(navigation_cells(floor, (hole,), 0.1))
        self.assertFalse(any(cell.contains(2.5, 2) or cell.contains(1.95, 2) for cell in cells))
        self.assertTrue(any(cell.contains(1.8, 2) for cell in cells))
        total_area = sum((cell.right-cell.left)*(cell.back-cell.front) for cell in cells)
        self.assertAlmostEqual(total_area, 4.8*3.8 - 1.2*2.2)


if __name__ == "__main__":
    unittest.main()
