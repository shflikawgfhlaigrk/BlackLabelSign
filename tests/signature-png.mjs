import assert from 'node:assert/strict';
import {test} from 'node:test';
import {normalizeSignaturePng, InvalidSignatureImage} from '../src/signature-png.mjs';
import {makePng,chunk,rgbaPixels} from './png-fixtures.mjs';
import {deflateSync} from 'node:zlib';

for(const [label,options,rgba] of [
  ['RGBA',{pixels:[23,45,67,89]},[23,45,67,89]],
  ['RGB',{color:2,pixels:[23,45,67]},[23,45,67,255]],
  ['gray',{color:0,pixels:[23]},[23,23,23,255]],
  ['gray alpha',{color:4,pixels:[23,45]},[23,23,23,45]],
  ['indexed alpha',{color:3,pixels:[1],before:[chunk('PLTE',[5,6,7,23,45,67]),chunk('tRNS',[255,89])]},[23,45,67,89]],
  ['transparent RGB',{color:2,pixels:[23,45,67],before:[chunk('tRNS',[0,23,0,45,0,67])]},[23,45,67,0]],
  ['transparent gray',{color:0,pixels:[23],before:[chunk('tRNS',[0,23])]},[23,23,23,0]],
])test(`F063 PNG: ${label} retains exact pixels`,async()=>{
  const output=Buffer.from(await normalizeSignaturePng(makePng(options)));
  assert.deepEqual([...rgbaPixels(output)],[0,...rgba]);
  assert.deepEqual(Buffer.from(await normalizeSignaturePng(output)),output);
});
for(const filter of [0,1,2,3,4])test(`F063 PNG: filter ${filter} preserves both rows`,async()=>{
  const pixels=[[20,40,60,80,100,120,140,160],[30,50,70,90,110,130,150,170]],raw=[];
  const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
  for(let y=0;y<2;y++){raw.push(filter);for(let x=0;x<8;x++){const a=x>=4?pixels[y][x-4]:0,b=y?pixels[y-1][x]:0,c=y&&x>=4?pixels[y-1][x-4]:0;
    const pred=filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):filter===4?paeth(a,b,c):0;raw.push((pixels[y][x]-pred)&255);}}
  const out=Buffer.from(await normalizeSignaturePng(makePng({width:2,height:2,raw:Buffer.from(raw)})));
  assert.deepEqual([...rgbaPixels(out)],[0,...pixels[0],0,...pixels[1]]);
});
for(const type of ['tEXt','iTXt','zTXt'])test(`F063 PNG: ${type} without terminators is stripped`,async()=>{
  const normalized=Buffer.from(await normalizeSignaturePng(makePng({extra:[chunk(type,Buffer.alloc(2048,65))]})));
  assert.equal(normalized.includes(Buffer.from(type)),false);assert.deepEqual([...rgbaPixels(normalized)],[0,40,50,60,255]);
});
const badCrc=makePng();badCrc[29]^=1;
for(const[label,input]of[
  ['truncated',makePng().subarray(0,-3)],['CRC mismatch',badCrc],
  ['chunk overrun',Buffer.concat([makePng().subarray(0,33),Buffer.from([255,255,255,255,116,69,88,116])])],
  ['oversized dimensions',makePng({width:4097})],['pixel ceiling',makePng({width:2048,height:2048})],
  ['zero dimensions',makePng({width:0})],['invalid filter',makePng({raw:Buffer.from([5,1,2,3,4])})],
  ['truncated pixels',makePng({raw:Buffer.from([0,1])})],['excess pixels',makePng({raw:Buffer.alloc(100)})],
  ['bounded expansion',makePng({compressed:deflateSync(Buffer.alloc(1024*1024))})],
  ['bad deflate',makePng({compressed:Buffer.from([1,2,3])})],['unknown critical',makePng({extra:[chunk('ABCD',[])]})],
  ['duplicate header',makePng({extra:[chunk('IHDR',Buffer.alloc(13))]})],
  ['palette index',makePng({color:3,pixels:[1],before:[chunk('PLTE',[1,2,3])]})],
  ['palette missing',makePng({color:3})],['trailing data',Buffer.concat([makePng(),Buffer.from('trailing')])],
  ['interlace',makePng({interlace:1})],['unsupported depth',makePng({depth:16})],
  ['chunk ceiling',makePng({extra:Array.from({length:257},()=>chunk('tEXt',[65]))})],
])test(`F063 PNG: rejects ${label}`,async()=>assert.rejects(()=>normalizeSignaturePng(input),InvalidSignatureImage));
