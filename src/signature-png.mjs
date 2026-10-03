// Decode only bounded, non-interlaced 8-bit signature PNGs. Re-encode pixels
// without metadata before any third-party PNG parser sees attacker input.
export const MAX_SIGNATURE_BYTES = 600 * 1024;
const MAGIC = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const MAX_PIXELS = 2 * 1024 * 1024;
export class InvalidSignatureImage extends Error {}
const invalid = () => { throw new InvalidSignatureImage('Signature image is invalid or exceeds supported PNG limits'); };
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n & 1) ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
const crc = bytes => {
  let n = 0xffffffff;
  for (const byte of bytes) n = crcTable[(n ^ byte) & 255] ^ (n >>> 8);
  return (n ^ 0xffffffff) >>> 0;
};
const concat = parts => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out;
};
const chunk = (type, data) => {
  const bytes = new Uint8Array(data.length + 12), view = new DataView(bytes.buffer);
  view.setUint32(0, data.length); bytes.set(new TextEncoder().encode(type), 4); bytes.set(data, 8);
  view.setUint32(data.length + 8, crc(bytes.subarray(4, data.length + 8))); return bytes;
};
async function transform(bytes, stream, limit) {
  const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
  const parts = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel(); invalid(); }
      parts.push(value);
    }
    return concat(parts);
  } catch { invalid(); }
  finally { reader.releaseLock(); }
}
const paeth = (a, b, c) => {
  const p = a + b - c, x = Math.abs(p - a), y = Math.abs(p - b), z = Math.abs(p - c);
  return x <= y && x <= z ? a : y <= z ? b : c;
};
export async function normalizeSignaturePng(input, { requireInk = false } = {}) {
  const b = new Uint8Array(input);
  if (b.length > MAX_SIGNATURE_BYTES || b.length < 45 || !MAGIC.every((x, i) => b[i] === x)) invalid();
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let offset = 8, count = 0, width, height, color, channels, palette, alpha;
  let ended = false, idatClosed = false; const data = [];
  while (offset < b.length) {
    if (++count > 256 || b.length - offset < 12) invalid();
    const length = v.getUint32(offset), end = offset + length + 12;
    if (end > b.length) invalid();
    const type = String.fromCharCode(...b.subarray(offset + 4, offset + 8));
    if (!/^[A-Za-z]{4}$/.test(type) || type[2] !== type[2].toUpperCase() ||
        crc(b.subarray(offset + 4, end - 4)) !== v.getUint32(end - 4)) invalid();
    const payload = b.subarray(offset + 8, end - 4);
    if (count === 1 && type !== 'IHDR') invalid();
    if (type === 'IHDR') {
      if (count !== 1 || length !== 13) invalid();
      width = v.getUint32(offset + 8); height = v.getUint32(offset + 12); color = payload[9];
      channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[color];
      if (!width || !height || width > 4096 || height > 4096 || width * height > MAX_PIXELS ||
          !channels || payload[8] !== 8 || payload[10] || payload[11] || payload[12]) invalid();
    } else if (type === 'PLTE') {
      if (palette || data.length || !length || length > 768 || length % 3 || color === 0 || color === 4) invalid();
      palette = payload;
    } else if (type === 'tRNS') {
      if (alpha || data.length || (color === 3 ? !palette || !length || length > palette.length / 3 :
          color === 0 ? length !== 2 : color === 2 ? length !== 6 : true)) invalid();
      alpha = payload;
    } else if (type === 'IDAT') {
      if (idatClosed || (color === 3 && !palette)) invalid(); data.push(payload);
    } else if (type === 'IEND') {
      if (length || !data.length || end !== b.length) invalid(); ended = true;
    } else if (type[0] === type[0].toUpperCase()) invalid();
    // Ancillary metadata is discarded; never parse tEXt/iTXt terminators.
    if (data.length && type !== 'IDAT') idatClosed = true;
    offset = end;
  }
  if (!ended) invalid();
  const stride = width * channels, rawSize = (stride + 1) * height;
  const raw = await transform(concat(data), new DecompressionStream('deflate'), rawSize);
  if (raw.length !== rawSize) invalid();
  // Unfilter in place. Every access is bounded by validated image dimensions.
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1), filter = raw[base]; if (filter > 4) invalid();
    for (let x = 0; x < stride; x++) {
      const i = base + 1 + x, a = x >= channels ? raw[i - channels] : 0;
      const up = y ? raw[i - stride - 1] : 0, c = y && x >= channels ? raw[i - stride - 1 - channels] : 0;
      raw[i] = (raw[i] + (filter === 1 ? a : filter === 2 ? up : filter === 3 ? (a + up) >>> 1 : filter === 4 ? paeth(a, up, c) : 0)) & 255;
    }
  }
  const rgba = new Uint8Array((width * 4 + 1) * height);
  let visibleInk = false;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const s = y * (stride + 1) + 1 + x * channels, d = y * (width * 4 + 1) + 1 + x * 4;
    const r = raw[s], g = raw[s + 1], blue = raw[s + 2];
    if (color === 3) {
      if (r * 3 >= palette.length) invalid();
      rgba.set(palette.subarray(r * 3, r * 3 + 3), d); rgba[d + 3] = alpha?.[r] ?? 255;
    } else if (color === 0 || color === 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = r;
      rgba[d + 3] = color === 4 ? g : alpha && alpha[0] === 0 && alpha[1] === r ? 0 : 255;
    } else {
      rgba[d] = r; rgba[d + 1] = g; rgba[d + 2] = blue;
      rgba[d + 3] = color === 6 ? raw[s + 3] : alpha && !alpha[0] && alpha[1] === r && !alpha[2] && alpha[3] === g && !alpha[4] && alpha[5] === blue ? 0 : 255;
    }
    // Signatures must leave visible ink when composited on white PDF paper.
    if (rgba[d+3] * (255-Math.min(rgba[d],rgba[d+1],rgba[d+2])) > 8*255) visibleInk = true;
  }
  if (requireInk && !visibleInk) throw new InvalidSignatureImage('Draw a visible signature before continuing.');
  const header = new Uint8Array(13), h = new DataView(header.buffer);
  h.setUint32(0, width); h.setUint32(4, height); header[8] = 8; header[9] = 6;
  const compressed = await transform(rgba, new CompressionStream('deflate'), MAX_SIGNATURE_BYTES - 57);
  return concat([MAGIC, chunk('IHDR', header), chunk('IDAT', compressed), chunk('IEND', new Uint8Array())]);
}
