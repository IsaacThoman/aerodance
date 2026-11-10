"""Stage-space webcam. See ENVIRONMENT.md for projection and post lens mapping."""
import math
import random
import bpy
from mathutils import Vector, Quaternion


def setup_camera(spec: dict, scene) -> bpy.types.Object:
    c = spec.get('camera', {})
    allowed = {'height_m', 'distance_m', 'yaw_deg', 'look_at', 'hfov_deg', 'roll_deg', 'orientation', 'shake', 'events'}
    if set(c) - allowed:
        raise ValueError(f'Unsupported camera options: {set(c) - allowed}')
    def finite(name, value):
        if not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f'{name} must be a finite number')
    for key in ('height_m','distance_m','yaw_deg','hfov_deg','roll_deg'):
        if key in c:finite('camera.'+key,c[key])
    if 'look_at' in c:
        if len(c['look_at']) != 3:raise ValueError('camera.look_at must contain exactly xyz')
        for value in c['look_at']:finite('camera.look_at',value)
    finite('fps',spec.get('fps',30));finite('duration_s',spec.get('duration_s',12))
    if spec.get('duration_s',12)<=0:raise ValueError('duration_s must be positive')
    width, height = spec.get('resolution', [640, 480])
    if not all(isinstance(v,int) and v>0 for v in (width,height)):
        raise ValueError('resolution must contain two positive integers')
    orientation = c.get('orientation', 'landscape')
    if orientation not in ('portrait', 'landscape'):
        raise ValueError('camera.orientation must be landscape or portrait')
    if orientation == 'portrait':
        width, height = height, width
    fps = spec.get('fps', 30)
    if not (width > 0 and height > 0 and fps > 0):
        raise ValueError('resolution and fps must be positive')
    scene.render.resolution_x, scene.render.resolution_y = width, height
    scene.render.resolution_percentage = 100
    scene.render.pixel_aspect_x = scene.render.pixel_aspect_y = 1
    scene.render.fps = round(fps)
    scene.render.fps_base = round(fps) / fps
    scene.frame_start = 1
    scene.frame_end = max(1, math.ceil(spec.get('duration_s', 12) * fps))
    fov = c.get('hfov_deg', 65)
    if not 15 <= fov <= 120:
        raise ValueError('camera.hfov_deg must be in [15,120]')
    distance = c.get('distance_m', 3.2)
    if distance <= 0:
        raise ValueError('camera.distance_m must be positive')
    target = Vector(c.get('look_at', [0, 0, .95]))
    yaw = math.radians(c.get('yaw_deg', 0))
    position = Vector((target.x + distance * math.sin(yaw), target.y - distance * math.cos(yaw), c.get('height_m', 1)))
    cam = bpy.data.objects.new('TB_camera', bpy.data.cameras.new('TB_camera'))
    scene.collection.objects.link(cam)
    cam['tb_kind'] = 'environment'
    cam.data.sensor_fit = 'HORIZONTAL'
    cam.data.sensor_width = 36
    cam.data.lens = 18 / math.tan(math.radians(fov) / 2)
    cam.data.clip_start, cam.data.clip_end = .05, 200
    cam.location = position
    cam.rotation_mode = 'QUATERNION'
    base = (target - position).to_track_quat('-Z', 'Y')
    shake = c.get('shake') or {}
    if set(shake) - {'amp_deg', 'freq_hz'}:
        raise ValueError('camera.shake supports amp_deg and freq_hz only')
    amp, freq = shake.get('amp_deg', 0), shake.get('freq_hz', 2)
    finite('camera.shake.amp_deg',amp);finite('camera.shake.freq_hz',freq)
    if amp < 0 or freq < 0:
        raise ValueError('camera shake amplitude and frequency must be nonnegative')
    events = c.get('events', [])
    for event in events:
        if event.get('type') != 'bump' or set(event) - {'type', 't_s', 'yaw_deg', 'pitch_deg', 'roll_deg'}:
            raise ValueError(f'Unsupported camera event: {event}')
        for key,value in event.items():
            if key!='type':finite('camera.events.'+key,value)
        if event.get('t_s', -1) < 0:
            raise ValueError('bump requires nonnegative t_s')
    rng = random.Random(spec.get('seed', 1))
    phases = [rng.uniform(0, math.tau) for _ in range(6)]
    for frame in range(1, scene.frame_end + 1):
        t = (frame - 1) / fps
        angles = [0, 0, c.get('roll_deg', 0)]
        for event in events:
            if t >= event['t_s']:
                for i, key in enumerate(('pitch_deg', 'yaw_deg', 'roll_deg')):
                    angles[i] += event.get(key, 0)
        for i in range(3):
            angles[i] += amp * (.7 * math.sin(math.tau * freq * t + phases[i]) + .3 * math.sin(math.tau * freq * .47 * t + phases[i + 3]))
        # Local pitch, yaw, roll around the optical frame. Positive yaw turns right.
        cam.rotation_quaternion = base @ Quaternion((0, 1, 0), -math.radians(angles[1])) @ Quaternion((1, 0, 0), math.radians(angles[0])) @ Quaternion((0, 0, 1), math.radians(angles[2]))
        cam.keyframe_insert('rotation_quaternion', frame=frame)
    # Linear dense samples keep shake smooth; a bump is a discontinuity.
    if cam.animation_data:
        for layer in cam.animation_data.action.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    for curve in bag.fcurves:
                        for key in curve.keyframe_points:
                            key.interpolation = 'CONSTANT' if any(int(key.co.x) == math.ceil(e['t_s'] * fps) for e in events) else 'LINEAR'
    scene.camera = cam
    scene.frame_set(1)
    return cam
