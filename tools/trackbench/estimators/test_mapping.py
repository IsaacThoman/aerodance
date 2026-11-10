import unittest
import numpy as np
from run import mapped,COCO_TO_MP

class Mapping(unittest.TestCase):
    def test_coco_subject_sides_and_full_frame(self):
        p=np.array([[i*10,i*20] for i in range(17)])
        out=mapped(p,np.ones(17),640,480)['kp']
        self.assertEqual(len(out),33)
        self.assertEqual(out[11],[50/640,100/480,0,1])
        self.assertEqual(out[12],[60/640,120/480,0,1])
        self.assertEqual(out[27],[150/640,300/480,0,1])
        self.assertIsNone(out[29]);self.assertIsNone(out[1])
        self.assertEqual(sum(k is not None for k in out),17)
    def test_feet_are_not_ankles_or_small_toes(self):
        for count, mapping in [(26,{31:20,32:21,29:24,30:25}),(133,{31:17,32:20,29:19,30:22})]:
            out=mapped(np.array([[i,i] for i in range(count)]),np.ones(count),100,100)['kp']
            for dst,src in mapping.items():self.assertEqual(out[dst][0],src/100)
    def test_wholebody_hands_and_face(self):
        out=mapped(np.array([[i,i] for i in range(133)]),np.ones(133),200,200)['kp']
        self.assertEqual(sum(k is not None for k in out),33)
        for dst,src in {1:65,3:68,4:62,6:59,9:77,10:71,17:111,18:132,19:99,20:120,21:95,22:116}.items():
            self.assertEqual(out[dst][0],src/200)
    def test_raw_simcc_confidence_is_explicit(self):
        p=np.zeros((133,2));s=np.full(133,8.)
        self.assertEqual(mapped(p,s,640,480,True)['kp'][11][3],.8)
        self.assertEqual(mapped(p,s,640,480,False)['kp'][11][3],1.)
        self.assertEqual(mapped(p,-s,640,480,True)['kp'][11][3],0.)
if __name__=='__main__':unittest.main()
