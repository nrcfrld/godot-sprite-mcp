"""Authored church modules in Blender coordinates."""
import math
from blender_render import (
    bpy, beam, box, cedar, darkwood, finish, material, plaster, prism,
    rng, slate, stones,
)

roof_colors = [
    material("Slate blue %d" % i, color)
    for i, color in enumerate([(0.17,0.22,0.33),(0.20,0.26,0.39),(0.23,0.30,0.43),(0.19,0.25,0.35)])
]
carved_stone = material("Carved limestone", (0.67,0.64,0.49))
stained_glass = [
    material("Stained glass " + name, color)
    for name, color in [
        ("gold", (0.83,0.50,0.12)), ("ruby", (0.51,0.12,0.17)),
        ("jade", (0.11,0.40,0.30)), ("aqua", (0.16,0.42,0.60)),
    ]
]
bronze = material("Weathered bronze", (0.47,0.28,0.095), 0.44)


def arch_shape(x, y, bottom, width, height):
    radius = width / 2
    spring = bottom + height - radius
    return [(x-radius,y,bottom),(x+radius,y,bottom)] + [
        (x + math.cos(i*math.pi/12)*radius, y, spring + math.sin(i*math.pi/12)*radius)
        for i in range(13)
    ]


def front_arch(name, x, y, bottom, width, height, mat):
    return prism(name, arch_shape(x,y,bottom,width,height),(0,0.08,0),mat)


def cross(name, x, y, z, size, mat):
    box(name + " upright",(x,y,z),(0.12*size,0.14*size,0.80*size),mat,0.017)
    box(name + " arm",(x,y,z+0.10*size),(0.49*size,0.14*size,0.12*size),mat,0.017)


def nave(attached_side):
    foundation = box("Nave footing",(0,0.46,0.15),(4.31,5.11,0.30),slate,0.080)
    wall = box("Plastered nave",(0,0.46,1.41),(4.02,4.92,2.33),plaster,0.030)
    prism("Front gable", [(-2.02,-2.005,2.51),(2.02,-2.005,2.51),(0,-2.005,4.19)],(0,4.93,0),plaster)

    for i in range(11):
        box("Front fieldstone",((i-5)*0.38,-2.07,0.29),(0.35,0.16,0.31),rng.choice(stones),0.047)
    for i in range(12):
        box("Side fieldstone",(2.07,-1.82+i*0.405,0.27),(0.17,0.38,0.34),rng.choice(stones),0.046)
    for y in (-1.83,-0.21,1.41,2.82):
        box("Buttress",(2.10,y,1.06),(0.29,0.25,1.81),carved_stone,0.043)
        box("Buttress foot",(2.15,y,0.32),(0.39,0.33,0.40),stones[1],0.037)
    for y,zcolor in [(-0.99,0),(0.61,2),(2.19,3)]:
        for w,h,base,offset,mat in [
            (0.78,1.40,0.69,0,carved_stone),(0.56,1.17,0.79,0.025,darkwood),
            (0.43,1.02,0.86,0.047,stained_glass[zcolor]),
        ]:
            coords = [(2.02+offset, xx, zz) for xx,_,zz in arch_shape(y,0,base,w,h)]
            prism("Arched side window",coords,(0.057,0,0),mat)
        box("Window center mullion",(2.133,y,1.285),(0.058,0.044,0.83),darkwood,0.009)
        for height in (1.17,1.47):
            box("Window crossbar",(2.138,y,height),(0.053,0.44,0.044),darkwood,0.008)

    portal = front_arch("Portal stone arch",0.13,-2.101,0.31,1.47,2.05,carved_stone)
    front_arch("Dark inset",0.13,-2.145,0.38,1.21,1.83,darkwood)
    front_arch("Double oak doors",0.13,-2.175,0.44,1.06,1.67,cedar)
    for x in (-0.19,0.13,0.45):
        box("Door panel seam",(x,-2.191,1.04),(0.024,0.037,1.16),darkwood,0.009)
    for x in (0.035,0.22):
        box("Door handle",(x,-2.225,1.03),(0.047,0.063,0.18),bronze,0.013)

    cy, cz = -2.055, 2.88
    beam("Rose window molding",(0.12,cy,cz),(0.12,cy-0.078,cz),0.35,carved_stone,sides=32)
    beam("Rose window inset",(0.12,cy-0.072,cz),(0.12,cy-0.093,cz),0.284,darkwood,sides=32)
    for i in range(8):
        angle=i*math.pi/4
        x=0.12+0.176*math.cos(angle)
        z=cz+0.176*math.sin(angle)
        beam("Glass petal",(x,cy-0.091,z),(x,cy-0.105,z),0.067,stained_glass[i%4],sides=12)
    beam("Rose center",(0.12,cy-0.102,cz),(0.12,cy-0.112,cz),0.067,stained_glass[0],sides=16)

    roof_start = set(bpy.context.scene.objects)
    pitch = 0.74
    for sign in (-1,1):
        angle = sign*math.atan(pitch)
        # Use a flush verge on the docked side so the tower can sit closer.
        span = 2.02 if attached_side == ("left" if sign == -1 else "right") else 2.43
        underlay=box("Nave roof panels",(sign*span/2,0.46,4.22-span*pitch/2),(span/math.cos(angle),5.58,0.16),darkwood,0.040)
        underlay.rotation_euler.y = angle
        for row in range(9):
            x=sign*(0.125+row*0.266)
            half = min(0.147, span - abs(x))
            if half <= 0:
                break
            for col in range(14):
                y=0.46+(col-6.5)*0.394
                shingle=box("Slate shingle",(x,y,4.34-abs(x)*pitch),(2*half/math.cos(angle),0.411,0.10),rng.choice(roof_colors),0.036)
                shingle.rotation_euler.y = angle
        for y in (-2.34,3.26):
            beam("Gable roof trim",(0,y,4.32),(sign*span,y,4.32-span*pitch),0.081,roof_colors[0],sides=8)
    beam("Covered ridge",(0,-2.37,4.37),(0,3.33,4.37),0.114,roof_colors[0],sides=10)
    return foundation, wall, set(bpy.context.scene.objects) - roof_start, portal


def belfry():
    x,y = 0,0
    foundation = box("Tower foundation",(x,y,0.17),(1.72,1.76,0.34),slate,0.055)
    wall = box("Tower masonry",(x,y,1.96),(1.57,1.58,3.40),plaster,0.034)
    for dz in (0.43,1.01,2.10,3.52):
        box("Tower cornice",(x,y,dz),(1.70,1.71,0.13),carved_stone,0.036)
    for nx in (-1,1):
        for ny in (-1,1):
            for i in range(8):
                ax,ay=x+nx*0.76,y+ny*0.76
                box("Tower corner block",(ax,ay,0.63+i*0.353),(0.19,0.21,0.28),stones[i%len(stones)] if i%3==0 else carved_stone,0.033)
            box("Belfry pier",(x+nx*0.67,y+ny*0.67,4.13),(0.23,0.24,1.24),carved_stone,0.041)
    box("Bell ceiling",(x,y,4.73),(1.70,1.70,0.22),darkwood,0.038)
    box("Bell hanging beam",(x,y,4.44),(1.49,0.18,0.16),cedar,0.024)
    beam("Bell suspension to ceiling",(x,y,4.47),(x,y,4.68),0.065,darkwood,sides=8)
    beam("Bronze bell chamber",(x,y,3.90),(x,y,4.37),0.32,bronze,0.165,24)
    beam("Bell lip",(x,y,3.87),(x,y,3.94),0.36,bronze,0.34,24)
    beam("Bell clapper",(x,y,3.80),(x,y,3.94),0.071,darkwood,0.047,12)
    front_arch("Tower slit casing",x,y-0.828,2.26,0.44,0.89,carved_stone)
    front_arch("Tower slit glass",x,y-0.851,2.32,0.26,0.73,stained_glass[2])

    roof_start = set(bpy.context.scene.objects)
    box("Steeple eaves",(x,y,4.80),(1.93,1.93,0.12),roof_colors[0],0.034)
    for i in range(9):
        z=4.83+i*0.122
        half=0.96-i*0.100
        bpy.ops.mesh.primitive_cone_add(vertices=4,radius1=half*math.sqrt(2),radius2=max(half-0.124,0.018)*math.sqrt(2),depth=0.153,location=(x,y,z+0.076))
        piece=bpy.context.object
        piece.rotation_euler.z=math.pi/4
        finish(piece,"Overlapping steeple slate",roof_colors[i%len(roof_colors)],0.022)
    return foundation, wall, set(bpy.context.scene.objects) - roof_start, None



def stairs():
    foundation = box("Bottom entry step", (0, -0.18, 0.09), (1.72, 0.66, 0.18), stones[1], 0.041)
    box("Top entry step", (0, -0.015, 0.215), (1.56, 0.33, 0.17), stones[2], 0.041)
    return foundation, None, (), None


def roof_cross():
    # The ornament is built with its foot at zero and attached after validation.
    cross("Church cross", 0, 0, 0.32, 0.8, bronze)
