// ==UserScript==
// @name         B站视频下载器 Pro（多分辨率/帧率/码率）
// @namespace    local.bili.video.dl
// @version      1.1.0
// @description  在B站视频播放页「分享」按钮右侧加入「下载视频」按钮：自动探测当前视频全部可用的 DASH 视频流（分辨率 / 帧率 / 码率 / 编码）与音频流，弹窗选择后多线程分块下载。支持分P、音视频分离保存、复制 aria2 / ffmpeg 命令。
// @author       LittleCodeSauce
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/list/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /* ============================== 基础工具 ============================== */

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const $ = (sel, root = document) => root.querySelector(sel);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function fmtBytes(n) {
    if (!n && n !== 0) return '-';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(n < 10 ? 2 : 1) + ' ' + u[i];
  }
  function fmtTime(s) {
    s = Math.max(0, Math.round(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
  }
  function safeName(s) {
    return String(s || '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 110) || 'video';
  }

  /* ---------- MD5（wbi 签名需要） ---------- */
  function md5(str) {
    const K = [], S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
      5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
      6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;

    const bytes = Array.from(new TextEncoder().encode(str));
    const bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    const lo = bitLen >>> 0, hi = Math.floor(bitLen / 4294967296);
    bytes.push(lo & 0xff, (lo >>> 8) & 0xff, (lo >>> 16) & 0xff, (lo >>> 24) & 0xff,
      hi & 0xff, (hi >>> 8) & 0xff, (hi >>> 16) & 0xff, (hi >>> 24) & 0xff);

    let a0 = 0x67452301 | 0, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476 | 0;
    const M = new Array(16);
    for (let off = 0; off < bytes.length; off += 64) {
      for (let i = 0; i < 16; i++) {
        const j = off + i * 4;
        M[i] = (bytes[j] | (bytes[j + 1] << 8) | (bytes[j + 2] << 16) | (bytes[j + 3] << 24)) | 0;
      }
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        const t = D;
        D = C; C = B;
        const x = (A + F + K[i] + M[g]) | 0;
        const s = S[i];
        B = (B + ((x << s) | (x >>> (32 - s)))) | 0;
        A = t;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }
    const hex = n => [0, 8, 16, 24].map(s => ((n >>> s) & 0xff).toString(16).padStart(2, '0')).join('');
    return hex(a0) + hex(b0) + hex(c0) + hex(d0);
  }

  /* ---------- wbi 签名 ---------- */
  const MIXIN_KEY_ENC_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
    61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];

  function getMixinKey(orig) {
    return MIXIN_KEY_ENC_TAB.map(n => orig[n]).join('').slice(0, 32);
  }
  function wbiSign(params, imgKey, subKey) {
    const mixinKey = getMixinKey(imgKey + subKey);
    const p = Object.assign({}, params, { wts: Math.round(Date.now() / 1000) });
    const query = Object.keys(p).sort().map(k => {
      const v = String(p[k]).replace(/[!'()*]/g, '');
      return encodeURIComponent(k) + '=' + encodeURIComponent(v);
    }).join('&');
    p.w_rid = md5(query + mixinKey);
    return p;
  }
  const toQuery = o => Object.keys(o).map(k =>
    encodeURIComponent(k) + '=' + encodeURIComponent(String(o[k]).replace(/[!'()*]/g, ''))).join('&');

  /* ---------- 网络：GM_xmlhttpRequest 封装（自动带 cookie，绕过 CORS） ---------- */
  const BILI_HEADERS = {
    'Referer': 'https://www.bilibili.com/',
    'Origin': 'https://www.bilibili.com',
    'Accept': '*/*'
  };

  function gm(opts) {
    return new Promise((resolve, reject) => {
      let req;
      try {
        req = GM_xmlhttpRequest(Object.assign({
          timeout: 30000,
          onload: resolve,
          onerror: () => reject(new Error('NETWORK_ERROR')),
          ontimeout: () => reject(new Error('TIMEOUT')),
          onabort: () => reject(new Error('ABORTED'))
        }, opts));
      } catch (e) { reject(e); }
    });
  }

  async function apiGet(url, retry = 2) {
    let lastErr;
    for (let i = 0; i <= retry; i++) {
      try {
        const r = await gm({ method: 'GET', url, headers: BILI_HEADERS });
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        return JSON.parse(r.responseText);
      } catch (e) {
        lastErr = e;
        if (i < retry) await sleep(400 * (i + 1));
      }
    }
    throw lastErr;
  }

  /* ============================== 业务数据 ============================== */

  const QN_NAME = {
    127: '8K 超高清', 126: '杜比视界', 125: 'HDR 真彩', 120: '4K 超清',
    116: '1080P60', 112: '1080P+ 高码率', 80: '1080P 高清', 74: '720P60',
    64: '720P 准高清', 32: '480P 清晰', 16: '360P 流畅', 6: '240P 极速'
  };
  const QN_RANK = { 127: 100, 126: 99, 125: 98, 120: 90, 116: 85, 112: 80, 80: 70, 74: 65, 64: 60, 32: 40, 16: 30, 6: 20 };

  function codecFamily(codecs) {
    const c = String(codecs || '').toLowerCase();
    if (c.startsWith('avc') || c.startsWith('h264')) return 'AVC';
    if (c.startsWith('hev') || c.startsWith('hvc') || c.startsWith('h265')) return 'HEVC';
    if (c.startsWith('av01') || c.startsWith('av1')) return 'AV1';
    if (c.startsWith('mp4a') || c.startsWith('aac')) return 'AAC';
    if (c.startsWith('ec-3') || c.startsWith('ac-3')) return 'Dolby';
    if (c.startsWith('flac')) return 'FLAC';
    return c.split('.')[0].toUpperCase() || '?';
  }
  const CODEC_HINT = {
    AVC: '兼容性最好，任何播放器都能放',
    HEVC: '同画质体积更小，Win10+ 自带解码',
    AV1: '最省流量，需较新硬件/播放器',
    AAC: '标准音频',
    Dolby: '杜比音效',
    FLAC: '无损音频'
  };

  /** 从 URL 猜当前视频的 bvid / 分P */
  function currentBvid() {
    const m = location.pathname.match(/\/video\/(BV[0-9A-Za-z]{10})/);
    if (m) return m[1];
    const q = new URLSearchParams(location.search);
    if (q.get('bvid')) return q.get('bvid');
    // 老 av 号
    const a = location.pathname.match(/\/video\/av(\d+)/i);
    return a ? 'av' + a[1] : null;
  }
  function currentP() {
    const q = new URLSearchParams(location.search);
    const p = parseInt(q.get('p') || '1', 10);
    return isNaN(p) || p < 1 ? 1 : p;
  }

  const state = {
    bvid: null,
    view: null,
    nav: null,
    playurl: null,
    playurlAt: 0,
    playurlCid: 0,
    selectedVideo: null,
    selectedAudio: null,
    job: null
  };

  async function getNav() {
    try {
      const r = await apiGet('https://api.bilibili.com/x/web-interface/nav');
      if (r.code !== 0) return { login: false };
      return {
        login: !!r.data.isLogin,
        vip: r.data.vipStatus === 1,
        uname: r.data.uname,
        wbiImg: r.data.wbi_img ? r.data.wbi_img.img_url.split('/').pop().split('.')[0] : null,
        wbiSub: r.data.wbi_img ? r.data.wbi_img.sub_url.split('/').pop().split('.')[0] : null
      };
    } catch (e) { return { login: false, err: e.message }; }
  }

  async function getView(bvid) {
    const key = bvid.startsWith('av') ? 'aid=' + bvid.slice(2) : 'bvid=' + bvid;
    const r = await apiGet('https://api.bilibili.com/x/web-interface/view?' + key);
    if (r.code !== 0) throw new Error('view 失败：' + r.code + ' ' + (r.message || ''));
    return r.data;
  }

  async function getPlayurl(view, cid, nav) {
    const params = {
      avid: view.aid, bvid: view.bvid, cid: cid,
      qn: 127, fnver: 0, fnval: 4048, fourk: 1, platform: 'pc'
    };
    let url;
    if (nav && nav.wbiImg && nav.wbiSub) {
      url = 'https://api.bilibili.com/x/player/wbi/playurl?' + toQuery(wbiSign(params, nav.wbiImg, nav.wbiSub));
    } else {
      url = 'https://api.bilibili.com/x/player/playurl?' + toQuery(params);
    }
    const r = await apiGet(url);
    if (r.code !== 0) {
      const msg = {
        '-404': '视频不存在或已被删除',
        '-403': '没有访问权限（可能需要大会员 / 充电专属）',
        '-352': '触发风控，请先在网页上正常播放一次该视频再试',
        '87007': '该清晰度需要大会员',
        '87008': '该清晰度需要付费/充电'
      }[String(r.code)] || (r.message || '未知错误');
      throw new Error('playurl 失败：' + r.code + ' ' + msg);
    }
    return r.data;
  }

  /* ============================== fMP4 纯 JS 合并 ============================== */
  /**
   * B 站 DASH 的音视频是两个 fMP4（ftyp + moov + (moof+mdat)*），两条轨 track_id 天然不同（1 / 2）。
   * 这里只做「搬家 + 换 moov」：mvhd(视频的, next_track_ID=3) + trak_v + trak_a + mvex(trex_v+trex_a)，
   * 再把所有 (moof+mdat) 按 tfdt 解码时间交错输出。不重编码，几 MB 的视频毫秒级完成。
   */
  const FMP4 = (function () {
    const u32 = (b, p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
    const u64 = (b, p) => u32(b, p) * 4294967296 + u32(b, p + 4);
    const w32 = (b, p, v) => {
      b[p] = (v >>> 24) & 255; b[p + 1] = (v >>> 16) & 255;
      b[p + 2] = (v >>> 8) & 255; b[p + 3] = v & 255;
    };
    const fourcc = (b, p) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);

    function boxList(b, start, end) {
      const out = [];
      let p = start;
      while (p + 8 <= end) {
        let size = u32(b, p);
        const type = fourcc(b, p + 4);
        let hdr = 8;
        if (size === 1) { size = u64(b, p + 8); hdr = 16; }
        else if (size === 0) { size = end - p; }
        if (size < hdr || p + size > end) break;
        out.push({ type, start: p, size, hdr, body: p + hdr, end: p + size });
        p += size;
      }
      return out;
    }
    const find = (arr, t) => arr.find(x => x.type === t);

    function split(b) {
      const top = boxList(b, 0, b.length);
      const ftyp = find(top, 'ftyp'), moov = find(top, 'moov');
      const segs = [];
      for (let i = 0; i < top.length; i++) {
        if (top[i].type !== 'moof') continue;
        const moof = top[i];
        const mdat = top[i + 1] && top[i + 1].type === 'mdat' ? top[i + 1] : null;
        segs.push({ moof, mdat, start: moof.start, end: mdat ? mdat.end : moof.end });
        if (mdat) i++;
      }
      if (!ftyp || !moov) throw new Error('不是 fMP4 分片（缺 ftyp/moov）');
      return { ftyp, moov, segs };
    }

    function extractTrak(b, moov, newId) {
      const trak = find(boxList(b, moov.body, moov.end), 'trak');
      if (!trak) throw new Error('moov 里没有 trak');
      const copy = b.slice(trak.start, trak.end);
      const tkhd = find(boxList(copy, 8, copy.length), 'tkhd');
      if (tkhd && newId) w32(copy, tkhd.body + 4 + (copy[tkhd.body] === 1 ? 16 : 8), newId);
      return copy;
    }
    function extractTrex(b, moov, newId) {
      const mvex = find(boxList(b, moov.body, moov.end), 'mvex');
      if (!mvex) return null;
      const trex = find(boxList(b, mvex.body, mvex.end), 'trex');
      if (!trex) return null;
      const copy = b.slice(trex.start, trex.end);
      if (newId) w32(copy, 12, newId);
      return copy;
    }
    function wrap(type, body) {
      const out = new Uint8Array(body.length + 8);
      w32(out, 0, body.length + 8);
      for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
      out.set(body, 8);
      return out;
    }
    function cat(parts) {
      let n = 0; for (const p of parts) n += p.length;
      const out = new Uint8Array(n); let o = 0;
      for (const p of parts) { out.set(p, o); o += p.length; }
      return out;
    }
    function patchSegment(b, seg, newId) {
      const copy = b.slice(seg.start, seg.end);
      for (const traf of boxList(copy, seg.moof.hdr, seg.moof.size).filter(x => x.type === 'traf')) {
        const tfhd = find(boxList(copy, traf.body, traf.end), 'tfhd');
        if (tfhd) w32(copy, tfhd.body + 4, newId);
      }
      return copy;
    }
    function decodeTime(b, seg) {
      for (const traf of boxList(b, seg.moof.body, seg.moof.end).filter(x => x.type === 'traf')) {
        const tfdt = find(boxList(b, traf.body, traf.end), 'tfdt');
        if (!tfdt) continue;
        return b[tfdt.body] === 1 ? u64(b, tfdt.body + 4) : u32(b, tfdt.body + 4);
      }
      return 0;
    }
    function trackId(b, moov) {
      const trak = find(boxList(b, moov.body, moov.end), 'trak');
      const tkhd = find(boxList(b, trak.body, trak.end), 'tkhd');
      return u32(b, tkhd.body + 4 + (b[tkhd.body] === 1 ? 16 : 8));
    }
    function timescale(b, trak) {
      const mdia = find(boxList(b, trak.body, trak.end), 'mdia');
      const mdhd = find(boxList(b, mdia.body, mdia.end), 'mdhd');
      return b[mdhd.body] === 1 ? u32(b, mdhd.body + 20) : u32(b, mdhd.body + 12);
    }

    /** videoU8 + audioU8 → 一个新的 fMP4（Uint8Array） */
    function mux(videoU8, audioU8) {
      const vb = new Uint8Array(videoU8);
      const ab = new Uint8Array(audioU8);
      const V = split(vb), A = split(ab);
      const idV = trackId(vb, V.moov);
      const idA = idV === 2 ? 3 : 2;                 // 音频新 id 避开视频
      const mvhdV = find(boxList(vb, V.moov.body, V.moov.end), 'mvhd');
      const mvhd = vb.slice(mvhdV.start, mvhdV.end);
      w32(mvhd, mvhd[8] === 1 ? 116 : 104, Math.max(idV, idA) + 1);

      const trakV = extractTrak(vb, V.moov);
      const trakA = extractTrak(ab, A.moov, idA);
      const trexV = extractTrex(vb, V.moov);
      const trexA = extractTrex(ab, A.moov, idA);
      if (!trexV || !trexA) throw new Error('缺少 mvex/trex，无法合并');

      const moov = wrap('moov', cat([mvhd, trakV, trakA, wrap('mvex', cat([trexV, trexA]))]));
      const ftyp = vb.slice(V.ftyp.start, V.ftyp.end);

      const tsV = timescale(vb, find(boxList(vb, V.moov.body, V.moov.end), 'trak'));
      const tsA = timescale(ab, find(boxList(ab, A.moov.body, A.moov.end), 'trak'));

      const stream = [];
      for (const s of V.segs) stream.push({ t: decodeTime(vb, s) / tsV, buf: vb.slice(s.start, s.end) });
      for (const s of A.segs) stream.push({ t: decodeTime(ab, s) / tsA, buf: patchSegment(ab, s, idA) });
      stream.sort((a, b) => a.t - b.t);

      return cat([ftyp, moov, ...stream.map(x => x.buf)]);
    }

    /** 判断一个 buffer 是不是可合并的 fMP4 分片 */
    function isFmp4(b) {
      try {
        const u8 = new Uint8Array(b, 0, Math.min(b.byteLength, 64));
        return fourcc(u8, 4) === 'ftyp';
      } catch (e) { return false; }
    }

    return { mux, isFmp4 };
  })();

  /* ============================== 下载核心 ============================== */

  /** 把一条流的 baseUrl + backupUrl 归一成候选 URL 列表，官方源优先 */
  function urlCandidates(item) {
    const list = [item.baseUrl || item.base_url].concat(item.backupUrl || item.backup_url || []).filter(Boolean);
    const score = u => {
      if (/upos-/.test(u)) return 0;          // 官方源
      if (/mcdn|p2p|szbdyd/.test(u)) return 2; // P2P / 第三方加速，经常限速
      return 1;
    };
    return list.map((u, i) => ({ u, s: score(u), i })).sort((a, b) => a.s - b.s || a.i - b.i).map(x => x.u);
  }

  /** 探测真实字节数（Range 0-0 走 206 的 Content-Range） */
  async function probeSize(urls) {
    for (const u of urls.slice(0, 4)) {
      try {
        const r = await gm({
          method: 'GET', url: u,
          headers: Object.assign({ Range: 'bytes=0-0' }, BILI_HEADERS),
          responseType: 'arraybuffer', timeout: 20000
        });
        if (r.status !== 206 && r.status !== 200) continue;
        const cr = (r.responseHeaders || '').match(/content-range:\s*bytes\s+\d+-\d+\/(\d+)/i);
        if (cr) return parseInt(cr[1], 10);
        const cl = (r.responseHeaders || '').match(/content-length:\s*(\d+)/i);
        if (cl && r.status === 200) return parseInt(cl[1], 10);
      } catch (e) { /* 换下一个 */ }
    }
    return 0;
  }

  async function fetchRange(urls, start, end, signal, retries = 3) {
    let lastErr;
    for (let a = 0; a < retries; a++) {
      if (signal && signal.cancelled) throw new Error('ABORTED');
      const u = urls[a % urls.length];
      try {
        const r = await gm({
          method: 'GET', url: u,
          headers: Object.assign({ Range: `bytes=${start}-${end}` }, BILI_HEADERS),
          responseType: 'arraybuffer', timeout: 120000
        });
        if (r.status === 206 || r.status === 200) {
          const buf = r.response;
          if (buf && buf.byteLength > 0) return buf;
        }
        lastErr = new Error('HTTP ' + r.status);
      } catch (e) { lastErr = e; }
      await sleep(250 * (a + 1));
    }
    throw lastErr || new Error('chunk failed');
  }

  /** 一个文件：多线程 Range 分块 + 顺序写盘 */
  async function downloadToFile({ urls, size, name, fileHandle, onProgress, signal, threads }) {
    let total = size;
    if (!total) total = await probeSize(urls);
    if (!total) throw new Error('无法获取文件大小（CDN 拒绝请求）');

    const writable = await fileHandle.createWritable();
    const CHUNK = 4 * 1024 * 1024;
    const parts = Math.ceil(total / CHUNK);
    const bufs = new Array(parts);
    let fetchIdx = 0, writeIdx = 0, doneBytes = 0;
    let t0 = Date.now(), lastTick = 0, writeError = null;

    // 串行锁：保证 write 按 index 顺序写入
    let lock = Promise.resolve();
    function serial(fn) {
      const next = lock.then(fn, fn);
      lock = next.catch(() => { });
      return next;
    }
    async function flushLoop() {
      while (writeIdx < parts && bufs[writeIdx]) {
        const b = bufs[writeIdx];
        bufs[writeIdx] = null;
        await writable.write(new Uint8Array(b));
        writeIdx++;
      }
    }

    const n = clamp(threads || 4, 1, 8);
    const workers = [];
    for (let w = 0; w < n; w++) {
      workers.push((async () => {
        while (true) {
          if (signal && signal.cancelled) return;
          // 背压：领先写盘太多就等一会，防止大文件把内存吃满
          while (fetchIdx - writeIdx > 6) {
            if (signal && signal.cancelled) return;
            await sleep(60);
          }
          const i = fetchIdx++;
          if (i >= parts) return;
          const start = i * CHUNK;
          const end = Math.min(total - 1, start + CHUNK - 1);
          const buf = await fetchRange(urls, start, end, signal);
          bufs[i] = buf;
          doneBytes += buf.byteLength;
          serial(flushLoop).catch(e => { writeError = writeError || e; });
          const now = Date.now();
          if (now - lastTick > 120) {
            lastTick = now;
            const speed = doneBytes / ((now - t0) / 1000);
            onProgress && onProgress({ done: doneBytes, total, speed, parts, writeIdx });
          }
        }
      })());
    }

    try {
      await Promise.all(workers);
      await serial(flushLoop);
      if (writeError) throw writeError;
      if (signal && signal.cancelled) {
        try { await writable.abort(); } catch (e) { }
        throw new Error('ABORTED');
      }
      if (writeIdx !== parts) throw new Error('分块不完整（' + writeIdx + '/' + parts + '）');
      await writable.close();
      onProgress && onProgress({ done: total, total, speed: total / ((Date.now() - t0) / 1000), done_: true });
    } catch (e) {
      try { await writable.abort(); } catch (_) { }
      throw e;
    }
    return { name, size: total };
  }

  /** 无 File System Access 时的降级：全量拼 Blob 触发浏览器下载 */
  async function downloadToBlob({ urls, size, name, onProgress, signal, threads }) {
    const agg = await downloadToMemory({ urls, size, onProgress, signal, threads });
    const blob = new Blob([agg], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 60000);
    return { name, size: blob.size, blob };
  }

  async function downloadToMemory({ urls, size, onProgress, signal, threads }) {
    let total = size || await probeSize(urls);
    if (!total) throw new Error('无法获取文件大小');
    const CHUNK = 4 * 1024 * 1024;
    const parts = Math.ceil(total / CHUNK);
    const bufs = new Array(parts);
    let fetchIdx = 0, doneBytes = 0, t0 = Date.now(), lastTick = 0;
    const n = clamp(threads || 4, 1, 8);
    const ws = [];
    for (let w = 0; w < n; w++) {
      ws.push((async () => {
        while (true) {
          if (signal && signal.cancelled) throw new Error('ABORTED');
          const i = fetchIdx++;
          if (i >= parts) return;
          const start = i * CHUNK, end = Math.min(total - 1, start + CHUNK - 1);
          bufs[i] = await fetchRange(urls, start, end, signal);
          doneBytes += bufs[i].byteLength;
          const now = Date.now();
          if (now - lastTick > 120) {
            lastTick = now;
            onProgress && onProgress({ done: doneBytes, total, speed: doneBytes / ((now - t0) / 1000) });
          }
        }
      })());
    }
    await Promise.all(ws);
    if (signal && signal.cancelled) throw new Error('ABORTED');
    if (bufs.some(b => !b)) throw new Error('分块不完整');
    return new Blob(bufs);
  }

  /* ============================== UI：触发按钮 ============================== */

  const TRIGGER_ID = 'bili-dl-trigger';

  function findShareItemRobust() {
    const scopes = ['.video-toolbar-left', '[class*="video-toolbar-left"]',
      '#arc_toolbar_report', '.video-info-container', '.video-toolbar-container'];
    for (const sel of scopes) {
      const box = document.querySelector(sel);
      if (!box) continue;
      const items = Array.from(box.querySelectorAll(
        '.video-toolbar-left-item, [class*="toolbar-left-item"], [class*="share"]'));
      const byText = items.find(el => /^\s*分享\s*$/.test((el.textContent || '').trim()));
      if (byText) return byText.closest('[class*="toolbar-left-item"]') || byText;
      const byCls = box.querySelector('[class*="share"]');
      if (byCls) return byCls;
    }
    // 文本兜底：小尺寸、文字恰好是「分享」
    for (const sel of scopes) {
      const box = document.querySelector(sel);
      if (!box) continue;
      const cand = Array.from(box.querySelectorAll('*')).find(el => {
        if (el.children.length > 2) return false;
        if ((el.textContent || '').trim() !== '分享') return false;
        const r = el.getBoundingClientRect();
        return r.width > 8 && r.width < 200 && r.height > 6;
      });
      if (cand) return cand.closest('[class*="toolbar-left-item"]') || cand.parentElement;
    }
    return null;
  }

  function makeTrigger(place) {
    const el = document.createElement('div');
    el.id = TRIGGER_ID;
    el.dataset.place = place || 'toolbar';
    el.className = place === 'ctrl' ? 'bili-dl-trigger bili-dl-ctrl'
      : place === 'float' ? 'bili-dl-trigger bili-dl-floating'
        : 'video-toolbar-left-item bili-dl-trigger';
    const base = [
      'display:inline-flex', 'align-items:center', 'gap:5px', 'cursor:pointer',
      'font-size:13px', 'line-height:1', 'color:#61666d', 'padding:0 10px',
      'height:100%', 'min-height:32px', 'user-select:none', 'transition:.15s',
      'border-radius:6px', 'white-space:nowrap', 'flex:0 0 auto'
    ];
    if (place === 'ctrl') base.push('height:32px', 'color:#fff', 'opacity:.85', 'padding:0 8px');
    if (place === 'float') base.push('position:fixed', 'right:20px', 'bottom:140px',
      'z-index:2147483000', 'background:rgba(24,25,28,.92)', 'color:#fff',
      'height:38px', 'padding:0 14px', 'border-radius:19px', 'font-size:13px',
      'box-shadow:0 6px 22px rgba(0,0,0,.45)', 'border:1px solid rgba(255,255,255,.14)');
    el.style.cssText = base.join(';');
    el.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex:0 0 auto">' +
      '<path d="M12 3v11"/><path d="M7.5 10.5 12 15l4.5-4.5"/>' +
      '<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>' +
      '<span>下载视频</span>';
    el.addEventListener('mouseenter', () => {
      el.style.color = '#00aeec';
      el.style.background = place === 'float' ? 'rgba(0,174,236,.9)' : 'rgba(0,174,236,.10)';
    });
    el.addEventListener('mouseleave', () => {
      el.style.color = place === 'float' ? '#fff' : (place === 'ctrl' ? '#fff' : '#61666d');
      el.style.background = place === 'float' ? 'rgba(24,25,28,.92)' : 'transparent';
    });
    el.addEventListener('click', ev => {
      ev.preventDefault(); ev.stopPropagation();
      openPanel();
    });
    return el;
  }

  /**
   * 三级挂载：①详情页「分享」右侧（默认）②播放器控制栏右下 ③右下角悬浮按钮
   * 已挂成悬浮态但后来详情页渲染出来了，会升级回工具栏。
   */
  function mountTrigger() {
    const exist = document.getElementById(TRIGGER_ID);
    if (exist && exist.dataset.place !== 'float') return;

    const share = findShareItemRobust();
    if (share && share.parentNode) {
      if (exist) exist.remove();
      share.parentNode.insertBefore(makeTrigger('toolbar'), share.nextSibling);
      console.log('[bili-dl] 按钮已挂到「分享」右侧');
      return;
    }

    const ctrl = document.querySelector('.bpx-player-control-bottom-right')
      || document.querySelector('.bpx-player-control-bottom-center')
      || document.querySelector('.bpx-player-control-bottom');
    if (ctrl) {
      if (exist && exist.dataset.place === 'ctrl') return;
      if (exist) exist.remove();
      ctrl.insertBefore(makeTrigger('ctrl'), ctrl.firstChild);
      console.log('[bili-dl] 按钮已挂到播放器控制栏');
      return;
    }

    if (!exist) {
      document.body.appendChild(makeTrigger('float'));
      console.log('[bili-dl] 未找到工具栏，已使用右下角悬浮按钮');
    }
  }

  /* ============================== UI：面板 ============================== */

  const CSS = `
  :host{all:initial}
  *{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
  .wrap{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center}
  .mask{position:absolute;inset:0;background:rgba(0,0,0,.55);backdrop-filter:blur(3px)}
  .card{position:relative;width:min(780px,94vw);max-height:86vh;display:flex;flex-direction:column;
    background:#18191c;color:#e3e5e7;border-radius:14px;overflow:hidden;
    box-shadow:0 24px 70px rgba(0,0,0,.6);border:1px solid rgba(255,255,255,.08)}
  .head{display:flex;align-items:flex-start;gap:10px;padding:16px 18px 12px;border-bottom:1px solid rgba(255,255,255,.07)}
  .head h3{margin:0;font-size:16px;font-weight:600;letter-spacing:.3px}
  .head .sub{margin-top:5px;font-size:12px;color:#9499a0;line-height:1.5;word-break:break-all}
  .badge{display:inline-block;padding:1px 7px;border-radius:4px;font-size:11px;margin-left:6px;vertical-align:1px}
  .badge.vip{background:rgba(251,114,153,.16);color:#fb7299;border:1px solid rgba(251,114,153,.4)}
  .badge.nologin{background:rgba(255,102,102,.14);color:#ff7a7a;border:1px solid rgba(255,102,102,.35)}
  .badge.ok{background:rgba(0,174,236,.14);color:#00aeec;border:1px solid rgba(0,174,236,.35)}
  .close{margin-left:auto;cursor:pointer;color:#9499a0;font-size:18px;line-height:1;padding:2px 6px;border-radius:6px}
  .close:hover{background:rgba(255,255,255,.1);color:#fff}
  .body{padding:12px 18px;overflow:auto;flex:1}
  .row{display:flex;align-items:center;gap:10px;margin-bottom:12px;font-size:13px}
  .row label{color:#9499a0;flex:0 0 auto}
  select,input[type=checkbox]{accent-color:#00aeec}
  select{background:#232527;color:#e3e5e7;border:1px solid rgba(255,255,255,.12);border-radius:7px;padding:6px 10px;font-size:13px;outline:none;max-width:100%}
  .sec{margin-bottom:14px}
  .sec-title{font-size:12px;color:#9499a0;letter-spacing:.6px;margin-bottom:7px;display:flex;align-items:center;gap:8px}
  .sec-title .hint{color:#5f6469;font-size:11px;letter-spacing:0}
  .list{border:1px solid rgba(255,255,255,.08);border-radius:10px;overflow:hidden}
  .item{display:grid;grid-template-columns:22px 1fr auto auto;gap:10px;align-items:center;
    padding:9px 12px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,.05);transition:.12s}
  .item:last-child{border-bottom:none}
  .item:hover{background:rgba(255,255,255,.045)}
  .item.on{background:rgba(0,174,236,.12);box-shadow:inset 2px 0 0 #00aeec}
  .item .dot{width:14px;height:14px;border-radius:50%;border:1.5px solid #5f6469;display:flex;align-items:center;justify-content:center}
  .item.on .dot{border-color:#00aeec}
  .item.on .dot::after{content:"";width:7px;height:7px;border-radius:50%;background:#00aeec}
  .item .main{min-width:0}
  .item .t1{font-size:13px;color:#e3e5e7;display:flex;align-items:center;gap:7px;flex-wrap:wrap}
  .item .t2{font-size:11px;color:#7c8288;margin-top:3px}
  .qn{font-size:11px;padding:1px 6px;border-radius:4px;background:rgba(255,255,255,.09);color:#c9ccd0}
  .qn.hi{background:rgba(251,114,153,.18);color:#fb7299}
  .codec{font-size:11px;padding:1px 6px;border-radius:4px;font-weight:600}
  .codec.AVC{background:rgba(0,174,236,.15);color:#4cc6f2}
  .codec.HEVC{background:rgba(140,120,255,.18);color:#a99cff}
  .codec.AV1{background:rgba(90,200,120,.15);color:#63d18b}
  .num{font-variant-numeric:tabular-nums;font-size:12px;color:#c9ccd0;text-align:right;white-space:nowrap}
  .num small{color:#7c8288;font-size:11px;display:block;margin-top:2px}
  .opts{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:#9499a0;align-items:center;
    padding:10px 12px;background:rgba(255,255,255,.03);border-radius:10px}
  .opts label{display:inline-flex;align-items:center;gap:6px;cursor:pointer;color:#c9ccd0}
  .prog{margin-top:12px;border-radius:10px;background:rgba(255,255,255,.04);padding:12px 14px;font-size:12px;display:none}
  .prog.show{display:block}
  .pfile{margin-bottom:10px}
  .pfile:last-child{margin-bottom:0}
  .pname{display:flex;justify-content:space-between;color:#c9ccd0;margin-bottom:6px;gap:10px}
  .pname span:last-child{color:#7c8288;white-space:nowrap;font-variant-numeric:tabular-nums}
  .bar{height:6px;border-radius:99px;background:rgba(255,255,255,.09);overflow:hidden}
  .bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#00aeec,#2fd6a6);border-radius:99px;transition:width .18s}
  .foot{display:flex;gap:10px;padding:12px 18px 16px;border-top:1px solid rgba(255,255,255,.07);align-items:center}
  button{font:inherit;font-size:13px;padding:8px 16px;border-radius:8px;border:1px solid rgba(255,255,255,.14);
    background:rgba(255,255,255,.06);color:#e3e5e7;cursor:pointer;transition:.15s;white-space:nowrap}
  button:hover{background:rgba(255,255,255,.12)}
  button.primary{background:#00aeec;border-color:#00aeec;color:#fff;font-weight:600;padding:9px 22px}
  button.primary:hover{background:#33bff0}
  button.danger{background:rgba(255,102,102,.15);border-color:rgba(255,102,102,.4);color:#ff8a8a}
  button:disabled{opacity:.45;cursor:not-allowed}
  .spacer{flex:1}
  .loading{padding:40px;text-align:center;color:#9499a0;font-size:13px}
  .spin{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.2);
    border-top-color:#00aeec;border-radius:50%;animation:sp .7s linear infinite;vertical-align:-2px;margin-right:7px}
  @keyframes sp{to{transform:rotate(360deg)}}
  .err{color:#ff8a8a;font-size:12px;line-height:1.7;padding:10px 12px;background:rgba(255,102,102,.08);border-radius:8px}
  .foot .tip{font-size:11px;color:#5f6469}
  `;

  let host = null, root = null, ui = {};

  function buildPanel() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'bili-dl-panel-host';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:none';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style><div class="wrap"><div class="mask"></div><div class="card">
      <div class="head">
        <div style="min-width:0">
          <h3>下载视频 <span class="badge" id="acct"></span></h3>
          <div class="sub" id="sub">正在读取视频信息…</div>
        </div>
        <div class="close" title="关闭">✕</div>
      </div>
      <div class="body" id="body"><div class="loading"><span class="spin"></span>正在请求 bilibili 接口…</div></div>
      <div class="foot">
        <button id="btnAria">复制 aria2 命令</button>
        <button id="btnFf">复制 ffmpeg 合并命令</button>
        <span class="spacer"></span>
        <span class="tip" id="tip"></span>
        <button class="primary" id="btnGo" disabled>开始下载</button>
      </div>
    </div></div>`;
    document.body.appendChild(host);

    ui = {
      acct: root.getElementById('acct'),
      sub: root.getElementById('sub'),
      body: root.getElementById('body'),
      btnGo: root.getElementById('btnGo'),
      btnAria: root.getElementById('btnAria'),
      btnFf: root.getElementById('btnFf'),
      tip: root.getElementById('tip'),
      close: root.querySelector('.close'),
      mask: root.querySelector('.mask')
    };
    ui.close.onclick = closePanel;
    ui.mask.onclick = closePanel;
    ui.btnGo.onclick = onStartDownload;
    ui.btnAria.onclick = onCopyAria;
    ui.btnFf.onclick = onCopyFFmpeg;
  }

  function openPanel() {
    buildPanel();
    host.style.display = 'block';
    loadVideoInfo();
  }
  function closePanel() {
    if (state.job && !state.job.cancelled) {
      if (!confirm('下载正在进行，确定要关闭并中断吗？')) return;
      state.job.cancelled = true;
      state.job.aborts && state.job.aborts.forEach(a => { try { a(); } catch (e) { } });
    }
    host && (host.style.display = 'none');
  }

  /* ---------- 读取并渲染 ---------- */

  async function loadVideoInfo() {
    const bvid = currentBvid();
    if (!bvid) {
      renderError('无法从当前页面识别视频号（BV/av）。请打开 https://www.bilibili.com/video/BV... 页面。');
      return;
    }
    ui.body.innerHTML = '<div class="loading"><span class="spin"></span>正在请求 bilibili 接口…</div>';
    ui.btnGo.disabled = true;

    try {
      const [nav, view] = await Promise.all([getNav(), getView(bvid)]);
      state.bvid = view.bvid;
      state.view = view;
      state.nav = nav;
      state.navAt = Date.now();

      ui.acct.className = 'badge ' + (nav.login ? (nav.vip ? 'vip' : 'ok') : 'nologin');
      ui.acct.textContent = nav.login ? (nav.vip ? '大会员' : '已登录') : '未登录';
      ui.sub.textContent = view.title + '　·　' + fmtTime(view.duration) +
        '　·　' + (view.owner ? view.owner.name : '');

      const pi = clamp(currentP() - 1, 0, Math.max(0, (view.pages || []).length - 1));
      await loadPlayurl(pi);
    } catch (e) {
      renderError(e.message || String(e));
    }
  }

  async function loadPlayurl(pageIndex) {
    // wbi key 会变，页面开了很久就重取一次
    if (!state.nav || !state.nav.wbiImg || Date.now() - (state.navAt || 0) > 3600 * 1000) {
      const n = await getNav();
      if (n.login || !state.nav) state.nav = n;
      state.navAt = Date.now();
    }
    const view = state.view;
    const pages = view.pages || [];
    const page = pages[pageIndex] || { cid: view.cid, part: view.title, duration: view.duration };
    ui.body.innerHTML = '<div class="loading"><span class="spin"></span>正在探测可用清晰度…</div>';
    ui.btnGo.disabled = true;

    try {
      const data = await getPlayurl(view, page.cid, state.nav);
      state.playurl = data;
      state.playurlAt = Date.now();
      state.playurlCid = page.cid;
      state.selectedVideo = null;
      state.selectedAudio = null;
      renderPanel(pageIndex, page, data);
    } catch (e) {
      renderError(e.message || String(e));
    }
  }

  function renderError(msg) {
    ui.body.innerHTML = '<div class="err">' + String(msg).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) +
      '</div>';
    ui.btnGo.disabled = true;
  }

  function renderPanel(pageIndex, page, data) {
    state.pageIndex = pageIndex;
    const view = state.view;
    const pages = view.pages || [];
    const dur = page.duration || view.duration || 0;
    const dash = data.dash || {};
    const vlist = (dash.video || []).slice();
    const alist = (dash.audio || []).slice();
    const supportMap = {};
    (data.support_formats || []).forEach(f => { supportMap[f.quality] = f; });

    vlist.sort((a, b) => (QN_RANK[b.id] || 0) - (QN_RANK[a.id] || 0) || b.bandwidth - a.bandwidth);
    alist.sort((a, b) => b.bandwidth - a.bandwidth);

    const rows = vlist.map((v, i) => {
      const fam = codecFamily(v.codecs);
      const qn = QN_NAME[v.id] || ('qn' + v.id);
      const sf = supportMap[v.id];
      const vipFlag = sf && sf.need_vip ? '<span class="qn hi">大会员</span>' : '';
      const hdr = (v.id === 125 || v.id === 126) ? '<span class="qn hi">HDR</span>' : '';
      const est = v.bandwidth * dur / 8;
      const fps = v.frameRate || (v.frame_rate && String(v.frame_rate).replace('fps', '')) || '?';
      return `<div class="item" data-k="v" data-i="${i}" data-idx="${vlist.indexOf(v)}">
        <div class="dot"></div>
        <div class="main">
          <div class="t1"><span class="qn${(v.id >= 112) ? ' hi' : ''}">${qn}</span>
            <span class="codec ${fam}" title="${CODEC_HINT[fam] || ''}">${fam}</span>${vipFlag}${hdr}
            <span style="color:#7c8288;font-size:12px">${v.width}×${v.height}${fps !== '?' ? ' @' + fps + 'fps' : ''}</span></div>
          <div class="t2">${v.codecs || ''}</div>
        </div>
        <div class="num">${(v.bandwidth / 1000).toFixed(0)} kbps<small>≈ ${fmtBytes(est)}</small></div>
        <div class="num" style="width:64px"></div>
      </div>`;
    }).join('');

    const arows = alist.map((a, i) => {
      const fam = codecFamily(a.codecs);
      const est = a.bandwidth * dur / 8;
      const names = { 30280: '高码率', 30232: '中码率', 30216: '低码率' };
      return `<div class="item" data-k="a" data-i="${i}">
        <div class="dot"></div>
        <div class="main">
          <div class="t1"><span class="qn">${names[a.id] || ('id' + a.id)}</span>
            <span class="codec ${fam}">${fam}</span>
            <span style="color:#7c8288;font-size:12px">${a.codecs || ''}</span></div>
        </div>
        <div class="num">${(a.bandwidth / 1000).toFixed(0)} kbps<small>≈ ${fmtBytes(est)}</small></div>
        <div class="num" style="width:64px"></div>
      </div>`;
    }).join('');

    const pageSel = pages.length > 1
      ? `<div class="row"><label>分P</label><select id="selPage">` +
      pages.map((p, i) => `<option value="${i}"${i === pageIndex ? ' selected' : ''}>P${i + 1} ${escapeHtml(p.part || '')}（${fmtTime(p.duration)}）</option>`).join('') +
      `</select></div>`
      : '';

    ui.body.innerHTML = `
      ${pageSel}
      <div class="sec">
        <div class="sec-title">视频轨 <span class="hint">共 ${vlist.length} 条 · 数值为 CDN 标称码率，实际大小以探测值为准</span></div>
        <div class="list" id="vlist">${rows || '<div class="loading">没有可用的视频流（可能是番剧/付费内容）</div>'}</div>
      </div>
      <div class="sec">
        <div class="sec-title">音频轨 <span class="hint">DASH 音视频分离，下载后需用 ffmpeg 合并</span></div>
        <div class="list" id="alist">${arows || '<div class="loading">没有独立音轨</div>'}</div>
      </div>
      <div class="opts">
        <label><input type="checkbox" id="optAudio" checked> 同时下载音频</label>
        <label title="跳过视频轨，只把音频（m4a）扒下来，适合提取 BGM"><input type="checkbox" id="optAudioOnly"> 只下载音频</label>
        <label title="用纯 JS 把视频轨和音频轨拼成一个 mp4，不重编码、不需要 ffmpeg"><input type="checkbox" id="optMerge" checked> 下载后自动合并</label>
        <label>线程 <select id="optThreads">
          <option value="1">1（最稳）</option><option value="4" selected>4（推荐）</option>
          <option value="8">8（最快，易被限速）</option></select></label>
        <label>保存方式 <select id="optSave">
          <option value="fs">选择保存位置（流式，同名文件会被覆盖）</option>
          <option value="blob">浏览器默认下载（大文件慎用）</option></select></label>
      </div>
      <div class="prog" id="prog"></div>`;

    // 绑定选择
    const vWrap = root.getElementById('vlist');
    const aWrap = root.getElementById('alist');
    const pick = (wrap, key, arr) => {
      if (!wrap) return;
      wrap.addEventListener('click', ev => {
        const item = ev.target.closest('.item');
        if (!item) return;
        wrap.querySelectorAll('.item').forEach(x => x.classList.remove('on'));
        item.classList.add('on');
        const idx = parseInt(item.dataset.i, 10);
        if (key === 'v') state.selectedVideo = arr[idx];
        else state.selectedAudio = arr[idx];
        syncGoState();
        updateTip(dur);
      });
    };
    pick(vWrap, 'v', vlist);
    pick(aWrap, 'a', alist);

    // 默认选最高画质（第一条），音频选最高
    if (vlist.length) {
      state.selectedVideo = vlist[0];
      const first = vWrap.querySelector('.item');
      first && first.classList.add('on');
    }
    if (alist.length) {
      state.selectedAudio = alist[0];
      const f = aWrap.querySelector('.item');
      f && f.classList.add('on');
    }

    const selPage = root.getElementById('selPage');
    if (selPage) selPage.onchange = () => loadPlayurl(parseInt(selPage.value, 10));

    const oa = root.getElementById('optAudio');
    if (oa) oa.onchange = () => updateTip(dur);
    const oao = root.getElementById('optAudioOnly');
    if (oao) oao.onchange = () => { syncGoState(); updateTip(dur); };

    syncGoState();
    ui.tip.textContent = '';
    updateTip(dur);

    // 记录带宽估算用时长
    state.dur = dur;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  }

  function audioOnlyOn() {
    const el = root && root.getElementById('optAudioOnly');
    return !!(el && el.checked);
  }

  function syncGoState() {
    const can = audioOnlyOn() ? !!state.selectedAudio : !!state.selectedVideo;
    if (ui.btnGo) ui.btnGo.disabled = !can;
  }

  function updateTip(dur) {
    if (!ui.tip) return;
    const v = state.selectedVideo, a = state.selectedAudio;
    const only = audioOnlyOn();
    if (only) {
      if (!a) { ui.tip.textContent = ''; return; }
      ui.tip.textContent = '仅音频 ' + fmtBytes(a.bandwidth * (dur || 0) / 8);
      return;
    }
    if (!v) { ui.tip.textContent = ''; return; }
    const withAudio = root.getElementById('optAudio') ? root.getElementById('optAudio').checked : true;
    let est = v.bandwidth * (dur || 0) / 8;
    if (withAudio && a) est += a.bandwidth * (dur || 0) / 8;
    ui.tip.textContent = '预计 ' + fmtBytes(est);
  }

  /* ============================== 下载流程 ============================== */

  function fileNameFor(v, pageIndex, page, kind) {
    const view = state.view;
    const t = safeName(view.title);
    const pTag = (view.pages || []).length > 1 ? `_P${pageIndex + 1}` : '';
    const fam = codecFamily(v.codecs);
    if (kind === 'audio') {
      return `${t}${pTag}_audio_${(v.bandwidth / 1000).toFixed(0)}kbps.m4a`;
    }
    return `${t}${pTag}_${v.width}x${v.height}_${fam}_${(v.bandwidth / 1000).toFixed(0)}kbps.mp4`;
  }

  function getPicker() {
    const w = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
    return {
      save: (w.showSaveFilePicker || null),
      dir: (w.showDirectoryPicker || null),
      ctx: w
    };
  }

  async function onStartDownload() {
    if (state.job && !state.job.cancelled) return;

    const optAudio = root.getElementById('optAudio');
    const optAudioOnly = root.getElementById('optAudioOnly');
    const audioOnly = !!(optAudioOnly && optAudioOnly.checked) && !!state.selectedAudio;

    const v = audioOnly ? null : state.selectedVideo;
    const a = audioOnly ? state.selectedAudio : (optAudio && optAudio.checked ? state.selectedAudio : null);
    if (!v && !a) return;
    const withAudio = !!a;

    const optThreads = root.getElementById('optThreads');
    const optSave = root.getElementById('optSave');
    const threads = parseInt(optThreads ? optThreads.value : '4', 10) || 4;
    const mode = optSave ? optSave.value : 'fs';
    const fileCount = (v ? 1 : 0) + (withAudio ? 1 : 0);

    // 授权窗口必须在用户手势里同步打开，所以先拿 handle，再发网络请求
    let dirHandle = null, vHandle = null, aHandle = null;
    const picker = getPicker();
    const pages = (state.view.pages || []);
    const pageIndex = state.pageIndex || 0;
    const page = pages[pageIndex] || { duration: state.view.duration };

    if (mode === 'fs') {
      try {
        if (fileCount >= 2) {
          if (!picker.dir) throw new Error('当前浏览器不支持文件夹选择，请把保存方式改成「浏览器默认下载」');
          dirHandle = await picker.dir.call(picker.ctx, { id: 'bili-dl-out', mode: 'readwrite' });
        } else if (!picker.save) {
          throw new Error('当前浏览器不支持流式保存，请把保存方式改成「浏览器默认下载」');
        }
      } catch (e) {
        if (e && (e.name === 'AbortError' || /aborted/i.test(String(e)))) {
          ui.tip.textContent = '已取消选择';
          return;
        }
        renderInlineError(e.message || String(e));
        return;
      }
    }

    state.job = { cancelled: false, aborts: [] };
    setDownloading(true);
    const prog = root.getElementById('prog');
    prog.classList.add('show');
    prog.innerHTML = '';

    const slot = (label) => {
      const div = document.createElement('div');
      div.className = 'pfile';
      div.innerHTML = `<div class="pname"><span>${escapeHtml(label)}</span><span>准备中…</span></div>
        <div class="bar"><i></i></div>`;
      prog.appendChild(div);
      return {
        el: div,
        bar: div.querySelector('i'),
        info: div.querySelector('.pname span:last-child')
      };
    };
    const setSlot = (s, p) => {
      if (!s) return;
      const pct = p.total ? clamp(p.done / p.total * 100, 0, 100) : 0;
      s.bar.style.width = pct.toFixed(1) + '%';
      s.info.textContent = p.done_ ? '完成 ' + fmtBytes(p.total)
        : `${fmtBytes(p.done)} / ${fmtBytes(p.total)}　${fmtBytes(p.speed)}/s`;
    };

    // 面板放太久 → 重新取一次 playurl（CDN 直链约 2 小时过期）
    let vItem = v, aItem = a;
    if (Date.now() - state.playurlAt > 10 * 60 * 1000) {
      try {
        const fresh = await getPlayurl(state.view, String(state.playurlCid), state.nav);
        if (v) {
          const nv = (fresh.dash.video || []).find(x => x.id === v.id && x.codecs === v.codecs);
          if (nv) vItem = nv;
        }
        if (a) {
          const na = (fresh.dash.audio || []).find(x => x.id === a.id);
          if (na) aItem = na;
        }
      } catch (e) { /* 用旧的 */ }
    }

    const vName = v ? fileNameFor(vItem, pageIndex, page, 'video') : null;
    const aName = withAudio ? fileNameFor(aItem, pageIndex, page, 'audio') : null;

    const vSlot = v ? slot(vItem.width + '×' + vItem.height + ' ' + codecFamily(vItem.codecs) + '（视频）') : null;
    const aSlot = withAudio ? slot('音频 ' + (aItem.bandwidth / 1000).toFixed(0) + 'kbps') : null;

    try {
      // 流式保存：先授权文件 / 文件夹
      if (mode === 'fs' && dirHandle) {
        if (v) vHandle = await dirHandle.getFileHandle(vName, { create: true });
        if (withAudio) aHandle = await dirHandle.getFileHandle(aName, { create: true });
      } else if (mode === 'fs' && fileCount === 1) {
        const onlyName = v ? vName : aName;
        const h = await picker.save.call(picker.ctx, { suggestedName: onlyName, id: 'bili-dl-one' });
        if (v) vHandle = h; else aHandle = h;
      }

      const doOne = async (item, name, handle, s) => {
        const urls = urlCandidates(item);
        const onp = p => { setSlot(s, p); };
        if (mode === 'fs' && handle) {
          return downloadToFile({ urls, size: 0, name, fileHandle: handle, onProgress: onp, signal: state.job, threads });
        }
        return downloadToBlob({ urls, size: 0, name, onProgress: onp, signal: state.job, threads });
      };

      const vRes = v ? await doOne(vItem, vName, vHandle, vSlot) : null;
      const aRes = withAudio ? await doOne(aItem, aName, aHandle, aSlot) : null;

      // 纯 JS 自动合并（不需要 ffmpeg）
      let merged = null, mergeErr = null;
      const optMerge = root.getElementById('optMerge');
      if (vRes && aRes && optMerge && optMerge.checked) {
        const mSlot = slot('合并音视频轨（纯 JS，不重编码）');
        try {
          merged = await mergeTracks(vRes, aRes, vName, mSlot, dirHandle);
        } catch (e) {
          mergeErr = (e && e.message) || String(e);
          mSlot.info.textContent = '合并失败：' + mergeErr;
        }
      }

      ui.tip.textContent = merged ? '完成（已合并）' : '完成';
      setDownloading(false);
      showDone(vName, withAudio ? aName : null, merged, mergeErr);
    } catch (e) {
      setDownloading(false);
      if (e.message === 'ABORTED' || (e.name === 'AbortError')) {
        ui.tip.textContent = '已中断';
      } else {
        ui.tip.textContent = '失败';
        renderInlineError((e && e.message) || String(e));
      }
    } finally {
      if (state.job) state.job.cancelled = true;
      state.job = null;
      syncGoState();
    }
  }

  /** 下载完成后：读回两条轨 → 纯 JS 拼 → 写出一个带音轨的 mp4 */
  async function mergeTracks(vRes, aRes, vName, slot, dirHandle) {
    const take = async res => {
      if (res.blob) return new Uint8Array(await res.blob.arrayBuffer());
      const fh = await dirHandle.getFileHandle(res.name);
      const f = await fh.getFile();
      return new Uint8Array(await f.arrayBuffer());
    };
    const total = (vRes.size || 0) + (aRes.size || 0);
    if (total > 900 * 1024 * 1024) throw new Error('两条轨合计超过 900MB，跳过自动合并（请用 ffmpeg 命令）');

    slot.info.textContent = '读取已下载数据…';
    const v = await take(vRes);
    const a = await take(aRes);
    slot.info.textContent = '合并中…';
    const out = FMP4.mux(v, a);

    const name = vName.replace(/\.mp4$/i, '') + '_merged.mp4';
    if (dirHandle) {
      const fh = await dirHandle.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(out);
      await w.close();
    } else {
      const blob = new Blob([out], { type: 'video/mp4' });
      const el = document.createElement('a');
      el.href = URL.createObjectURL(blob);
      el.download = name;
      document.body.appendChild(el);
      el.click();
      setTimeout(() => { URL.revokeObjectURL(el.href); el.remove(); }, 60000);
    }
    slot.bar.style.width = '100%';
    slot.info.textContent = '已合并 ' + fmtBytes(out.length);
    return { name, size: out.length };
  }

  function setDownloading(on) {
    ui.btnGo.disabled = on;
    ui.btnGo.textContent = on ? '下载中…' : '开始下载';
  }

  function renderInlineError(msg) {
    const prog = root.getElementById('prog');
    if (!prog) return;
    prog.classList.add('show');
    prog.innerHTML = '<div class="err">' + escapeHtml(msg) + '</div>';
  }

  function showDone(vName, aName, merged, mergeErr) {
    const prog = root.getElementById('prog');
    if (!prog) return;
    prog.classList.add('show');
    const cmds = (vName && aName && !merged) ? mergeCmd(vName, aName) : '';
    const saved = [vName, aName].filter(Boolean).map(n => '✅ 已保存：' + escapeHtml(n)).join('<br>');
    prog.insertAdjacentHTML('beforeend', `
      <div style="margin-top:10px;font-size:12px;color:#63d18b;line-height:1.7">
        ${saved}
        ${merged ? '<br><span style="color:#63d18b">🎬 已自动合并成一个带声音的 mp4：</span><br>' +
        '<b>' + escapeHtml(merged.name) + '</b>　' + fmtBytes(merged.size) +
        '<br><span style="color:#7c8288;font-size:11px">（纯 JS 重封装，音视频未重编码，直接双击播放）</span>' : ''}
        ${mergeErr ? '<br><span style="color:#ff8a8a">自动合并失败：' + escapeHtml(mergeErr) +
        ' —— 仍可用下面的命令手动合并</span>' : ''}
        ${cmds ? '<br><span style="color:#9499a0">合并成一个 mp4（视频轨不含声音）：</span><br>' +
        '<code style="display:block;background:rgba(0,0,0,.35);padding:8px 10px;border-radius:7px;' +
        'color:#c9ccd0;font-family:Consolas,monospace;font-size:11.5px;word-break:break-all;margin-top:5px">' +
        escapeHtml(cmds) + '</code>' : ''}
      </div>`);
  }

  function mergeCmd(v, a) {
    const out = v.replace(/\.mp4$/i, '_merged.mp4');
    return `ffmpeg -i "${v}" -i "${a}" -c copy -map 0:v:0 -map 1:a:0 "${out}"`;
  }

  /* ---------- 复制命令 ---------- */

  function copyText(t) {
    try {
      navigator.clipboard.writeText(t);
      ui.tip.textContent = '已复制';
      setTimeout(() => { if (ui.tip.textContent === '已复制') ui.tip.textContent = ''; }, 1800);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = t; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
      ui.tip.textContent = '已复制';
    }
  }

  function onCopyFFmpeg() {
    const v = state.selectedVideo;
    if (audioOnlyOn()) {
      copyText([
        '# 只下载音频时无需合并，m4a 可直接播放',
        '# 若要转成 mp3：ffmpeg -i "标题_audio_197kbps.m4a" -c:a libmp3lame -b:a 320k "标题.mp3"'
      ].join('\n'));
      return;
    }
    if (!v) return;
    const pages = (state.view.pages || []);
    const pageIndex = state.pageIndex || 0;
    const page = pages[pageIndex] || { duration: state.view.duration };
    const vName = fileNameFor(v, pageIndex, page, 'video');
    const aName = state.selectedAudio ? fileNameFor(state.selectedAudio, pageIndex, page, 'audio') : null;
    copyText(aName ? mergeCmd(vName, aName) : `# 只选了视频轨，无需合并\n# ${vName}`);
  }

  function onCopyAria() {
    const v = audioOnlyOn() ? null : state.selectedVideo;
    if (!v && !state.selectedAudio) return;
    const pages = (state.view.pages || []);
    const pageIndex = state.pageIndex || 0;
    const page = pages[pageIndex] || { duration: state.view.duration };
    const withAudio = audioOnlyOn() || (root.getElementById('optAudio') && root.getElementById('optAudio').checked && state.selectedAudio);
    const vName = v ? fileNameFor(v, pageIndex, page, 'video') : null;
    const aName = withAudio && state.selectedAudio ? fileNameFor(state.selectedAudio, pageIndex, page, 'audio') : null;
    const H = `--header="Referer: https://www.bilibili.com/" --header="User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0"`;
    const lines = [];
    if (v) lines.push(`aria2c ${H} -x8 -s8 -k1M -o "${vName}" "${v.baseUrl}"`);
    if (aName) lines.push(`aria2c ${H} -x8 -s8 -k1M -o "${aName}" "${state.selectedAudio.baseUrl}"`);
    lines.push('');
    lines.push('# 该直链有效期约 2 小时，过期请重新打开面板点一次「下载视频」刷新');
    copyText(lines.join('\n'));
  }

  /* ============================== 挂载 / 页面切换 ============================== */

  mountTrigger();
  let lastHref = location.href;
  setInterval(() => {
    // 1) 按钮被 B 站重新渲染冲掉就补回来
    if (!document.getElementById(TRIGGER_ID)) mountTrigger();

    // 2) SPA(pushState) 切换视频：旧数据全部作废
    if (location.href !== lastHref) {
      lastHref = location.href;
      state.view = null;
      state.playurl = null;
      state.playurlAt = 0;
      mountTrigger();
      if (host && host.style.display === 'block' && !state.job) loadVideoInfo();
      return;
    }

    // 3) 兜底：地址没变但 B 站换了数据（分P 切换）
    if (host && host.style.display === 'block' && !state.job) {
      const bv = currentBvid();
      if (bv && state.view && bv !== state.view.bvid) loadVideoInfo();
    }
  }, 900);

})();
