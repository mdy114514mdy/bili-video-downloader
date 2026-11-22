/**
 * 端到端验证「下载 → 纯 JS 自动合并」：
 * mock 文件系统（含 getFile 回读）→ 跑真实网络下载 → 抓脚本写出的 *_merged.mp4 → 交给 ffprobe 验。
 */
const fs = require('fs');
const https = require('https');
const { JSDOM } = require('jsdom');

const BV = 'BV1qM4y1w716';
const COOKIE = fs.readFileSync('cookies.txt', 'utf8').split(/\r?\n/)
  .filter(l => l && !l.startsWith('#') && l.split('\t').length >= 7)
  .map(l => { const p = l.split('\t'); return p[5] + '=' + p[6]; }).join('; ');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const dom = new JSDOM(`<!DOCTYPE html><html><body>
  <div class="video-toolbar-left">
    <div class="video-toolbar-left-item"><span>2.5万</span></div>
    <div class="video-toolbar-left-item video-share"><span>分享</span></div>
  </div></body></html>`, {
  url: `https://www.bilibili.com/video/${BV}/`,
  runScripts: 'outside-only', pretendToBeVisual: true,
});
const w = dom.window;
w.unsafeWindow = w;
if (!w.TextEncoder) w.TextEncoder = TextEncoder;
w.confirm = () => true;

w.GM_xmlhttpRequest = function (opts) {
  const url = new URL(opts.url);
  const headers = Object.assign({ 'User-Agent': UA, 'Cookie': COOKIE, 'Accept': '*/*' }, opts.headers || {});
  const req = https.request({
    hostname: url.hostname, port: url.port || 443, path: url.pathname + url.search,
    method: opts.method || 'GET', headers
  }, res => {
    const c = [];
    res.on('data', d => c.push(d));
    res.on('end', () => {
      const buf = Buffer.concat(c);
      const rh = Object.entries(res.headers).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\r\n') + '\r\n';
      const r = { status: res.statusCode, responseHeaders: rh, responseText: buf.toString('utf8') };
      if (opts.responseType === 'arraybuffer') r.response = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      opts.onload && opts.onload(r);
    });
  });
  req.on('error', e => opts.onerror && opts.onerror(e));
  req.setTimeout(opts.timeout || 30000, () => { req.destroy(); opts.ontimeout && opts.ontimeout(); });
  req.end();
  return { abort: () => req.destroy() };
};

const written = {};
w.showDirectoryPicker = async () => ({
  getFileHandle: async (name) => ({
    name,
    createWritable: async () => {
      const chunks = [];
      return {
        write: async (d) => { chunks.push(Buffer.from(d)); },
        close: async () => { written[name] = Buffer.concat(chunks); },
        abort: async () => { }
      };
    },
    getFile: async () => new w.File([written[name]], name)
  })
});

w.eval(fs.readFileSync('bili-dl.user.js', 'utf8'));
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await wait(200);
  w.document.getElementById('bili-dl-trigger').click();
  await wait(80);
  const shadow = w.document.getElementById('bili-dl-panel-host').shadowRoot;
  for (let i = 0; i < 100; i++) {
    if (shadow.querySelectorAll('#vlist .item').length) break;
    await wait(150);
  }
  const items = Array.from(shadow.querySelectorAll('#vlist .item'));
  // 选最小一条（360P）省时间；音频保持最高码率
  items[items.length - 1].click();
  const mergeBox = shadow.getElementById('optMerge');
  console.log('自动合并勾选状态:', mergeBox && mergeBox.checked);
  shadow.getElementById('btnGo').click();

  const t0 = Date.now();
  let done = false;
  for (let i = 0; i < 500; i++) {
    await wait(200);
    const txt = (shadow.getElementById('prog') || {}).textContent || '';
    if (/🎬/.test(txt)) { done = true; break; }
    if (/失败|不完整|无法获取/.test(txt)) break;
    if (Date.now() - t0 > 120000) break;
  }
  const progTxt = (shadow.getElementById('prog').textContent || '').replace(/\s+/g, ' ');
  console.log('\n进度区:', progTxt.slice(0, 300));
  console.log('用时', ((Date.now() - t0) / 1000).toFixed(1) + 's');

  const names = Object.keys(written);
  console.log('\n写出的文件:');
  for (const n of names) console.log('  ', n, written[n].length, 'bytes');

  const mergedName = names.find(n => /_merged\.mp4$/.test(n));
  if (!done || !mergedName) {
    console.log('\nFAIL 没有产出合并文件');
    w.close(); process.exit(1);
  }
  fs.writeFileSync('e2e_merged.mp4', written[mergedName]);
  console.log('\n合并文件已落盘: e2e_merged.mp4', fs.statSync('e2e_merged.mp4').size, 'bytes');
  w.close();
  process.exit(0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
