// Rebuild the local, interactive contact sheet after rendering --top-shelf.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Shot } from '../client/src/shots.ts';

const root = new URL('../top-shelf/', import.meta.url);
const files = (await readdir(new URL('specs/', root))).filter((f) => f.endsWith('.json')).sort();
const shots: Shot[] = (await Promise.all(files.map(async (file) => JSON.parse(await readFile(new URL(`specs/${file}`, root), 'utf8')) as Shot[]))).flat();
const titles: Record<string, [title: string, detail: string]> = {
  'meadow-duet': ['Meadow duet', 'Floating islands, wildflowers, and a wide, welcoming duet.'],
  'cloudside-groove': ['Cloudside groove', 'Characters on the right; the meadow carries the title on the left.'],
  'beach-horizon': ['Horizon party', 'Two dancers frame the sunset and its path across the ocean.'],
  'sunset-side-story': ['Sunset side story', 'A compact duet balanced by warm sky and an offset wordmark.'],
  'city-skygarden-panorama': ['Skygarden panorama', 'A glass city beyond the rooftop garden and infinity pool.'],
  'city-rooftop-duet': ['Rooftop duet', 'A closer character composition against the sunny eco-city.'],
  'club-midnight-duet': ['Midnight duet', 'Aquarium blues, glossy characters, and a quieter neon moment.'],
  'club-laser-panorama': ['Laser panorama', 'A diagonal view across the crowd, LED floor, and DJ stage.'],
  'reef-glass-duet': ['Glass duet', 'An intimate pair under the dome, with a stacked title.'],
  'reef-dome-panorama': ['Underwater dance hall', 'The full glass dome and surrounding reef life.'],
  'openreef-coral-garden': ['Coral garden', 'Colorful coral, caustics, and a duet on the open sand.'],
  'openreef-turtle-procession': ['Dance with the current', 'Open water, swimming wildlife, and a left-aligned duet.'],
};
const order = ['meadow-duet', 'cloudside-groove', 'beach-horizon', 'sunset-side-story', 'city-skygarden-panorama', 'city-rooftop-duet', 'reef-glass-duet', 'reef-dome-panorama', 'openreef-coral-garden', 'openreef-turtle-procession', 'club-midnight-duet', 'club-laser-panorama'];
shots.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
const cards = shots.map((shot, index) => {
  const [title, detail] = titles[shot.id] ?? [shot.id, shot.stage];
  const versions = ['wide', 'standard'].flatMap((format) => ['with-logo', 'no-logo'].map((logo) => {
    const src = `renders/${format}/${logo}/${shot.id}`;
    return `<div class="version" data-format="${format}" data-logo="${logo}"><a href="${src}@2x.png" target="_blank" rel="noopener" aria-label="Open ${title} at full resolution"><img src="${src}.png" alt="${title}, ${format}, ${logo}" loading="eager"></a><div class="downloads"><a href="${src}.png" download>1× PNG</a><a href="${src}@2x.png" download>2× PNG</a></div></div>`;
  })).join('');
  return `<article><div class="label"><span class="number">${String(index + 1).padStart(2, '0')}</span><strong>${title}</strong><span class="stage">${shot.stage}</span></div>${versions}<p class="detail">${detail}</p></article>`;
}).join('\n');

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Aerodance · Top Shelf ideas</title><style>
:root { color-scheme:light dark }
* {box-sizing:border-box} body {margin:0;color:var(--foreground,CanvasText);font-family:var(--font-sans,system-ui,sans-serif);font-size:14px} .intro {margin:0 0 14px;line-height:1.6;color:var(--muted-foreground,#829298)}
.controls {display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px} button {font:inherit;color:var(--foreground,CanvasText);border:1px solid var(--border,#829298);border-radius:7px;padding:8px 12px;background:transparent;cursor:pointer} button[aria-pressed=true] {background:var(--foreground,CanvasText);color:var(--background,Canvas)} label {display:flex;gap:6px;align-items:center;margin-left:auto} input {accent-color:var(--accent,#0b9b89)}
.dimensions {font-size:12px;color:var(--muted-foreground,#829298);margin:0 0 22px} article {margin-bottom:24px} .label {display:flex;align-items:center;gap:9px;margin-bottom:9px} .number {font-variant-numeric:tabular-nums;color:var(--muted-foreground,#829298);font-size:12px} strong {font-weight:600} .stage {margin-left:auto;color:var(--muted-foreground,#829298);font-size:11px;text-transform:uppercase;letter-spacing:1px}
img {display:block;width:100%;height:auto;image-rendering:pixelated} .version>a {display:block} .detail {color:var(--muted-foreground,#829298);font-size:12px;line-height:1.5;margin:5px 0 0} .downloads {display:flex;gap:12px;margin-top:7px;font-size:11px} a {color:var(--accent,#0b9b89);text-underline-offset:3px} .version {display:none} body[data-format=wide][data-logo=with-logo] .version[data-format=wide][data-logo=with-logo],body[data-format=wide][data-logo=no-logo] .version[data-format=wide][data-logo=no-logo],body[data-format=standard][data-logo=with-logo] .version[data-format=standard][data-logo=with-logo],body[data-format=standard][data-logo=no-logo] .version[data-format=standard][data-logo=no-logo] {display:block}
@media(max-width:420px){button{padding:7px 9px}.controls{gap:6px}label{font-size:12px}.stage{font-size:10px}.detail{font-size:11px}}
</style></head><body data-format="wide" data-logo="with-logo"><p class="intro">12 concepts rendered from the actual game scenes, glass dancers, lighting, and pixel grid. Select a shape, toggle the wordmark, or open any image at full resolution.</p><div class="controls"><button id="wide" aria-pressed="true">Wide · 29:9</button><button id="standard" aria-pressed="false">Standard · 8:3</button><label><input id="logo" type="checkbox" checked> Wordmark</label></div><p class="dimensions" id="dimensions">2320 × 720 at 1× · 4640 × 1440 at 2×</p>${cards}<script>
for (const format of ['wide','standard']) document.getElementById(format).addEventListener('click',()=>{document.body.dataset.format=format;for(const f of ['wide','standard'])document.getElementById(f).setAttribute('aria-pressed',String(f===format));document.getElementById('dimensions').textContent=format==='wide'?'2320 × 720 at 1× · 4640 × 1440 at 2×':'1920 × 720 at 1× · 3840 × 1440 at 2×';});
document.getElementById('logo').addEventListener('change',event=>{document.body.dataset.logo=event.target.checked?'with-logo':'no-logo';});
Promise.all([...document.images].map(img=>img.complete?Promise.resolve():new Promise(resolve=>{img.onload=resolve;img.onerror=resolve}))).then(()=>{const broken=[...document.images].filter(img=>img.naturalWidth===0);console.log('Gallery images:',document.images.length,'Broken:',broken.length);if(broken.length)console.error(broken.map(img=>img.src));});
</script></body></html>`;
await writeFile(new URL('index.html', root), html);
console.log(fileURLToPath(new URL('index.html', root)));
