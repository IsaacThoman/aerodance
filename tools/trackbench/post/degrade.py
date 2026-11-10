"""Deterministic webcam simulation. RGB float arrays in [0,1]; NumPy-only core."""
import argparse
import json
import math
from pathlib import Path
import numpy as np

PARAMS = {
    'noise': {'sigma'}, 'gain': {'ev','noise'}, 'jpeg': {'quality'},
    'motion_blur': {'shutter_frac'}, 'defocus': {'radius_px'},
    'white_balance': {'kelvin'}, 'fps': {'fps'}, 'downscale': {'factor'},
    'vignette': {'strength'}, 'auto_exposure': {'amplitude_ev','period_s'},
    'auto_white_balance': {'amplitude_k','period_s'},
    'chroma_subsample': set(), 'rolling_shutter': {'strength_px','frequency_hz'},
}

def validate(spec):
    if spec.get('fps',30) <= 0: raise ValueError('fps must be positive')
    if not 15 <= spec.get('camera',{}).get('hfov_deg',65) <= 120: raise ValueError('hfov_deg must be in [15,120]')
    for op in spec.get('post',[]):
        kind=op.get('type')
        if kind not in PARAMS: raise ValueError(f'Unknown post type: {kind}')
        unknown=set(op)-PARAMS[kind]-{'type'}
        if unknown: raise ValueError(f'Unknown {kind} parameters: {unknown}')
        for key,val in op.items():
            if key!='type' and (not isinstance(val,(int,float)) or not math.isfinite(val)):
                raise ValueError(f'{kind}.{key} must be finite numeric')
        ranges={'sigma':(0,255),'noise':(0,255),'quality':(1,100),'shutter_frac':(0,1),
                'radius_px':(0,50),'kelvin':(1000,15000),'factor':(.01,1),'strength':(0,1),
                'period_s':(.01,1e6),'fps':(.01,spec.get('fps',30)), 'strength_px':(0,100),
                'frequency_hz':(0,100),'amplitude_ev':(0,8),'amplitude_k':(0,4500),'ev':(-12,12)}
        for key,value in op.items():
            if key in ranges and not ranges[key][0]<=value<=ranges[key][1]:
                raise ValueError(f'{kind}.{key} outside {ranges[key]}')
    if sum(o['type']=='fps' for o in spec.get('post',[]))>1: raise ValueError('Only one fps operation is allowed')


def linear(rgb):
    return np.where(rgb<=.04045,rgb/12.92,((rgb+.055)/1.055)**2.4)


def srgb(rgb):
    rgb=np.clip(rgb,0,1)
    return np.where(rgb<=.0031308,12.92*rgb,1.055*rgb**(1/2.4)-.055)


def sensor_noise(value, sigma, rng):
    if sigma==0: return value.copy()
    # sigma is the approximate linear 8-bit standard deviation at 18% grey.
    s=sigma/255
    electrons=.18/(s*s*.8)
    shot=rng.poisson(np.clip(value,0,1)*electrons)/electrons
    return shot+rng.normal(0,s*math.sqrt(.2),value.shape)


def sample(image, x, y):
    """Bilinear sampling with edge replication; coordinates are pixel-centre indices."""
    h,w=image.shape[:2]; x=np.clip(x,0,w-1); y=np.clip(y,0,h-1)
    x0=np.floor(x).astype(int); y0=np.floor(y).astype(int)
    x1=np.minimum(x0+1,w-1); y1=np.minimum(y0+1,h-1)
    a=(x-x0)[...,None]; b=(y-y0)[...,None]
    return (image[y0,x0]*(1-a)+image[y0,x1]*a)*(1-b)+(image[y1,x0]*(1-a)+image[y1,x1]*a)*b


def resize(image,h,w):
    y,x=np.meshgrid((np.arange(h)+.5)*image.shape[0]/h-.5,(np.arange(w)+.5)*image.shape[1]/w-.5,indexing='ij')
    return sample(image,x,y)


def blur(image,radius):
    if radius==0:return image.copy()
    radius=float(radius); r=math.ceil(radius*3)
    offsets=np.arange(-r,r+1); weights=np.exp(-offsets**2/(2*radius**2));weights/=weights.sum()
    out=image
    for axis in (0,1):
        pads=[(0,0)]*3;pads[axis]=(r,r)
        padded=np.pad(out,pads,mode='edge');result=np.zeros_like(out)
        for j,weight in enumerate(weights):
            slices=[slice(None)]*3;slices[axis]=slice(j,j+out.shape[axis]);result+=weight*padded[tuple(slices)]
        out=result
    return out


def temperature(k):
    t=k/100
    return np.clip([255 if t<=66 else 329.6987*(t-60)**-.1332,
        99.4708*np.log(t)-161.1196 if t<=66 else 288.1222*(t-60)**-.0755,
        255 if t>=66 else (0 if t<=19 else 138.5177*np.log(t-10)-305.0448)],1,255)/255


def dimensions(spec):
    w,h=spec.get('resolution',[640,480])
    return (h,w) if spec.get('camera',{}).get('orientation')=='portrait' else (w,h)


def lens_k(spec):
    return max(0,(spec.get('camera',{}).get('hfov_deg',65)-90)/30)*.12


def distort_points(points_norm, spec, frame=1):
    """Apply lens then rolling-shutter warps to normalized xy. Extra columns preserved.

    Input can have arbitrary leading dimensions; null entries should be filtered by caller.
    No clipping: GT must classify points outside [0,1] itself.
    """
    p=np.array(points_norm,dtype=float,copy=True)
    if p.size==0:return p
    w,h=dimensions(spec);k=lens_k(spec)
    q=(p[...,:2]-.5)*[2,2*h/w]
    q*=((1+k)/(1+k*np.sum(q*q,axis=-1)))[...,None]
    p[...,:2]=q/[2,2*h/w]+.5
    t=(frame-1)/spec.get('fps',30)
    for op in spec.get('post',[]):
        if op['type']=='rolling_shutter':
            p[...,0]+=op.get('strength_px',4)/w*(p[...,1]-.5)*np.sin(math.tau*op.get('frequency_hz',2)*t)
    return p


def lens_image(image,spec):
    k=lens_k(spec)
    if not k:return image.copy()
    h,w=image.shape[:2];y,x=np.mgrid[:h,:w]
    qx=2*(x+.5)/w-1;qy=(2*(y+.5)/h-1)*h/w
    r2=qx*qx+qy*qy
    scale=2/(1+k+np.sqrt(np.maximum((1+k)**2-4*k*r2,1e-12)))
    return sample(image,(qx*scale+1)*w/2-.5,(qy*scale*w/h+1)*h/2-.5)



def distort_mask(mask, spec, frame=1):
    """Nearest-neighbour warp for instance masks; includes lens and rolling shutter.

    This is geometric GT only: blur/compression do not mix instance IDs. Warp the
    mask before computing bbox and visibility. Out-of-sensor samples become 0.
    """
    h,w=mask.shape
    if (w,h)!=dimensions(spec):raise ValueError('Mask dimensions disagree with spec')
    y,x=np.mgrid[:h,:w];x=x.astype(float);y=y.astype(float)
    t=(frame-1)/spec.get('fps',30)
    for op in reversed(spec.get('post',[])):
        if op['type']=='rolling_shutter':
            x-=op.get('strength_px',4)*((y+.5)/h-.5)*np.sin(math.tau*op.get('frequency_hz',2)*t)
    k=lens_k(spec)
    if k:
        qx=2*(x+.5)/w-1;qy=(2*(y+.5)/h-1)*h/w
        scale=2/(1+k+np.sqrt(np.maximum((1+k)**2-4*k*(qx*qx+qy*qy),1e-12)))
        x=(qx*scale+1)*w/2-.5;y=(qy*scale*w/h+1)*h/2-.5
    ix=np.rint(x).astype(int);iy=np.rint(y).astype(int)
    valid=(ix>=0)&(ix<w)&(iy>=0)&(iy<h)
    out=np.zeros_like(mask);out[valid]=mask[iy[valid],ix[valid]]
    return out


def apply_op(image,op,rng,t=0,previous=None,following=None):
    """One operation; JPEG and frame selection are performed by the CLI."""
    kind=op['type'];h,w=image.shape[:2]
    if kind=='noise': return srgb(sensor_noise(linear(image),op.get('sigma',6),rng))
    if kind=='gain':
        gain=2**op.get('ev',-2);v=sensor_noise(linear(image)*gain,op.get('noise',8),rng)
        # Fixed sensor black floor gets amplified when exposure is recovered.
        return srgb(np.maximum(v-.003,0)/gain)
    if kind=='defocus':return blur(image,op.get('radius_px',2))
    if kind=='white_balance':return srgb(linear(image)*temperature(op.get('kelvin',3000))/temperature(6500))
    if kind=='vignette':
        y,x=np.mgrid[:h,:w];r=((x+.5)/w-.5)**2+((y+.5)/h-.5)**2
        return srgb(linear(image)*np.clip(1-op.get('strength',.4)*r*2,0,1)[...,None])
    if kind=='downscale':
        f=op.get('factor',.5)
        return resize(resize(blur(image,max(0,(1/f-1)/2)),max(1,round(h*f)),max(1,round(w*f))),h,w)
    if kind=='motion_blur':
        if previous is None or following is None:raise ValueError('motion_blur requires neighbouring render frames')
        a=op.get('shutter_frac',.5)/2
        return srgb((1-a)*linear(image)+a*.5*(linear(previous)+linear(following)))
    if kind=='auto_exposure':return srgb(linear(image)*2**(op.get('amplitude_ev',.6)*np.sin(math.tau*t/op.get('period_s',4))))
    if kind=='auto_white_balance':return srgb(linear(image)*temperature(6500+op.get('amplitude_k',1200)*np.sin(math.tau*t/op.get('period_s',5)))/temperature(6500))
    if kind=='chroma_subsample':
        y=image@np.array([.299,.587,.114]);cb=(image[...,2]-y)*.564;cr=(image[...,0]-y)*.713
        uv=np.stack([cb,cr],axis=-1);uv=resize(resize(uv,max(1,h//2),max(1,w//2)),h,w)
        r=y+uv[...,1]/.713;b=y+uv[...,0]/.564;g=(y-.299*r-.114*b)/.587
        return np.clip(np.stack([r,g,b],axis=-1),0,1)
    if kind=='rolling_shutter':
        y,x=np.mgrid[:h,:w];shift=op.get('strength_px',4)*((y+.5)/h-.5)*np.sin(math.tau*op.get('frequency_hz',2)*t)
        return sample(image,x-shift,y)
    if kind=='fps':return image.copy()
    raise ValueError(f'{kind} is not a core pixel op; JPEG requires Pillow CLI codec')


def selected_frames(numbers,source_fps,target_fps):
    last=None;result=[]
    for n in numbers:
        bucket=math.floor((n-1)*target_fps/source_fps+1e-9)
        if bucket!=last:result.append(n);last=bucket
    return result


def process(scene_dir):
    from PIL import Image
    from io import BytesIO
    directory=Path(scene_dir);spec=json.loads((directory/'spec.json').read_text());validate(spec)
    paths=sorted((directory/'render').glob('*.png'))
    if not paths:raise ValueError(f'No render PNGs in {directory}')
    paths.sort(key=lambda p:int(p.stem))
    numbers=[int(p.stem) for p in paths]
    if min(numbers)<1:raise ValueError('Render frame numbers must be 1-based')
    if len(numbers)!=len(set(numbers)):raise ValueError('Duplicate numeric frame numbers')
    target=next((op['fps'] for op in spec.get('post',[]) if op['type']=='fps'),spec.get('fps',30))
    keep=set(selected_frames(numbers,spec.get('fps',30),target))
    out=directory/'frames';out.mkdir(exist_ok=True)
    def read(p):
        a=np.asarray(Image.open(p).convert('RGB'),dtype=np.float64)/255
        if (a.shape[1],a.shape[0])!=dimensions(spec):raise ValueError(f'Render size disagrees with spec: {p}')
        return lens_image(a,spec)
    def encode(a,quality):
        b=BytesIO();Image.fromarray(np.uint8(np.clip(a,0,1)*255+.5)).save(b,format='JPEG',quality=int(quality),subsampling=2);return b.getvalue()
    # Remove only stale generated JPGs after validation; render/ and GT are immutable.
    for p in out.glob('*.jpg'):
        if p.stem.isdecimal():p.unlink()
    cache={}
    def get(i):
        i=max(0,min(len(paths)-1,i))
        if i not in cache:cache[i]=read(paths[i])
        return cache[i]
    operations=spec.get('post',[])
    memo={}
    def pipeline(i,count):
        i=max(0,min(len(paths)-1,i))
        key=(i,count)
        if key in memo:return memo[key]
        if count==0:return get(i).copy(),None
        image,encoded=pipeline(i,count-1)
        op=operations[count-1]
        rng=np.random.default_rng(np.random.SeedSequence([spec.get('seed',1),numbers[i],count-1]))
        if op['type']=='jpeg':
            encoded=encode(image,op.get('quality',40))
            image=np.asarray(Image.open(BytesIO(encoded)),dtype=float)/255
        elif op['type']!='fps':
            previous=following=None
            if op['type']=='motion_blur':
                previous=pipeline(i-1,count-1)[0];following=pipeline(i+1,count-1)[0]
            image=apply_op(image,op,rng,(numbers[i]-1)/spec.get('fps',30),previous,following)
            encoded=None
        memo[key]=(image,encoded)
        return image,encoded
    for i,n in enumerate(numbers):
        if n not in keep:continue
        image,final_jpeg=pipeline(i,len(operations))
        data=final_jpeg if final_jpeg is not None else encode(image,95)
        temp=out/f'{n:06d}.jpg.tmp';temp.write_bytes(data);temp.replace(out/f'{n:06d}.jpg')
        cache={k:v for k,v in cache.items() if k>=i}
        memo.clear()
    (directory/'post-meta.json').write_text(json.dumps(dict(seed=spec.get('seed',1),source_fps=spec.get('fps',30),output_fps=target,frames=sorted(keep),lens_k=lens_k(spec),operations=spec.get('post',[])),indent=2)+'\n')
    return sorted(keep)

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('scene_dir');args=parser.parse_args();process(args.scene_dir)
