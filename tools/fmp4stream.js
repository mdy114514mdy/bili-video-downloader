/**
 * 流式 fMP4 重封装（低内存）：不整段读入，按片段逐个读→改→写。
 * 核心接受一个 read(start, len) → Uint8Array 的回调，所以 Node 和浏览器能共用同一份逻辑。
 *
 * node fmp4stream.js v.m4s a.m4s out.mp4
 */
const fs = require('fs');

/* ---------------- 纯逻辑（可直接嵌进用户脚本） ---------------- */

const B = {
  u32: (b, p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0,
  u64: (b, p) => B.u32(b, p) * 4294967296 + B.u32(b, p + 4),
  w32: (b, p, v) => { b[p] = (v >>> 24) & 255; b[p + 1] = (v >>> 16) & 255; b[p + 2] = (v >>> 8) & 255; b[p + 3] = v & 255; },
  fourcc: (b, p) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]),
};

function boxList(b, start, end) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = B.u32(b, p);
    const type = B.fourcc(b, p + 4);
    let hdr = 8;
    if (size === 1) {
      if (p + 16 > end) break;
      size = B.u64(b, p + 8); hdr = 16;
    } else if (size === 0) { size = end - p; }
    if (size < hdr || p + size > end) break;
    out.push({ type, start: p, size, hdr, body: p + hdr, end: p + size });
    p += size;
  }
  return out;
}
const find = (a, t) => a.find(x => x.type === t);
const wrap = (type, body) => {
  const out = new Uint8Array(body.length + 8);
  B.w32(out, 0, body.length + 8);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  return out;
};
const cat = parts => {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

const tkhdIdOff = (b, tkhd) => tkhd.body + 4 + (b[tkhd.body] === 1 ? 16 : 8);

function trackId(b, moov) {
  const trak = find(boxList(b, moov.body, moov.end), 'trak');
  const tkhd = find(boxList(b, trak.body, trak.end), 'tkhd');
  return B.u32(b, tkhdIdOff(b, tkhd));
}
function timescale(b, moov) {
  const trak = find(boxList(b, moov.body, moov.end), 'trak');
  const mdia = find(boxList(b, trak.body, trak.end), 'mdia');
  const mdhd = find(boxList(b, mdia.body, mdia.end), 'mdhd');
  return b[mdhd.body] === 1 ? B.u32(b, mdhd.body + 20) : B.u32(b, mdhd.body + 12);
}
function trexBytes(b, moov, newId) {
  const mvex = find(boxList(b, moov.body, moov.end), 'mvex');
  if (!mvex) return null;
  const trex = find(boxList(b, mvex.body, mvex.end), 'trex');
  if (!trex) return null;
  const c = b.slice(trex.start, trex.end);
  if (newId) B.w32(c, 12, newId);
  return c;
}

/** 从 moof 里读 tfhd.track_ID 的绝对偏移、tfdt 解码时间 */
function moofMeta(m) {
  for (const traf of boxList(m, 8, m.length).filter(x => x.type === 'traf')) {
    const inner = boxList(m, traf.body, traf.end);
    const tfhd = find(inner, 'tfhd');
    const tfdt = find(inner, 'tfdt');
    let dt = 0;
    if (tfdt) dt = m[tfdt.body] === 1 ? B.u64(m, tfdt.body + 4) : B.u32(m, tfdt.body + 4);
    return { tidOff: tfhd ? tfhd.body + 4 : null, dt };
  }
  return { tidOff: null, dt: 0 };
}

/**
 * 流式合并
 * @param {{size:number, read:(s,e)=>Promise<Uint8Array>}} v
 * @param {{size:number, read:(s,e)=>Promise<Uint8Array>}} a
 * @param {(u8:Uint8Array)=>Promise<void>} write
 * @returns {Promise<{bytes:number, peakChunk:number, segs:number}>}
 */
async function muxStream(v, a, write, onStep) {
  const HEAD = 1 << 20;
  const hv = await v.read(0, Math.min(HEAD, v.size));
  const ha = await a.read(0, Math.min(HEAD, a.size));

  const topV = boxList(hv, 0, hv.length);
  const topA = boxList(ha, 0, ha.length);
  const ftypBox = find(topV, 'ftyp'), moovV = find(topV, 'moov');
  const moovA = find(topA, 'moov');
  if (!ftypBox || !moovV || !moovA) throw new Error('不是 fMP4（前 1MB 里找不到 ftyp/moov）');
  const ftypV = hv.slice(ftypBox.start, ftypBox.end);

  const mvb = hv, mab = ha;
  const idV = trackId(mvb, moovV);
  const idA = idV === 2 ? 3 : 2;

  // mvhd：只改 next_track_ID
  const mvhd = find(boxList(mvb, moovV.body, moovV.end), 'mvhd');
  const mvhdB = mvb.slice(mvhd.start, mvhd.end);
  B.w32(mvhdB, mvhdB[8] === 1 ? 116 : 104, Math.max(idV, idA) + 1);

  // 视频 trak 原样；音频 trak 改 tkhd.track_ID
  const trakV = (() => {
    const t = find(boxList(mvb, moovV.body, moovV.end), 'trak');
    return mvb.slice(t.start, t.end);
  })();
  const trakA = (() => {
    const t = find(boxList(mab, moovA.body, moovA.end), 'trak');
    const c = mab.slice(t.start, t.end);
    const tkhd = find(boxList(c, 8, c.length), 'tkhd');
    B.w32(c, tkhdIdOff(c, tkhd), idA);
    return c;
  })();
  const trexV = trexBytes(mvb, moovV);
  const trexA = trexBytes(mab, moovA, idA);
  if (!trexV || !trexA) throw new Error('缺少 mvex/trex');

  const newMoov = wrap('moov', cat([mvhdB, trakV, trakA, wrap('mvex', cat([trexV, trexA]))]));
  const tsV = timescale(mvb, moovV);
  const tsA = timescale(mab, moovA);

  // 扫描片段（只读 box 头）
  async function scan(src, start, ts, tag) {
    const list = [];
    let pos = start;
    while (pos + 8 <= src.size) {
      const h = await src.read(pos, 16);
      if (h.length < 8) break;
      let size = B.u32(h, 0);
      const type = B.fourcc(h, 4);
      if (size === 1) { size = B.u64(h, 8); }
      else if (size === 0) { size = src.size - pos; }
      if (size < 8 || pos + size > src.size) break;
      if (type === 'moof') {
        const m = await src.read(pos, size);
        const meta = moofMeta(m);
        let total = size;
        if (pos + size + 8 <= src.size) {
          const n = await src.read(pos + size, 16);
          if (n.length >= 8 && B.fourcc(n, 4) === 'mdat') total = size + B.u32(n, 0);
        }
        list.push({ pos, size: total, t: meta.dt / ts, tidOff: meta.tidOff, tag });
        pos += total;
        continue;
      }
      pos += size;
    }
    return list;
  }

  const segsV = await scan(v, moovV.end, tsV, 'v');
  const segsA = await scan(a, moovA.end, tsA, 'a');
  const all = segsV.concat(segsA).sort((x, y) => x.t - y.t);

  await write(ftypV);
  await write(newMoov);

  let bytes = ftypV.length + newMoov.length;
  let peak = 0;
  for (const s of all) {
    const src = s.tag === 'a' ? a : v;
    const chunk = await src.read(s.pos, s.size);
    if (s.tag === 'a' && s.tidOff !== null) B.w32(chunk, s.tidOff, idA);
    await write(chunk);
    bytes += chunk.length;
    if (chunk.length > peak) peak = chunk.length;
    onStep && onStep(bytes, s);
  }
  return { bytes, peakChunk: peak, segs: all.length };
}

/* ---------------- Node 测试入口 ---------------- */
if (require.main === module) {
  const [vf, af, out] = process.argv.slice(2);
  if (!vf) { console.error('node fmp4stream.js v.m4s a.m4s out.mp4'); process.exit(1); }

  const mk = path => {
    const fd = fs.openSync(path, 'r');
    const size = fs.fstatSync(fd).size;
    return {
      size,
      async read(start, len) {
        len = Math.max(0, Math.min(len, size - start));
        const buf = Buffer.allocUnsafe(len);
        fs.readSync(fd, buf, 0, len, start);
        return new Uint8Array(buf.buffer, buf.byteOffset, len);
      },
      close: () => fs.closeSync(fd),
    };
  };

  (async () => {
    const V = mk(vf), A = mk(af);
    const fo = fs.openSync(out, 'w');
    const t0 = Date.now();
    let peakRss = 0;
    const tick = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 20);
    const r = await muxStream(V, A, async u8 => {
      fs.writeSync(fo, u8);
    }, (bytes, s) => {
      if (s) process.stdout.write(`\r  ${(bytes / 1048576).toFixed(1)} MB  片 ${s.tag}@${s.t.toFixed(1)}s      `);
    });
    clearInterval(tick);
    fs.closeSync(fo); V.close(); A.close();
    console.log(`\n输出 ${out}: ${fs.statSync(out).size} bytes  用时 ${((Date.now() - t0) / 1000).toFixed(2)}s`);
    console.log(`交错片段 ${r.segs} 个，单片段峰值 ${(r.peakChunk / 1048576).toFixed(2)} MB，进程 RSS 峰值 ${(peakRss / 1048576).toFixed(0)} MB`);
  })().catch(e => { console.error('ERR', e); process.exit(1); });
}

module.exports = { muxStream };
