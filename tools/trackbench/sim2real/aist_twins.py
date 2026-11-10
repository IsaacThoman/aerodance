#!/usr/bin/env python3
"""Synthetic twins of the real-aist sequences: scenes/twin-aist-<id>.json.

Same AIST++ motion and window (clip seconds 4-19) as the real video, travel 1 (the dancer
wanders as they really did), camera at the AIST camera's height, horizontal distance and
angle to the dancer's facing (the camera stays in front, inside the
room, and the dancer is turned by -view instead: the same relative geometry), with the real crop's field of view and aim (aist_cameras.json,
written by aist_scenes.py). Body, hair and clothes approximate the real dancer's (from looking
at the video); the room is trackbench's plain room (the AIST studio is white on white, which
the generator has no preset for).

python3 tools/trackbench/sim2real/aist_twins.py
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
CFG = json.load(open(os.path.join(HERE, 'aist.json')))
CAMS = json.load(open(os.path.join(HERE, 'aist_cameras.json')))

F, M = 0.0, 1.0
# id: (gender, race, skin, hair, clothes, recolor)
LOOK = {
    'br-c01': (M, 'asian', 'young_asian_male', 'short02', ['male_casualsuit03', 'shoes02'], {'top': '#3a3a3e', 'bottom': '#4a6a90'}),
    'ho-c08': (F, 'asian', 'young_asian_female', 'bob01', ['female_casualsuit01', 'shoes02'], {'top': '#c8b49a', 'bottom': '#1a1a1a'}),
    'ho-c02': (F, 'asian', 'young_asian_female', 'bob02', ['female_casualsuit01', 'shoes02', 'fedora01'], {'top': '#c8b49a', 'bottom': '#1a1a1a', 'hat': '#202020'}),
    'jb-c01': (F, 'asian', 'young_asian_female', 'ponytail01', ['female_sportsuit01'], {'top': '#151515', 'bottom': '#151515'}),
    'jb-c04': (F, 'asian', 'young_asian_female', 'ponytail01', ['female_sportsuit01'], {'top': '#151515', 'bottom': '#151515'}),
    'js-c01': (F, 'asian', 'young_asian_female', 'bob01', ['female_sportsuit01'], {'top': '#181818', 'bottom': '#181818'}),
    'js-c02': (F, 'asian', 'young_asian_female', 'afro01', ['female_sportsuit01', 'shoes04'], {'top': '#151515', 'bottom': '#151515'}),
    'kr-c01': (M, 'asian', 'young_asian_male', 'short01', ['male_casualsuit03', 'shoes02'], {'top': '#151515', 'bottom': '#151515'}),
    'kr-c05': (M, 'asian', 'young_asian_male', 'short04', ['male_casualsuit03', 'shoes02'], {'top': '#202020', 'bottom': '#202020'}),
    'lh-c01': (F, 'asian', 'young_asian_female', 'bob02', ['female_casualsuit01', 'shoes02'], {'top': '#8a6a50', 'bottom': '#4a6a90'}),
    'lh-c07': (M, 'asian', 'young_asian_male', 'short02', ['male_casualsuit04', 'shoes02'], {'top': '#4a5068', 'bottom': '#b8a888'}),
    'lo-c01': (F, 'asian', 'young_asian_female', 'bob01', ['female_elegantsuit01', 'shoes03', 'fedora01'], {'top': '#8a8070', 'bottom': '#8a8070', 'hat': '#151515'}),
    'lo-c08': (F, 'asian', 'young_asian_female', 'bob01', ['female_elegantsuit01', 'shoes03', 'fedora01'], {'top': '#8c8c8c', 'bottom': '#8c8c8c', 'hat': '#151515'}),
    'mh-c01': (M, 'asian', 'young_asian_male', 'short03', ['male_casualsuit04', 'shoes02'], {'top': '#1e2440', 'bottom': '#b8a888'}),
    'mh-c05': (M, 'asian', 'young_asian_male', 'short03', ['male_casualsuit04', 'shoes02'], {'top': '#151515', 'bottom': '#151515'}),
    'po-c01': (F, 'asian', 'young_asian_female', 'bob02', ['female_casualsuit01', 'shoes02'], {'top': '#181818', 'bottom': '#2c3a28'}),
    'po-c09': (M, 'asian', 'young_asian_male', 'short01', ['male_casualsuit04', 'shoes02', 'fedora01'], {'top': '#1e2440', 'bottom': '#151515', 'hat': '#802020'}),
    'wa-c02': (F, 'asian', 'young_asian_female', 'long01', ['female_sportsuit01', 'shoes03'], {'top': '#151515', 'bottom': '#151515'}),
}

if __name__ == '__main__':
    os.makedirs(os.path.join(HERE, 'scenes'), exist_ok=True)
    for k, e in enumerate(CFG['sequences']):
        cam = CAMS[e['id']]
        g, race, skin, hair, clothes, recolor = LOOK[e['id']]
        sid = 'twin-aist-' + e['id']
        spec = {
            'id': sid, 'category': 'sim2real-aist', 'seed': 100 + k,
            'description': f'Twin of real-aist-{e["id"]}: {e["seq"]} seconds {CFG["start_s"]}-{CFG["start_s"] + CFG["duration_s"]}, camera like AIST {e["cam"]} ({e["view"]}).',
            'duration_s': CFG['duration_s'], 'fps': 30, 'resolution': [640, 480], 'players': 1,
            'camera': {'height_m': cam['height_m'], 'distance_m': cam['distance_m'], 'yaw_deg': 0,
                       'look_at': [0, 0, cam['look_at_z']], 'hfov_deg': cam['hfov_deg'], 'roll_deg': 0,
                       'orientation': 'landscape', 'shake': None, 'events': []},
            'room': {'preset': 'plain_wall', 'clutter': 0.0, 'features': []},
            'lighting': {'preset': 'bright_even', 'exposure_ev': 0.7, 'color_temp_k': 5500, 'flicker_hz': 0},
            'people': [{
                'id': 'p1', 'role': 'player',
                'body': {'gender': g, 'age': 0.45, 'weight': 0.5, 'muscle': 0.5, 'height': 0.5, 'proportions': 0.5,
                         'race': {r: float(r == race) for r in ('african', 'asian', 'caucasian')}},
                'skin': skin, 'hair': hair, 'outfit': {'clothes': clothes, 'recolor': recolor},
                'place': {'x': 0, 'y': 0, 'facing_deg': round(-cam['yaw_deg'], 1)}, 'travel': 1.0,
                'timeline': [{'type': 'dance', 'clip': e['seq'], 'clip_start_s': CFG['start_s'], 'duration_s': CFG['duration_s'], 'mirror': False}],
            }],
            'phases': [{'name': 'dance', 'start_s': 0, 'end_s': CFG['duration_s']}],
            'post': [],
        }
        with open(os.path.join(HERE, 'scenes', sid + '.json'), 'w') as f:
            json.dump(spec, f, indent=1)
            f.write('\n')
    print(len(CFG['sequences']), 'twin-aist specs')
