// video.js: WebGL2 canvas setup for a hardware rendered libretro core.
// GPL-2.0-or-later.
//
// Flycast renders with GL (RETRO_HW_CONTEXT_OPENGLES3). The core draws
// into the default framebuffer of this context; the host only sizes the
// canvas and keeps the picture letterboxed.

export const CONTEXT_ATTRIBUTES = Object.freeze({
  alpha: false,
  antialias: false,
  depth: true,
  stencil: true,
  premultipliedAlpha: false,
  preserveDrawingBuffer: false,
  powerPreference: 'high-performance',
  desynchronized: false,
});

export function createGlContext(canvas, attributes = CONTEXT_ATTRIBUTES) {
  const gl = canvas.getContext('webgl2', attributes);
  if (!gl) throw new Error('WebGL2 is not available');
  return gl;
}

// Largest rectangle with the given aspect ratio that fits in dstW x dstH,
// centred, in whole pixels. NAOMI output is 4:3 (or 3:4 when rotated).
export function fitRect(aspect, dstW, dstH) {
  if (!(aspect > 0) || !(dstW > 0) || !(dstH > 0)) return { x: 0, y: 0, w: 0, h: 0 };
  let w = dstW;
  let h = Math.round(w / aspect);
  if (h > dstH) {
    h = dstH;
    w = Math.round(h * aspect);
  }
  return { x: Math.floor((dstW - w) / 2), y: Math.floor((dstH - h) / 2), w, h };
}

// Backing store size for a CSS box, capped so a 4K screen does not ask the
// core for a huge framebuffer.
export function backingSize(cssW, cssH, dpr, maxW = 2560, maxH = 1920) {
  const scale = Math.min(dpr || 1, maxW / Math.max(cssW, 1), maxH / Math.max(cssH, 1));
  return {
    w: Math.max(1, Math.floor(cssW * Math.max(scale, 0))),
    h: Math.max(1, Math.floor(cssH * Math.max(scale, 0))),
  };
}
