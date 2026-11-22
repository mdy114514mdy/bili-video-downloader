/**
 * 纯 JS 把 DASH 的两条 fMP4（视频 m4s + 音频 m4s）拼成一个可直接播放的 fMP4。
 *
 * 原理：fMP4 是 ftyp + moov + (moof + mdat)*。两条轨各自的 track_id 都是 1。
 *  ①把音频那条的 track_id 全部改成 2（tkhd / trex / tfhd 各 4 字节）
 *  ②合并 moov：mvhd(改 next_track_ID=3) + trak_v + trak_a + mvex(trex_v + trex_a)
 *  ③把所有 (moof+mdat) 按 tfdt 解码时间交错输出
 * 不重新编码，也不需要 ffmpeg/wasm。
 */
const fs = require('fs');

const TYPE = (buf, p) => buf.toString('latin1', p + 4, p + 8);

function boxes(buf, start, end) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = TYPE(buf, p);
    let hdr = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(p + 8)); hdr = 16; }
    else if (size === 0) { size = end - p; }
    if (size < hdr || p + size > end) break;
    out.push({ type, start: p, size, hdr, body: p + hdr, end: p + size });
    p += size;
  }
  return out;
}
const find = (arr, t) => arr.find(b => b.type === t);

/** 从 m4s 里分离 init 与片段序列 */
function split(buf) {
  const top = boxes(buf, 0, buf.length);
  const ftyp = find(top, 'ftyp');
  const moov = find(top, 'moov');
  // moof 与紧随其后的 mdat 视为一个片段
  const segs = [];
  for (let i = 0; i < top.length; i++) {
    if (top[i].type !== 'moof') continue;
    const moof = top[i];
    const mdat = top[i + 1] && top[i + 1].type === 'mdat' ? top[i + 1] : null;
    const end = mdat ? mdat.end : moof.end;
    segs.push({ moof, mdat, start: moof.start, end });
    if (mdat) i++;
  }
  return { ftyp, moov, segs };
}

/** 在 moov 里定位 trak / mvex / mvhd */
function moovParts(buf, moov) {
  const kids = boxes(buf, moov.body, moov.end);
  return {
    mvhd: find(kids, 'mvhd'),
    traks: kids.filter(b => b.type === 'trak'),
    mvex: find(kids, 'mvex'),
  };
}

/** tkhd 里的 track_ID 偏移 */
function tkhdTrackIdOffset(buf, tkhd) {
  const ver = buf[tkhd.body];
  return tkhd.body + 4 + (ver === 1 ? 16 : 8);
}
/** trex 里的 track_ID 偏移 */
const trexTrackIdOffset = trex => trex.body + 4;
/** tfhd 里的 track_ID 偏移 */
const tfhdTrackIdOffset = tfhd => tfhd.body + 4;

/** 从 moov 里取出 trak（完整 box），可选改 track_id */
function extractTrak(buf, moov, newId) {
  const kids = boxes(buf, moov.body, moov.end);
  const trak = kids.find(b => b.type === 'trak');
  if (!trak) throw new Error('no trak in moov');
  const copy = Buffer.from(buf.slice(trak.start, trak.end));
  const inner = boxes(copy, copy.length >= 8 ? 8 : 0, copy.length);
  const tkhd = inner.find(b => b.type === 'tkhd');
  if (tkhd && newId) copy.writeUInt32BE(newId, tkhdTrackIdOffset(copy, tkhd));
  return copy;
}

/** 取 mvex 里第一个 trex（完整 box），可选改 track_id */
function extractTrex(buf, moov, newId) {
  const kids = boxes(buf, moov.body, moov.end);
  const mvex = kids.find(b => b.type === 'mvex');
  if (!mvex) return null;
  const inner = boxes(buf, mvex.body, mvex.end);
  const trex = inner.find(b => b.type === 'trex');
  if (!trex) return null;
  const copy = Buffer.from(buf.slice(trex.start, trex.end));
  if (newId) copy.writeUInt32BE(newId, trexTrackIdOffset({ body: 8 }));
  return copy;
}

function wrap(type, body) {
  const hdr = Buffer.alloc(8);
  hdr.writeUInt32BE(body.length + 8, 0);
  hdr.write(type, 4, 'latin1');
  return Buffer.concat([hdr, body]);
}

/** 把某条轨的 moof 里 tfhd.track_ID 改成 newId，返回整段（moof+mdat）新 Buffer */
function patchSegment(buf, seg, newId) {
  const copy = Buffer.from(buf.slice(seg.start, seg.end));
  const kids = boxes(copy, seg.moof.hdr, seg.moof.size);
  for (const traf of kids.filter(b => b.type === 'traf')) {
    const inner = boxes(copy, traf.body, traf.end);
    const tfhd = inner.find(b => b.type === 'tfhd');
    if (tfhd) copy.writeUInt32BE(newId, tfhdTrackIdOffset(tfhd));
  }
  return copy;
}

/** 读片段的解码起始时间（tfdt.baseMediaDecodeTime） */
function segmentDecodeTime(buf, seg) {
  const kids = boxes(buf, seg.moof.body, seg.moof.end);
  for (const traf of kids.filter(b => b.type === 'traf')) {
    const inner = boxes(buf, traf.body, traf.end);
    const tfdt = inner.find(b => b.type === 'tfdt');
    if (!tfdt) continue;
    const ver = buf[tfdt.body];
    return ver === 1 ? Number(buf.readBigUInt64BE(tfdt.body + 4)) : buf.readUInt32BE(tfdt.body + 4);
  }
  return 0;
}

/** 该 trak 的媒体时间刻度 */
function mediaTimescale(buf, trak) {
  const kids = boxes(buf, trak.body, trak.end);
  const mdia = kids.find(b => b.type === 'mdia');
  const mk = boxes(buf, mdia.body, mdia.end);
  const mdhd = mk.find(b => b.type === 'mdhd');
  const ver = buf[mdhd.body];
  return ver === 1 ? buf.readUInt32BE(mdhd.body + 20) : buf.readUInt32BE(mdhd.body + 12);
}

/** 合并两个 moov：mvhd(视频的, next_track_ID=3) + trak_v + trak_a + mvex(trex_v + trex_a) */
function buildMoov(bufV, moovV, bufA, moovA) {
  const parts = moovParts(bufV, moovV);
  const mvhd = Buffer.from(bufV.slice(parts.mvhd.start, parts.mvhd.end));
  const ver = mvhd[8];
  mvhd.writeUInt32BE(3, ver === 1 ? 116 : 104);

  const trakV = extractTrak(bufV, moovV);
  const trakA = extractTrak(bufA, moovA, 2);
  const trexV = extractTrex(bufV, moovV);
  const trexA = extractTrex(bufA, moovA, 2);
  if (!trexV || !trexA) throw new Error('mvex/trex missing');

  const mvex = wrap('mvex', Buffer.concat([trexV, trexA]));
  return wrap('moov', Buffer.concat([mvhd, trakV, trakA, mvex]));
}

// ---------------- 主流程 ----------------
const VFILE = process.argv[2] || 'sample_v.m4s';
const AFILE = process.argv[3] || 'sample_a.m4s';
const OUTFILE = process.argv[4] || 'mux_out.mp4';

const bufV = fs.readFileSync(VFILE);
const bufA = fs.readFileSync(AFILE);
const V = split(bufV), A = split(bufA);
const trakV0 = moovParts(bufV, V.moov).traks[0];
const kidsV0 = boxes(bufV, trakV0.body, trakV0.end);
const tkhdV0 = kidsV0.find(b => b.type === 'tkhd');
const trakA0 = moovParts(bufA, A.moov).traks[0];
const kidsA0 = boxes(bufA, trakA0.body, trakA0.end);
const tkhdA0 = kidsA0.find(b => b.type === 'tkhd');
console.log(`视频: ftyp=${V.ftyp.size} moov=${V.moov.size} 片段=${V.segs.length} track_id=${bufV.readUInt32BE(tkhdTrackIdOffset(bufV, tkhdV0))} timescale=${mediaTimescale(bufV, trakV0)}`);
console.log(`音频: ftyp=${A.ftyp.size} moov=${A.moov.size} 片段=${A.segs.length} track_id=${bufA.readUInt32BE(tkhdTrackIdOffset(bufA, tkhdA0))} timescale=${mediaTimescale(bufA, trakA0)}`);

const moov = buildMoov(bufV, V.moov, bufA, A.moov);
const ftyp = Buffer.from(bufV.slice(V.ftyp.start, V.ftyp.end));
const tsV = mediaTimescale(bufV, trakV0);
const tsA = mediaTimescale(bufA, trakA0);
console.log(`合并后 moov=${moov.length} bytes，timescale video=${tsV} audio=${tsA}`);

const stream = [];   // {t: 秒, buf}
for (const s of V.segs) stream.push({ t: segmentDecodeTime(bufV, s) / tsV, buf: Buffer.from(bufV.slice(s.start, s.end)) });
for (const s of A.segs) stream.push({ t: segmentDecodeTime(bufA, s) / tsA, buf: patchSegment(bufA, s, 2) });
stream.sort((a, b) => a.t - b.t);

const out = Buffer.concat([ftyp, moov, ...stream.map(x => x.buf)]);
fs.writeFileSync(OUTFILE, out);
console.log(`输出 ${OUTFILE}: ${out.length} bytes（视频 ${bufV.length} + 音频 ${bufA.length} + moov ${moov.length} - init ${V.ftyp.size + V.moov.size + A.ftyp.size + A.moov.size}）`);
console.log(`交错片段数 ${stream.length}，首段时间 ${stream[0].t.toFixed(3)}s，末段 ${stream[stream.length - 1].t.toFixed(3)}s`);
