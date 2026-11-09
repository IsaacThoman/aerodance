#!/usr/bin/env python3
"""Writes the synthetic twin specs (scenes/twin-*.json) for the real sim2real sequences.

Each twin matches its real condition's framing (picture size the camera delivers before
reframing, person height in the picture, camera height), dancer count, spacing, setting and
clothes as closely as the generator allows. The motion can't match (the real dancers aren't
AIST++ dancers), so pairing is per condition, not per frame. Framing numbers come from a
YOLO26x pass over the real clips (README "Twins").

python3 tools/trackbench/sim2real/make_twins.py
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'scenes')
DUR = 20.0


def person(pid, body, skin, hair, clothes, recolor, x, y, clip, start=4.0, mirror=False, travel=0.15, facing=0):
    return {
        'id': pid, 'role': 'player', 'body': body, 'skin': skin, 'hair': hair,
        'outfit': {'clothes': clothes, 'recolor': recolor},
        'place': {'x': x, 'y': y, 'facing_deg': facing}, 'travel': travel,
        'timeline': [{'type': 'dance', 'clip': clip, 'clip_start_s': start, 'duration_s': DUR, 'mirror': mirror}],
    }


def woman(age=0.42, height=0.5, race='caucasian', weight=0.5):
    return {'gender': 0.0, 'age': age, 'weight': weight, 'muscle': 0.5, 'height': height, 'proportions': 0.5,
            'race': {k: float(k == race) for k in ('african', 'asian', 'caucasian')}}


def man(age=0.45, height=0.5, race='caucasian', weight=0.5):
    b = woman(age, height, race, weight)
    b['gender'] = 1.0
    return b


def spec(sid, description, players, people, camera, room, lighting, resolution, orientation='landscape', seed=1, duration=DUR):
    for p in people:
        p['timeline'][0]['duration_s'] = duration
    return {
        'id': sid, 'category': 'sim2real', 'description': description, 'seed': seed,
        'duration_s': duration, 'fps': 30, 'resolution': resolution, 'players': players,
        'camera': {**camera, 'orientation': orientation, 'roll_deg': 0, 'shake': None, 'events': []},
        'room': room, 'lighting': lighting, 'people': people,
        'phases': [{'name': 'dance', 'start_s': 0, 'end_s': duration}], 'post': [],
    }


SPECS = []

# Solo on a stage (real: 640x360 landscape, cropped 480x360 then scaled to 640x480; dancer
# 0.58 of the picture height, centred, camera about hip height).
for k, (clip, skin, race) in enumerate([
        ('gHO_sFM_cAll_d19_mHO5_ch06', 'young_caucasian_female', 'caucasian'),
        ('gLH_sFM_cAll_d16_mLH4_ch05', 'young_asian_female', 'asian'),
        ('gJS_sFM_cAll_d02_mJS3_ch04', 'young_caucasian_female2', 'caucasian')], 1):
    SPECS.append(spec(
        f'twin-stage-{k}', 'Twin of real-stage: one woman, pink top and grey joggers, plain room, camera at hip height ~4 m away.', 1,
        [person('p1', woman(race=race), skin, 'long01', ['female_sportsuit01', 'shoes02'], {'top': '#f2b8c6', 'bottom': '#a8a8ac'},
                0, 0, clip, travel=0.3)],
        {'height_m': 1.0, 'distance_m': 4.0, 'look_at': [0, 0, 0.95], 'hfov_deg': 50},
        {'preset': 'plain_wall', 'clutter': 0.2, 'features': []},
        {'preset': 'bright_even', 'exposure_ev': 0, 'color_temp_k': 3800, 'flicker_hz': 0},
        [480, 360], seed=10 + k))

# Child dancing in a living room, portrait phone (real: 406x720 portrait scaled to 360x640 and
# padded to 480x640; dancer 0.58 of the height, close camera, warm evening light).
for k, (clip, hair) in enumerate([
        ('gJS_sFM_cAll_d03_mJS3_ch04', 'long01'), ('gPO_sFM_cAll_d10_mPO1_ch02', 'ponytail01'),
        ('gLO_sFM_cAll_d14_mLO2_ch10', 'bob02'), ('gHO_sFM_cAll_d21_mHO5_ch20', 'braid01')], 1):
    SPECS.append(spec(
        f'twin-living-{k}', 'Twin of real-living: a child dancing in a living room, portrait phone close by, warm light.', 1,
        [person('p1', woman(age=0.2, height=0.45), 'young_caucasian_female', hair, ['female_casualsuit01', 'shoes01'],
                {'top': '#7a2f6a', 'bottom': '#55596a', 'shoes': '#f0f0f0'}, 0, 0, clip, travel=0.2)],
        {'height_m': 1.1, 'distance_m': 1.9, 'look_at': [0, 0, 0.75], 'hfov_deg': 44},
        {'preset': 'living_room', 'clutter': 0.6, 'features': []},
        {'preset': 'dim_evening', 'exposure_ev': 0.5, 'color_temp_k': 3000, 'flicker_hz': 0},
        [640, 360], orientation='portrait', seed=20 + k))

# Three women close together in a white hallway, portrait phone (real c1).
SPECS.append(spec(
    'twin-c1', 'Twin of real-c1: three women side by side ~0.65 m apart in jeans, bright room, portrait phone.', 3,
    [person('p1', woman(race='caucasian'), 'young_caucasian_female', 'long01', ['female_casualsuit01', 'shoes02'], {'top': '#e8508a', 'bottom': '#4a6ea8'}, -0.65, 0, 'gJS_sFM_cAll_d01_mJS3_ch04', travel=0.1),
     person('p2', woman(race='caucasian'), 'young_caucasian_female2', 'long01', ['female_casualsuit01', 'shoes02'], {'top': '#1a1a1a', 'bottom': '#5a7eb8'}, 0, 0, 'gJS_sFM_cAll_d02_mJS3_ch04', travel=0.1),
     person('p3', woman(race='asian'), 'young_asian_female', 'long01', ['female_casualsuit01', 'shoes01'], {'top': '#f2f2f2', 'bottom': '#4a6ea8'}, 0.65, 0, 'gJS_sFM_cAll_d03_mJS3_ch04', travel=0.1)],
    {'height_m': 1.2, 'distance_m': 2.3, 'look_at': [0, 0, 0.85], 'hfov_deg': 45},
    {'preset': 'plain_wall', 'clutter': 0.3, 'features': []},
    {'preset': 'bright_even', 'exposure_ev': 0.3, 'color_temp_k': 5000, 'flicker_hz': 0},
    [640, 360], orientation='portrait', seed=31, duration=11.0))

# Four women outdoors, 0.6 m apart, further away (real c2).
SPECS.append(spec(
    'twin-c2', 'Twin of real-c2: four women ~0.6 m apart outdoors, portrait phone ~3.7 m away.', 4,
    [person(f'p{i + 1}', woman(race=r), s, h, ['female_casualsuit01', 'shoes02'], {'top': t, 'bottom': b}, x, 0, c, mirror=m, travel=0.1)
     for i, (r, s, h, t, b, x, c, m) in enumerate([
         ('caucasian', 'young_caucasian_female', 'long01', '#e8e0d0', '#7a7560', -0.9, 'gPO_sFM_cAll_d10_mPO1_ch02', False),
         ('caucasian', 'young_caucasian_female2', 'ponytail01', '#f0f0f0', '#9ab0c8', -0.3, 'gPO_sFM_cAll_d11_mPO1_ch09', False),
         ('asian', 'young_asian_female', 'long01', '#202020', '#202020', 0.3, 'gPO_sFM_cAll_d12_mPO1_ch16', False),
         ('caucasian', 'young_caucasian_female', 'bob01', '#d8d8d8', '#a0b8d0', 0.9, 'gPO_sFM_cAll_d10_mPO1_ch02', True)])],
    {'height_m': 1.3, 'distance_m': 3.7, 'look_at': [0, 0, 0.85], 'hfov_deg': 45},
    {'preset': 'backyard', 'clutter': 0.3, 'features': []},
    {'preset': 'daylight_side', 'exposure_ev': 0, 'color_temp_k': 5600, 'flicker_hz': 0},
    [640, 360], orientation='portrait', seed=32, duration=19.9))

# Four men in suits in a living room (real c3).
SPECS.append(spec(
    'twin-c3', 'Twin of real-c3: four men in suits ~0.62 m apart in a living room, portrait phone ~3.4 m away.', 4,
    [person(f'p{i + 1}', man(race=r), s, h, [cl, 'shoes03'], rc, x, 0, c, mirror=m, travel=0.1)
     for i, (r, s, h, cl, rc, x, c, m) in enumerate([
         ('caucasian', 'young_caucasian_male', 'short02', 'male_elegantsuit01', {'top': '#707070', 'bottom': '#707070'}, -0.93, 'gMH_sFM_cAll_d22_mMH3_ch04', False),
         ('caucasian', 'young_caucasian_male2', 'short04', 'male_elegantsuit01', {'top': '#303030', 'bottom': '#303030'}, -0.31, 'gMH_sFM_cAll_d23_mMH3_ch11', False),
         ('asian', 'young_asian_male', 'short01', 'male_elegantsuit01', {'top': '#1a1a1a', 'bottom': '#1a1a1a'}, 0.31, 'gMH_sFM_cAll_d24_mMH3_ch18', False),
         ('caucasian', 'young_caucasian_male', 'short03', 'male_elegantsuit01', {'top': '#808080', 'bottom': '#808080'}, 0.93, 'gMH_sFM_cAll_d22_mMH3_ch04', True)])],
    {'height_m': 1.3, 'distance_m': 3.4, 'look_at': [0, 0, 0.9], 'hfov_deg': 45},
    {'preset': 'living_room', 'clutter': 0.5, 'features': []},
    {'preset': 'bright_even', 'exposure_ev': 0, 'color_temp_k': 4200, 'flicker_hz': 0},
    [640, 360], orientation='portrait', seed=33, duration=21.6))

# Four look-alikes (same orange top, white bottoms) outdoors, landscape, far camera (real atd).
for k, clips in enumerate([
        ['gHO_sFM_cAll_d19_mHO5_ch06', 'gHO_sFM_cAll_d21_mHO5_ch20', 'gHO_sFM_cAll_d19_mHO5_ch06', 'gHO_sFM_cAll_d21_mHO5_ch20'],
        ['gLH_sFM_cAll_d16_mLH4_ch05', 'gLH_sFM_cAll_d17_mLH4_ch12', 'gLH_sFM_cAll_d18_mLH4_ch19', 'gLH_sFM_cAll_d16_mLH4_ch05'],
        ['gMH_sFM_cAll_d22_mMH3_ch04', 'gMH_sFM_cAll_d23_mMH3_ch11', 'gMH_sFM_cAll_d24_mMH3_ch18', 'gMH_sFM_cAll_d23_mMH3_ch11']], 1):
    people = []
    for i, (x, g) in enumerate([(-1.95, 'f'), (-0.65, 'm'), (0.65, 'f'), (1.95, 'm')]):
        if g == 'f':
            people.append(person(f'p{i + 1}', woman(race='asian', age=0.5), 'young_asian_female', 'ponytail01',
                                 ['female_sportsuit01', 'tb_skirt', 'shoes01'], {'top': '#f07020', 'bottom': '#f4f4f4', 'skirt': '#f4f4f4'},
                                 x, 0, clips[i], mirror=i == 3, travel=0.15))
        else:
            people.append(person(f'p{i + 1}', man(race='asian', age=0.55), 'young_asian_male', 'short02',
                                 ['male_casualsuit04', 'shoes01'], {'top': '#f07020', 'bottom': '#f4f4f4'},
                                 x, 0, clips[i], mirror=i == 3, travel=0.15))
    SPECS.append(spec(
        f'twin-atd-{k}', 'Twin of real-atd: four look-alikes (orange tops, white bottoms) ~1.3 m apart outdoors, landscape camera ~6 m away.', 4,
        people, {'height_m': 1.4, 'distance_m': 6.5, 'look_at': [0, 0, 0.85], 'hfov_deg': 65},
        {'preset': 'backyard', 'clutter': 0.4, 'features': []},
        {'preset': 'daylight_side', 'exposure_ev': 0, 'color_temp_k': 5600, 'flicker_hz': 0},
        [640, 360], seed=40 + k))

if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    for s in SPECS:
        with open(os.path.join(OUT, s['id'] + '.json'), 'w') as f:
            json.dump(s, f, indent=1)
            f.write('\n')
    print(len(SPECS), 'specs in', OUT)
