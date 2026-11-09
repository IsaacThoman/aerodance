import bpy, sys, time, math
from bl_ext.blender_org.mpfb.services.humanservice import HumanService
t=time.time()
bpy.ops.wm.read_factory_settings(use_empty=True)
info = HumanService._create_default_human_info_dict()
info["phenotype"].update(gender=0.0, age=0.4, muscle=0.5, weight=0.6, height=0.5)
info["rig"]="default"
info["eyes"]="high-poly/high-poly.mhclo"; info["eyebrows"]="eyebrow001/eyebrow001.mhclo"; info["eyelashes"]="eyelashes01/eyelashes01.mhclo"
info["hair"]="ponytail01/ponytail01.mhclo"
info["clothes"]=["female_casualsuit01/female_casualsuit01.mhclo","shoes02/shoes02.mhclo"]
info["skin_mhmat"]="young_african_female/young_african_female.mhmat"; info["skin_material_type"]="ENHANCED_SSS"
s=HumanService.get_default_deserialization_settings()
bm=HumanService.deserialize_from_dict(info, s)
print("BUILT", time.time()-t, [o.name for o in bpy.data.objects])
sc=bpy.context.scene
sc.render.engine='BLENDER_EEVEE'; sc.render.resolution_x=640; sc.render.resolution_y=480
cam=bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); sc.collection.objects.link(cam); sc.camera=cam
cam.location=(0,-4.0,1.0); cam.rotation_euler=(math.radians(88),0,0); cam.data.lens=26
l=bpy.data.objects.new("sun", bpy.data.lights.new("sun",'SUN')); l.data.energy=3; l.rotation_euler=(0.8,0.2,0.3); sc.collection.objects.link(l)
w=bpy.data.worlds.new("w"); sc.world=w; w.use_nodes=True; w.node_tree.nodes["Background"].inputs[0].default_value=(0.6,0.6,0.65,1); w.node_tree.nodes["Background"].inputs[1].default_value=0.6
bpy.ops.mesh.primitive_plane_add(size=20)
sc.render.filepath=sys.argv[-1]; bpy.ops.render.render(write_still=True)
print("DONE", time.time()-t)
