// CSS colour parsing for the 2D canvas: '#rgb', '#rrggbbaa', rgb()/rgba(), hsl()/hsla(), names.

/** r, g, b, a in 0..1, or null for a string that isn't a colour. */
export type RGBA = readonly [number, number, number, number];

const NAMED: Record<string, number> = {};
// CSS named colours as name:hex pairs.
'aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff beige:f5f5dc bisque:ffe4c4 black:000000 blanchedalmond:ffebcd blue:0000ff blueviolet:8a2be2 brown:a52a2a burlywood:deb887 cadetblue:5f9ea0 chartreuse:7fff00 chocolate:d2691e coral:ff7f50 cornflowerblue:6495ed cornsilk:fff8dc crimson:dc143c cyan:00ffff darkblue:00008b darkcyan:008b8b darkgoldenrod:b8860b darkgray:a9a9a9 darkgreen:006400 darkgrey:a9a9a9 darkkhaki:bdb76b darkmagenta:8b008b darkolivegreen:556b2f darkorange:ff8c00 darkorchid:9932cc darkred:8b0000 darksalmon:e9967a darkseagreen:8fbc8f darkslateblue:483d8b darkslategray:2f4f4f darkslategrey:2f4f4f darkturquoise:00ced1 darkviolet:9400d3 deeppink:ff1493 deepskyblue:00bfff dimgray:696969 dimgrey:696969 dodgerblue:1e90ff firebrick:b22222 floralwhite:fffaf0 forestgreen:228b22 fuchsia:ff00ff gainsboro:dcdcdc ghostwhite:f8f8ff gold:ffd700 goldenrod:daa520 gray:808080 green:008000 greenyellow:adff2f grey:808080 honeydew:f0fff0 hotpink:ff69b4 indianred:cd5c5c indigo:4b0082 ivory:fffff0 khaki:f0e68c lavender:e6e6fa lavenderblush:fff0f5 lawngreen:7cfc00 lemonchiffon:fffacd lightblue:add8e6 lightcoral:f08080 lightcyan:e0ffff lightgoldenrodyellow:fafad2 lightgray:d3d3d3 lightgreen:90ee90 lightgrey:d3d3d3 lightpink:ffb6c1 lightsalmon:ffa07a lightseagreen:20b2aa lightskyblue:87cefa lightslategray:778899 lightslategrey:778899 lightsteelblue:b0c4de lightyellow:ffffe0 lime:00ff00 limegreen:32cd32 linen:faf0e6 magenta:ff00ff maroon:800000 mediumaquamarine:66cdaa mediumblue:0000cd mediumorchid:ba55d3 mediumpurple:9370db mediumseagreen:3cb371 mediumslateblue:7b68ee mediumspringgreen:00fa9a mediumturquoise:48d1cc mediumvioletred:c71585 midnightblue:191970 mintcream:f5fffa mistyrose:ffe4e1 moccasin:ffe4b5 navajowhite:ffdead navy:000080 oldlace:fdf5e6 olive:808000 olivedrab:6b8e23 orange:ffa500 orangered:ff4500 orchid:da70d6 palegoldenrod:eee8aa palegreen:98fb98 paleturquoise:afeeee palevioletred:db7093 papayawhip:ffefd5 peachpuff:ffdab9 peru:cd853f pink:ffc0cb plum:dda0dd powderblue:b0e0e6 purple:800080 rebeccapurple:663399 red:ff0000 rosybrown:bc8f8f royalblue:4169e1 saddlebrown:8b4513 salmon:fa8072 sandybrown:f4a460 seagreen:2e8b57 seashell:fff5ee sienna:a0522d silver:c0c0c0 skyblue:87ceeb slateblue:6a5acd slategray:708090 slategrey:708090 snow:fffafa springgreen:00ff7f steelblue:4682b4 tan:d2b48c teal:008080 thistle:d8bfd8 tomato:ff6347 turquoise:40e0d0 violet:ee82ee wheat:f5deb3 white:ffffff whitesmoke:f5f5f5 yellow:ffff00 yellowgreen:9acd32'
  .split(' ').forEach((pair) => { const [name, hex] = pair.split(':'); NAMED[name] = parseInt(hex, 16); });

const cache = new Map<string, RGBA | null>();
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

function channel(s: string, scale: number) {
  s = s.trim();
  if (s.endsWith('%')) return clamp01(parseFloat(s) / 100);
  return clamp01(parseFloat(s) / scale);
}

function hue2rgb(p: number, q: number, t: number) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function parse(input: string): RGBA | null {
  const s = input.trim().toLowerCase();
  if (s === 'transparent') return [0, 0, 0, 0];
  if (s[0] === '#') {
    const h = s.slice(1);
    if (!/^[0-9a-f]+$/.test(h)) return null;
    if (h.length === 3 || h.length === 4) {
      const v = [...h].map((c) => parseInt(c + c, 16) / 255);
      return [v[0], v[1], v[2], h.length === 4 ? v[3] : 1];
    }
    if (h.length === 6 || h.length === 8) {
      const v = [0, 2, 4, 6].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
      return [v[0], v[1], v[2], h.length === 8 ? v[3] : 1];
    }
    return null;
  }
  const fn = /^(rgba?|hsla?)\((.*)\)$/.exec(s);
  if (fn) {
    const parts = fn[2].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const a = parts.length > 3 ? channel(parts[3], 1) : 1;
    if (fn[1].startsWith('rgb')) return [channel(parts[0], 255), channel(parts[1], 255), channel(parts[2], 255), a];
    const hue = (((parseFloat(parts[0]) % 360) + 360) % 360) / 360;
    const sat = channel(parts[1], 100), light = channel(parts[2], 100);
    if (sat === 0) return [light, light, light, a];
    const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat, p = 2 * light - q;
    return [hue2rgb(p, q, hue + 1 / 3), hue2rgb(p, q, hue), hue2rgb(p, q, hue - 1 / 3), a];
  }
  const named = NAMED[s];
  if (named !== undefined) return [((named >> 16) & 255) / 255, ((named >> 8) & 255) / 255, (named & 255) / 255, 1];
  return null;
}

export function parseColor(input: string): RGBA | null {
  let c = cache.get(input);
  if (c === undefined) {
    c = parse(input);
    if (cache.size > 4096) cache.clear();
    cache.set(input, c);
  }
  return c;
}

/** How a canvas reads its colour back: '#rrggbb' when opaque, else rgba(). */
export function serializeColor(c: RGBA) {
  const b = (x: number) => Math.round(x * 255);
  if (c[3] >= 1) return `#${[c[0], c[1], c[2]].map((x) => b(x).toString(16).padStart(2, '0')).join('')}`;
  return `rgba(${b(c[0])}, ${b(c[1])}, ${b(c[2])}, ${Math.round(c[3] * 1000) / 1000})`;
}
