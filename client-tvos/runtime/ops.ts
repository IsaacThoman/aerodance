// The command stream's opcodes, shared by the JavaScript encoder (webgl.ts, canvas2d.ts) and the
// native decoder (src/GLExec.mm, src/Canvas2D.mm). scripts/tvos.ts writes them to
// src/generated/ops.h as OP_<NAME>. A command is one header word, op | (words << 16) where words
// counts the header, then its arguments as 32-bit ints or floats; see each op's handler for its
// layout. Append new ops at the end of a section so recorded streams stay readable.
export const GL_OPS = [
  'NOP',
  // Host
  'PRESENT', 'RESIZE_DEFAULT_FB', 'RELEASE_IMAGE',
  // State
  'ACTIVE_TEXTURE', 'BLEND_COLOR', 'BLEND_EQUATION', 'BLEND_EQUATION_SEPARATE', 'BLEND_FUNC', 'BLEND_FUNC_SEPARATE',
  'CLEAR', 'CLEAR_COLOR', 'CLEAR_DEPTH', 'CLEAR_STENCIL', 'COLOR_MASK', 'CULL_FACE', 'DEPTH_FUNC', 'DEPTH_MASK',
  'DEPTH_RANGE', 'DISABLE', 'ENABLE', 'FRONT_FACE', 'HINT', 'LINE_WIDTH', 'PIXEL_STOREI', 'POLYGON_OFFSET',
  'SAMPLE_COVERAGE', 'SCISSOR', 'STENCIL_FUNC_SEPARATE', 'STENCIL_MASK_SEPARATE', 'STENCIL_OP_SEPARATE', 'VIEWPORT',
  'FLUSH',
  // Objects
  'CREATE', 'DELETE',
  'BIND_BUFFER', 'BIND_BUFFER_BASE', 'BIND_BUFFER_RANGE', 'BIND_FRAMEBUFFER', 'BIND_RENDERBUFFER', 'BIND_SAMPLER',
  'BIND_TEXTURE', 'BIND_VERTEX_ARRAY',
  // Buffers
  'BUFFER_DATA', 'BUFFER_SUB_DATA', 'COPY_BUFFER_SUB_DATA',
  // Shaders and programs
  'SHADER_SOURCE', 'COMPILE_SHADER', 'ATTACH_SHADER', 'DETACH_SHADER', 'LINK_PROGRAM', 'USE_PROGRAM',
  'BIND_ATTRIB_LOCATION', 'UNIFORM_BLOCK_BINDING',
  // Uniforms
  'UNIFORM_1F', 'UNIFORM_2F', 'UNIFORM_3F', 'UNIFORM_4F', 'UNIFORM_1I', 'UNIFORM_2I', 'UNIFORM_3I', 'UNIFORM_4I',
  'UNIFORM_1UI', 'UNIFORM_2UI', 'UNIFORM_3UI', 'UNIFORM_4UI', 'UNIFORM_FV', 'UNIFORM_IV', 'UNIFORM_UIV',
  'UNIFORM_MATRIX_FV', 'UNIFORM_MATRIX4', 'UNIFORM_MATRIX3',
  // Vertex attributes and drawing
  'ENABLE_VERTEX_ATTRIB_ARRAY', 'DISABLE_VERTEX_ATTRIB_ARRAY', 'VERTEX_ATTRIB_POINTER', 'VERTEX_ATTRIB_IPOINTER',
  'VERTEX_ATTRIB_DIVISOR', 'VERTEX_ATTRIB_4F', 'VERTEX_ATTRIB_I4',
  'DRAW_ARRAYS', 'DRAW_ELEMENTS', 'DRAW_ARRAYS_INSTANCED', 'DRAW_ELEMENTS_INSTANCED', 'DRAW_RANGE_ELEMENTS',
  'DRAW_BUFFERS',
  // Textures and samplers
  'TEX_PARAMETERI', 'TEX_PARAMETERF', 'SAMPLER_PARAMETERI', 'SAMPLER_PARAMETERF', 'GENERATE_MIPMAP',
  'TEX_STORAGE_2D', 'TEX_STORAGE_3D', 'TEX_IMAGE', 'COPY_TEX_IMAGE_2D', 'COPY_TEX_SUB_IMAGE',
  // Framebuffers
  'FRAMEBUFFER_RENDERBUFFER', 'FRAMEBUFFER_TEXTURE_2D', 'FRAMEBUFFER_TEXTURE_LAYER', 'RENDERBUFFER_STORAGE',
  'BLIT_FRAMEBUFFER', 'INVALIDATE_FRAMEBUFFER', 'READ_BUFFER', 'CLEAR_BUFFERFV', 'CLEAR_BUFFERIV',
  'CLEAR_BUFFERUIV', 'CLEAR_BUFFERFI',
  // Queries
  'BEGIN_QUERY', 'END_QUERY',
  // readPixels into a PIXEL_PACK_BUFFER
  'READ_PIXELS',
] as const;

// Canvas 2D commands draw on the canvas chosen by the last C_SELECT.
export const CANVAS_OPS = [
  'C_SELECT', 'C_CREATE', 'C_DESTROY', 'C_RESIZE', 'C_SAVE', 'C_RESTORE', 'C_SET_TRANSFORM', 'C_TRANSFORM',
  'C_FILL_COLOR', 'C_FILL_PAINT', 'C_STROKE_COLOR', 'C_STROKE_PAINT', 'C_LINE_WIDTH', 'C_LINE_CAP', 'C_LINE_JOIN',
  'C_MITER_LIMIT', 'C_LINE_DASH', 'C_LINE_DASH_OFFSET', 'C_GLOBAL_ALPHA', 'C_COMPOSITE', 'C_SHADOW_BLUR',
  'C_SHADOW_COLOR', 'C_SHADOW_OFFSET', 'C_FONT', 'C_TEXT_ALIGN', 'C_TEXT_BASELINE', 'C_LETTER_SPACING',
  'C_SMOOTHING', 'C_BEGIN_PATH', 'C_MOVE_TO', 'C_LINE_TO', 'C_BEZIER_TO', 'C_QUAD_TO', 'C_ARC', 'C_ARC_TO',
  'C_ELLIPSE', 'C_RECT', 'C_ROUND_RECT', 'C_CLOSE_PATH', 'C_FILL', 'C_STROKE', 'C_CLIP', 'C_FILL_RECT',
  'C_STROKE_RECT', 'C_CLEAR_RECT', 'C_FILL_TEXT', 'C_STROKE_TEXT', 'C_DRAW_IMAGE', 'C_PUT_IMAGE_DATA',
  'C_PATH_SELECT', 'C_PATH_ADD', 'C_FILTER',
] as const;

const index = <T extends readonly string[]>(names: T, base: number) =>
  Object.fromEntries(names.map((name, i) => [name, base + i])) as { [K in T[number]]: number };

/** Opcode numbers by name. Canvas ops start at 200. */
export const OP = { ...index(GL_OPS, 0), ...index(CANVAS_OPS, 200) };

/** Object kinds for CREATE / DELETE. */
export const KIND = { buffer: 1, texture: 2, program: 3, shader: 4, vertexArray: 5, framebuffer: 6, renderbuffer: 7, sampler: 8, query: 9 } as const;

/** Where a pixel or data payload is: in the command (inline, padded to words), a native block, or nowhere. */
export const PAYLOAD = { none: 0, inline: 1, block: 2, canvas: 3, image: 4, pbo: 5 } as const;

/** TEX_IMAGE variants. */
export const TEX = { image2D: 0, subImage2D: 1, image3D: 2, subImage3D: 3, compressed2D: 4, compressedSub2D: 5, compressed3D: 6, compressedSub3D: 7 } as const;

/** Canvas paints and image sources. */
export const PAINT = { linear: 1, radial: 2, conic: 3, pattern: 4 } as const;
