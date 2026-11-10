"""Make a still for every sensor operation from the environment's clean gallery."""
import json
import os
from pathlib import Path
import shutil
from PIL import Image, ImageDraw
from degrade import process

root=Path(os.environ.get('TRACKBENCH_DATA','/Volumes/development/aerodance-trackbench'))/'gallery/environment'
base=root/'living_room--bright_even'
ops=[{'type':'noise','sigma':12},{'type':'gain','ev':-3,'noise':8},
     {'type':'jpeg','quality':10},{'type':'motion_blur','shutter_frac':1},
     {'type':'defocus','radius_px':3},{'type':'white_balance','kelvin':3000},
     {'type':'fps','fps':15},{'type':'downscale','factor':.2},
     {'type':'vignette','strength':.9},{'type':'auto_exposure','amplitude_ev':2},
     {'type':'auto_white_balance','amplitude_k':3500}, {'type':'chroma_subsample'},
     {'type':'rolling_shutter','strength_px':40}]
sheet=Image.new('RGB',(4*320,4*264),(30,30,30));draw=ImageDraw.Draw(sheet)
for i,op in enumerate(ops):
    folder=root/('post--'+op['type']);(folder/'render').mkdir(parents=True,exist_ok=True)
    spec=json.loads((base/'spec.json').read_text());spec['post']=[op]
    (folder/'spec.json').write_text(json.dumps(spec,indent=2))
    for p in (base/'render').glob('*.png'):shutil.copyfile(p,folder/'render'/p.name)
    process(folder)
    with Image.open(folder/'frames/000020.jpg') as im:
        im=im.copy();im.thumbnail((320,240));sheet.paste(im,((i%4)*320,(i//4)*264))
    draw.text(((i%4)*320+5,(i//4)*264+244),op['type'],fill='white')
sheet.save(root/'contact-post.jpg',quality=93)
print(root/'contact-post.jpg')
