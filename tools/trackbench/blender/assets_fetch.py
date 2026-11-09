"""Fetch only the assets used by environment.py; stdlib + curl, safe to rerun."""
import hashlib
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(os.environ.get('TRACKBENCH_DATA', '/Volumes/development/aerodance-trackbench'))
CACHE = ROOT / 'downloads/polyhaven'
MODELS = ('sofa_03', 'modern_coffee_table_01', 'modern_wooden_cabinet',
          'wooden_bookshelf_worn', 'potted_plant_02', 'desk_lamp_arm_01',
          'vintage_day_bed', 'dining_table')
TEXTURES = ('wood_floor', 'white_plaster_02', 'concrete_floor', 'patterned_plaster_wall')
HDRIS = ('kiara_interior', 'residential_garden')

def api(path):
    return json.loads(subprocess.check_output(['curl', '-fLsS', '--retry', '3',
                                               'https://api.polyhaven.com/' + path]))

def download(entry, dest):
    dest.parent.mkdir(parents=True, exist_ok=True)
    def valid(p):
        return p.exists() and p.stat().st_size == entry['size'] and hashlib.md5(p.read_bytes()).hexdigest() == entry['md5']
    if valid(dest):
        return
    partial = dest.with_suffix(dest.suffix + '.part')
    subprocess.run(['curl', '-fLsS', '--retry', '4', '-C', '-', '-o', str(partial), entry['url']], check=True)
    if not valid(partial):
        partial.unlink(missing_ok=True)
        raise RuntimeError(f'Integrity check failed: {dest}; rerun to download again')
    partial.replace(dest)

def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    manifest = {}
    for typ, ids in [('models', MODELS), ('textures', TEXTURES), ('hdris', HDRIS)]:
        catalog = api('assets?t=' + typ)
        for ident in ids:
            print('Fetch', ident, flush=True)
            files = api('files/' + ident)
            chosen = {}
            if typ == 'models':
                entry = files['blend']['1k']['blend']
                chosen['model.blend'] = entry
                chosen.update(entry.get('include', {}))
            elif typ == 'hdris':
                chosen['world.hdr'] = files['hdri']['1k']['hdr']
            else:
                for channel in ('diff', 'rough', 'nor_gl'):
                    key = next(k for k in files if k.lower() == ('diffuse' if channel == 'diff' else channel))
                    formats = files[key]['1k']
                    ext = 'jpg' if 'jpg' in formats else 'png'
                    chosen[channel + '.' + ext] = formats[ext]
            for name, entry in chosen.items():
                download(entry, CACHE / ident / name)
            manifest[ident] = dict(type=typ, license='CC0-1.0', license_url='https://polyhaven.com/license',
                                   authors=catalog[ident]['authors'], source='https://polyhaven.com/a/' + ident,
                                   files=chosen)
            tmp = CACHE / 'manifest.json.tmp'
            tmp.write_text(json.dumps(manifest, indent=2) + '\n')
            tmp.replace(CACHE / 'manifest.json')

if __name__ == '__main__':
    main()
