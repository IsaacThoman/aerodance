"""Find the basemesh vertex indices used for the face/foot keypoints (humans.KP_VERTS).

blender -b -P tools/trackbench/blender/checks/find_vertices.py

Geometric search on the rest basemesh (left = +x); prints candidates to check on renders.
"""
import bpy, numpy as np
from bl_ext.blender_org.mpfb.services.humanservice import HumanService
bpy.ops.wm.read_factory_settings(use_empty=True)
info = HumanService._create_default_human_info_dict(); info["rig"]="default"
bm=HumanService.deserialize_from_dict(info, HumanService.get_default_deserialization_settings())
me=bm.data; n=len(me.vertices)
# rest coords with shape keys
kb=me.shape_keys.key_blocks; base=np.empty(n*3,np.float32); kb[0].data.foreach_get('co',base); base=base.reshape(-1,3)
co=base.copy()
for k in kb[1:]:
    a=np.empty(n*3,np.float32); k.data.foreach_get('co',a); co+= k.value*(a.reshape(-1,3)-base)
gname={g.index:g.name for g in bm.vertex_groups}
W={}
for v in me.vertices:
    for g in v.groups:
        W.setdefault(gname[g.group],{})[v.index]=g.weight
def grp(name, minw=0.5): return np.array(sorted(i for i,w in W.get(name,{}).items() if w>=minw))
body=grp('body',0.5); bodyset=set(body.tolist())
res={}
# nose tip: body, |x|<0.003, z>neck, min y
head=[i for i in body if co[i,2]>1.30]
mid=[i for i in head if abs(co[i,0])<0.002]
res['nose']=[min(mid,key=lambda i:co[i,1])]
for s,sg in (('l',1),('r',-1)):
    S='L' if s=='l' else 'R'
    he=grp(f'helper-{s}-eye',0.01); c=co[he].mean(0)
    front=he[np.argmin(co[he,1])]; res[f'{s}_eye_helper_front']=[int(front)]
    # eyelid ring: body verts within 2.2 cm of the eye helper center with y < c.y (front)
    cand=[i for i in head if np.linalg.norm(co[i]-c)<0.022 and co[i,1]<c[1]-0.004]
    xs=[co[i,0]*sg for i in cand]
    res[f'{s}_eye_inner']=[cand[int(np.argmin(xs))]]; res[f'{s}_eye_outer']=[cand[int(np.argmax(xs))]]
    res[f'{s}_eye_center_radius']=float(np.ptp(co[he,0]))
    ears=[i for i in grp('ears',0.5) if co[i,0]*sg>0]; ec=co[ears].mean(0)
    res[f'{s}_ear']=[min(ears,key=lambda i:np.linalg.norm(co[i]-ec))]
    lips=[i for i in grp('lips',0.5) if co[i,0]*sg>0]
    res[f'{s}_mouth']=[max(lips,key=lambda i:co[i,0]*sg)]
    for fname,f in (('thumb',1),('index',2),('pinky',5)):
        g=grp(f'finger{f}-3.{S}',0.5); g=[i for i in g if i in bodyset]
        hd=np.array(bm.parent.data.bones[f'finger{f}-3.{S}'].head_local); tl=np.array(bm.parent.data.bones[f'finger{f}-3.{S}'].tail_local); d=(tl-hd)/np.linalg.norm(tl-hd)
        res[f'{s}_{fname}_tip']=[max(g,key=lambda i:np.dot(co[i]-hd,d))]
        # knuckle (MCP) = head of finger{f}-1: nearest body vertex on the back (dorsal) of hand
        b1=bm.parent.data.bones[f'finger{f}-1.{S}']; h1=np.array(b1.head_local)
        res[f'{s}_{fname}_mcp_head']=h1.round(3).tolist()
    foot=[i for i in body if co[i,0]*sg>0.03 and co[i,2]<0.12]
    ank=np.array(bm.parent.data.bones[f'foot.{S}'].head_local)
    low=[i for i in foot if co[i,2]<ank[2]*0.6]
    res[f'{s}_heel']=[max(low,key=lambda i:co[i,1])]
    res[f'{s}_toe']=[min(foot,key=lambda i:co[i,1])]
for k,v in res.items():
    print("RES", k, v, [co[i].round(3).tolist() for i in v] if isinstance(v,list) and v and isinstance(v[0],int) else '')
print("NVERTS", n, "body", len(body), "minz", co[body,2].min())
