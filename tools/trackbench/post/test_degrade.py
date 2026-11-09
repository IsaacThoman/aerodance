"""Run with the trackbench venv: python -m unittest discover -s tools/trackbench/post."""
import json
import tempfile
import unittest
from pathlib import Path
import numpy as np
from degrade import (distort_mask, apply_op, distort_points, lens_image, linear, srgb, sensor_noise,
                     selected_frames, validate, process, PARAMS)

class SensorTests(unittest.TestCase):
    def setUp(self):
        y,x=np.mgrid[:48,:64];self.image=np.stack([x/64,y/48,(x+y)/112],axis=-1)
    def test_transfer_roundtrip(self):
        np.testing.assert_allclose(srgb(linear(self.image)),self.image,atol=1e-12)
    def test_noise_signal_dependence(self):
        rng=np.random.default_rng(4)
        dark=np.full((400,400),.02);bright=np.full((400,400),.6)
        a=sensor_noise(dark,6,rng);b=sensor_noise(bright,6,rng)
        self.assertGreater(b.var(),a.var()*5)
        self.assertAlmostEqual(a.mean(),.02,delta=.001)
        np.testing.assert_array_equal(sensor_noise(dark,0,rng),dark)
    def test_operations_deterministic_finite(self):
        for kind in set(PARAMS)-{'jpeg'}:
            op={'type':kind}
            a=apply_op(self.image,op,np.random.default_rng(123),.13,self.image,self.image)
            b=apply_op(self.image,op,np.random.default_rng(123),.13,self.image,self.image)
            np.testing.assert_array_equal(a,b)
            self.assertEqual(a.shape,self.image.shape)
            self.assertTrue(np.isfinite(a).all(),kind)
            self.assertGreaterEqual(a.min(),0,kind);self.assertLessEqual(a.max(),1.0000001,kind)
    def test_physical_effects(self):
        a=np.full((48,64,3),.5)
        balanced=apply_op(a,{'type':'white_balance','kelvin':3000},None)
        self.assertGreater(balanced[20,20,0],balanced[20,20,2])
        vignette=apply_op(a,{'type':'vignette'},None)
        self.assertGreater(vignette[24,32,0],vignette[0,0,0])
        impulse=np.zeros_like(a);impulse[24,32]=1
        blurred=apply_op(impulse,{'type':'defocus'},None)
        self.assertLess(blurred.max(),.1);self.assertAlmostEqual(blurred.sum(),3,places=5)
        stripe=np.indices((48,64)).sum(axis=0)%2;stripe=np.repeat(stripe[...,None],3,axis=2).astype(float)
        low=apply_op(stripe,{'type':'downscale'},None)
        self.assertLess(low.std(),stripe.std()/2)
    def test_frame_selection(self):
        self.assertEqual(selected_frames(range(1,9),30,15),[1,3,5,7])
        self.assertEqual(len(selected_frames(range(1,301),30,7)),70)
    def test_lens_projection_matches_image(self):
        # Coordinate ramp allows direct verification of inverse remapping vs forward GT.
        spec={'resolution':[640,480],'camera':{'hfov_deg':120}}
        y,x=np.mgrid[:480,:640];ramp=np.stack([(x+.5)/640,(y+.5)/480,np.zeros_like(x)],axis=-1)
        warped=lens_image(ramp,spec)
        for row,col in ((120,200),(240,500),(350,70)):
            p=distort_points(warped[row,col,:2],spec)
            np.testing.assert_allclose(p,[(col+.5)/640,(row+.5)/480],atol=1e-6)
        np.testing.assert_allclose(distort_points([[0,.5],[1,.5],[.5,.5]],spec),[[0,.5],[1,.5],[.5,.5]])
    def test_rolling_gt(self):
        spec={'fps':30,'resolution':[640,480],'post':[{'type':'rolling_shutter','strength_px':20,'frequency_hz':1}]}
        p=distort_points([[.5,1]],spec,frame=8)
        self.assertGreater(p[0,0],.51)
    def test_mask_warp_agrees_with_keypoints(self):
        spec={'resolution':[640,480],'camera':{'hfov_deg':120},'post':[{'type':'rolling_shutter','strength_px':10}]}
        mask=np.zeros((480,640),dtype=np.uint8);mask[100:110,200:210]=7
        warped=distort_mask(mask,spec,8)
        point=distort_points([[205/640,105/480]],spec,8)[0]
        self.assertEqual(warped[int(point[1]*480),int(point[0]*640)],7)
        self.assertEqual(set(np.unique(warped)),{0,7})
    def test_temporal_blur_is_linear_light(self):
        zero=np.zeros_like(self.image);one=np.ones_like(self.image)
        out=apply_op(zero,{'type':'motion_blur','shutter_frac':1},None,previous=one,following=one)
        np.testing.assert_allclose(linear(out),.5)

    def test_validation(self):
        for op in ({'type':'unknown'},{'type':'noise','sigma':-1},{'type':'noise','sigm':4},{'type':'fps','fps':31},{'type':'defocus','radius_px':float('nan')}):
            with self.assertRaises(ValueError):validate({'post':[op]})
    def test_cli_codec_and_frame_alignment(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);(root/'render').mkdir()
            spec={'seed':32,'fps':30,'resolution':[64,48],'post':[{'type':'noise','sigma':2},{'type':'jpeg','quality':35},{'type':'fps','fps':15}]}
            (root/'spec.json').write_text(json.dumps(spec))
            for n in range(1,6):Image.fromarray(np.uint8(self.image*255)).save(root/'render'/f'{n:06d}.png')
            self.assertEqual(process(root),[1,3,5])
            first=(root/'frames/000001.jpg').read_bytes();process(root)
            self.assertEqual(first,(root/'frames/000001.jpg').read_bytes())
            self.assertFalse((root/'frames/000002.jpg').exists())
            with Image.open(root/'frames/000001.jpg') as frame:self.assertEqual(frame.size,(64,48))
            spec['post']=[];(root/'spec.json').write_text(json.dumps(spec));self.assertEqual(process(root),[1,2,3,4,5])

if __name__=='__main__':unittest.main()
