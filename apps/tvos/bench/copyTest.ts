// Native-host regression: framebuffer copies must ignore scissor and retain bindings.
// Launch with script: bench/copy-test.js, report: file, glDebug: true; inspect the
// copy-test report in Library/Caches/aerodance-bench.ndjson. copyBlit:false is the reference.
import { native, Q } from '../runtime/native.ts';

const canvas = document.createElement('canvas');
canvas.width = 640; canvas.height = 480;
document.body.appendChild(canvas);
const gl = canvas.getContext('webgl2', { antialias: false })!;
const results: { width: number; height: number; scissor: boolean; partial: boolean; differingBytes: number; error: number }[] = [];

for (const [width, height] of [[256, 192], [113, 79], [640, 480]]) {
  for (const scissor of [false, true]) for (const partial of [false, true]) {
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const framebuffer = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.disable(gl.SCISSOR_TEST); gl.colorMask(true, true, true, true);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.enable(gl.SCISSOR_TEST);
    for (let y = 0; y < 480; y += 16) for (let x = 0; x < 640; x += 16) {
      gl.scissor(x, y, 16, 16);
      gl.clearColor((x * 7 % 255) / 255, (y * 13 % 255) / 255, ((x + y) * 3 % 255) / 255, ((x + y) % 239 + 16) / 255);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    const x = Math.min(31, 640 - width), y = Math.min(27, 480 - height);
    const expected = new Uint8Array(width * height * 4);
    gl.readPixels(x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, expected);
    if (scissor) gl.scissor(1, 1, 2, 2); else gl.disable(gl.SCISSOR_TEST);
    // Neither state may constrain a copy. Both must survive the private blit.
    gl.colorMask(false, true, false, true);
    gl.finish();
    const bindings = [gl.DRAW_FRAMEBUFFER_BINDING, gl.READ_FRAMEBUFFER_BINDING, gl.TEXTURE_BINDING_2D];
    const before = bindings.map((binding) => native.query(Q.getParameter, binding));
    const offset = partial ? 3 : 0;
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, offset, offset, x + offset, y + offset, width - offset, height - offset);
    gl.finish();
    // The runtime's WebGL binding queries are stubs; query the native GL state.
    const after = bindings.map((binding) => native.query(Q.getParameter, binding));
    if (JSON.stringify(before) !== JSON.stringify(after) || gl.isEnabled(gl.SCISSOR_TEST) !== scissor ||
        JSON.stringify(Array.from(gl.getParameter(gl.COLOR_WRITEMASK) as number[]).map(Boolean)) !== '[false,true,false,true]') throw Error('copy changed GL state');
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    const actual = new Uint8Array(expected.length);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, actual);
    let differingBytes = 0;
    for (let row = offset; row < height; row++) for (let col = offset; col < width; col++) {
      const i = (row * width + col) * 4;
      for (let c = 0; c < 4; c++) if (actual[i + c] !== expected[i + c]) differingBytes++;
    }
    results.push({ width, height, scissor, partial, differingBytes, error: gl.getError() });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(framebuffer); gl.deleteTexture(texture);
  }
}
const label = (JSON.parse(native.config) as { label?: string }).label;
native.report(JSON.stringify({ type: 'copy-test', label, results, passed: results.every((r) => r.differingBytes === 0 && r.error === 0) }));
