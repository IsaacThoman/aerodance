import bpy, sys, time, math, pickle
import numpy as np
from mathutils import Matrix, Quaternion, Vector
from bl_ext.blender_org.mpfb.services.humanservice import HumanService
argv = sys.argv[sys.argv.index('--')+1:]
motion_file, out_dir = argv[0], argv[1]
bpy.ops.wm.read_factory_settings(use_empty=True)
info = HumanService._create_default_human_info_dict()
info["phenotype"].update(gender=1.0, age=0.4)
info["rig"]="default"; info["eyes"]="high-poly/high-poly.mhclo"; info["eyebrows"]="eyebrow001/eyebrow001.mhclo"
info["hair"]="short02/short02.mhclo"; info["clothes"]=["male_casualsuit02/male_casualsuit02.mhclo","shoes01/shoes01.mhclo"]
info["skin_mhmat"]="young_caucasian_male/young_caucasian_male.mhmat"; info["skin_material_type"]="ENHANCED_SSS"
bm=HumanService.deserialize_from_dict(info, HumanService.get_default_deserialization_settings())
rig=[o for o in bpy.data.objects if o.type=='ARMATURE'][0]

# SMPL: 24 joints, parents
PAR=[-1,0,0,0,1,2,3,4,5,6,7,8,9,9,9,12,13,14,16,17,18,19,20,21]
m=pickle.load(open(motion_file,'rb'))
poses=m['smpl_poses'].reshape(-1,24,3); trans=m['smpl_trans']/m['smpl_scaling'][0]
# SMPL frame (y up, faces +z, subject left = +x) -> Blender (z up, faces -y, left = +x)
C=Matrix(((1,0,0),(0,0,-1),(0,1,0)))
Ci=C.inverted()
X=(1,0,0); U=(0,0,1); D=(0,0,-1); F=(0,-1,0)
# bone -> (smpl joint, canonical blender-frame direction or None to keep rest orientation)
MAP={'root':(0,None),'pelvis.L':(0,None),'pelvis.R':(0,None),'spine05':(3,U),'spine04':(3,U),'spine03':(6,U),'spine02':(9,U),'spine01':(9,U),
 'neck01':(12,U),'neck02':(12,U),'neck03':(12,U),'head':(15,U),
 'clavicle.L':(13,X),'clavicle.R':(14,(-1,0,0)),'shoulder01.L':(13,X),'shoulder01.R':(14,(-1,0,0)),
 'upperarm01.L':(16,X),'upperarm02.L':(16,X),'upperarm01.R':(17,(-1,0,0)),'upperarm02.R':(17,(-1,0,0)),
 'lowerarm01.L':(18,X),'lowerarm02.L':(18,X),'lowerarm01.R':(19,(-1,0,0)),'lowerarm02.R':(19,(-1,0,0)),
 'wrist.L':(20,X),'wrist.R':(21,(-1,0,0)),
 'upperleg01.L':(1,D),'upperleg02.L':(1,D),'upperleg01.R':(2,D),'upperleg02.R':(2,D),
 'lowerleg01.L':(4,D),'lowerleg02.L':(4,D),'lowerleg01.R':(5,D),'lowerleg02.R':(5,D),
 'foot.L':(7,(0,-0.9,-0.45)),'foot.R':(8,(0,-0.9,-0.45))}
bones=rig.data.bones
restW={b.name:(rig.matrix_world.to_3x3()@b.matrix_local.to_3x3()) for b in bones}
def swing(a,b):
    a=Vector(a).normalized(); b=Vector(b).normalized(); return a.rotation_difference(b).to_matrix()
A={}
for b in bones:
    if b.name in MAP and MAP[b.name][1] is not None:
        rest=restW[b.name]; y=rest.col[1]  # bone axis
        A[b.name]=swing(y, MAP[b.name][1])@rest
    else: A[b.name]=restW[b.name]
def aa2m(v):
    a=np.linalg.norm(v); 
    return Matrix.Identity(3) if a<1e-8 else Quaternion(Vector(v/a),a).to_matrix()
order=[]  # parents first
def visit(b):
    order.append(b)
    for c in b.children: visit(c)
for b in bones:
    if b.parent is None: visit(b)
pb=rig.pose.bones
for p in pb: p.rotation_mode='QUATERNION'
N=int(argv[2]) if len(argv)>2 else poses.shape[0]
step=2  # 60 -> 30 fps
hip0=Vector(trans[0])
rootrest_z=bones['root'].head_local.z
for fi,f in enumerate(range(0,N,step)):
    G=[None]*24
    for j in range(24):
        L=aa2m(poses[f,j]); G[j]=L if PAR[j]<0 else G[PAR[j]]@L
    Gb=[C@g@Ci for g in G]
    posed={}
    for b in order:
        name=b.name
        if name in MAP: W=Gb[MAP[name][0]]@A[name]
        else:
            P=posed[b.parent.name]; W=P@(restW[b.parent.name].inverted()@restW[name])
        posed[name]=W
        if b.parent is None: rel=restW[name]; Pw=Matrix.Identity(3)
        else: Pw=posed[b.parent.name]; rel=restW[b.parent.name].inverted()@restW[name]
        local=(Pw@rel).inverted()@W
        pb[name].rotation_quaternion=local.to_quaternion()
        pb[name].keyframe_insert('rotation_quaternion',frame=fi+1)
    t=C@Vector(trans[f])-C@hip0
    pb['root'].location=(restW['root'].inverted()@Vector((t.x,t.y,t.z)))  # root loc in bone space
    pb['root'].keyframe_insert('location',frame=fi+1)
sc=bpy.context.scene; sc.frame_start=1; sc.frame_end=fi+1; sc.render.fps=30
sc.render.engine='BLENDER_EEVEE'; sc.render.resolution_x=640; sc.render.resolution_y=480
cam=bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); sc.collection.objects.link(cam); sc.camera=cam
cam.location=(0,-4.5,1.1); cam.rotation_euler=(math.radians(87),0,0); cam.data.lens=24
l=bpy.data.objects.new("sun", bpy.data.lights.new("sun",'SUN')); l.data.energy=3; l.rotation_euler=(0.8,0.2,0.3); sc.collection.objects.link(l)
w=bpy.data.worlds.new("w"); sc.world=w; w.use_nodes=True; w.node_tree.nodes["Background"].inputs[0].default_value=(0.6,0.6,0.65,1)
bpy.ops.mesh.primitive_plane_add(size=20)
bpy.ops.wm.save_as_mainfile(filepath=out_dir+'/rt.blend')
t0=time.time()
for f in range(1,fi+2,int(argv[3]) if len(argv)>3 else 10):
    sc.frame_set(f); sc.render.filepath=f'{out_dir}/f{f:04d}.png'; bpy.ops.render.render(write_still=True)
print("RENDER", time.time()-t0)
