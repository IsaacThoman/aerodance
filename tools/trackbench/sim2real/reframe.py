"""The picture geometry shared by real sequences and their synthetic twins.

A source picture (a real video frame, or a twin's lossless render at the same size) becomes
the game's 640x480 (or 480x640 portrait-phone) frame by one of:

- `crop_scale`: crop `[x0, y0, w, h]` source pixels, scale to `out` (the 640x360 stage clip:
  the middle 480x360, scaled up);
- `scale_pad`: scale to `scale` and pad (black, centred) to `out` (9:16 phone video to 3:4);
- `pad`: pad (black, centred) to `out` (16:9 to 4:3 letterbox).

Both domains go through the same code, so resampling, padding and JPEG quality match.
"""
import cv2
import numpy as np


def geometry(op, src_w, src_h):
    """(scale, offset_x, offset_y, out_w, out_h, crop) mapping source pixels to output pixels: out = (src - crop0) * scale + offset."""
    kind = op['op']
    ow, oh = op['out']
    if kind == 'crop_scale':
        x0, y0, w, h = op['crop']
        s = ow / w
        assert abs(oh / h - s) < 1e-6, 'crop_scale keeps the aspect ratio'
        return s, 0.0, 0.0, ow, oh, (x0, y0, w, h)
    if kind == 'scale_pad':
        sw, sh = op['scale']
        s = sw / src_w
        assert abs(sh / src_h - s) < 0.01, 'scale_pad keeps the aspect ratio'
        return s, (ow - sw) / 2, (oh - sh) / 2, ow, oh, (0, 0, src_w, src_h)
    if kind == 'pad':
        return 1.0, (ow - src_w) / 2, (oh - src_h) / 2, ow, oh, (0, 0, src_w, src_h)
    raise ValueError(kind)


def apply(img, op):
    """An RGB/BGR uint8 picture through the op."""
    h, w = img.shape[:2]
    s, ox, oy, ow, oh, (x0, y0, cw, ch) = geometry(op, w, h)
    img = img[int(y0):int(y0 + ch), int(x0):int(x0 + cw)]
    if s != 1.0:
        tw, th = round(cw * s), round(ch * s)
        img = cv2.resize(img, (tw, th), interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_CUBIC)
    out = np.zeros((oh, ow, 3), np.uint8)
    ix, iy = int(round(ox)), int(round(oy))
    out[iy:iy + img.shape[0], ix:ix + img.shape[1]] = img
    return out


def map_points(xy_norm, op, src_w, src_h):
    """Normalized source coordinates (..., 2) to normalized output coordinates."""
    s, ox, oy, ow, oh, (x0, y0, _, _) = geometry(op, src_w, src_h)
    xy = np.asarray(xy_norm, np.float64)
    px = (xy[..., 0] * src_w - x0) * s + ox
    py = (xy[..., 1] * src_h - y0) * s + oy
    return np.stack([px / ow, py / oh], -1)


def unmap_points(xy_norm, op, src_w, src_h):
    """Inverse of map_points."""
    s, ox, oy, ow, oh, (x0, y0, _, _) = geometry(op, src_w, src_h)
    xy = np.asarray(xy_norm, np.float64)
    sx = ((xy[..., 0] * ow - ox) / s + x0) / src_w
    sy = ((xy[..., 1] * oh - oy) / s + y0) / src_h
    return np.stack([sx, sy], -1)


def content_box(op, src_w, src_h):
    """The output region (normalized x0, y0, x1, y1) that shows source pixels (not padding)."""
    s, ox, oy, ow, oh, (_, _, cw, ch) = geometry(op, src_w, src_h)
    return (ox / ow, oy / oh, (ox + cw * s) / ow, (oy + ch * s) / oh)
