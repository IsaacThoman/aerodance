#!/usr/bin/env python3
"""estimators/run.py with each model capped at a few CPU threads (S2R_THREADS, default 3).

On the shared machine, every ONNX Runtime / torch / TensorFlow session otherwise starts one
thread per core and parallel runs thrash (load average > 100 on 18 cores). The cap changes
only speed, not outputs; sim2real measures accuracy, never these timings.

  run_limited.py <run.py arguments...>
"""
import os
import runpy
import sys

N = int(os.environ.get('S2R_THREADS', '3'))
for k in ('OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS', 'TF_NUM_INTRAOP_THREADS'):
    os.environ[k] = str(N)
os.environ['TF_NUM_INTEROP_THREADS'] = '1'

import onnxruntime as ort  # noqa: E402

_init = ort.InferenceSession.__init__


def _limited(self, path_or_bytes, sess_options=None, *a, **k):
    so = sess_options or ort.SessionOptions()
    so.intra_op_num_threads = N
    so.inter_op_num_threads = 1
    _init(self, path_or_bytes, so, *a, **k)


ort.InferenceSession.__init__ = _limited
try:
    import cv2
    cv2.setNumThreads(N)
except ImportError:
    pass

RUN = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'estimators', 'run.py')
sys.argv = [RUN] + sys.argv[1:]
sys.path.insert(0, os.path.dirname(RUN))
runpy.run_path(RUN, run_name='__main__')
