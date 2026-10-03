import { deflateSync, inflateSync } from 'node:zlib';
const magic = Buffer.from([137,80,78,71,13,10,26,10]);
export function chunk(type, data) {
  data = Buffer.from(data); const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length); out.write(type, 4); data.copy(out, 8);
  let crc = 0xffffffff;
  for (const b of out.subarray(4, -4)) { crc ^= b; for(let j=0;j<8;j++) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out;
}
export function makePng({width=1,height=1,color=6,pixels=[40,50,60,255],raw,compressed,extra=[],before=[],depth=8,interlace=0}={}) {
  const h = Buffer.alloc(13); h.writeUInt32BE(width); h.writeUInt32BE(height,4);h[8]=depth;h[9]=color;h[12]=interlace;
  return Buffer.concat([magic,chunk('IHDR',h),...before,chunk('IDAT',compressed || deflateSync(raw || Buffer.from([0,...pixels]))),...extra,chunk('IEND',[])]);
}
export function rgbaPixels(png) {
  let i=8;const parts=[];
  while(i<png.length){const n=png.readUInt32BE(i);if(png.toString('ascii',i+4,i+8)==='IDAT')parts.push(png.subarray(i+8,i+8+n));i+=12+n;}
  return inflateSync(Buffer.concat(parts));
}
