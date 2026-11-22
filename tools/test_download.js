/**
 * 下载路径测试：mock showDirectoryPicker + createWritable，让脚本走真实的 downloadToFile 流程，
 * 抓取它写入的字节，与直接整段下载的结果做 md5 比对（验证分块/背压/顺序写入全对）。
 */
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const { JSDOM } = require('jsdom');

const BV = 'BV1qM4y1w716';
const COOKIE = fs.readFileSync('cookies.txt', 'utf8').split(/\r?\n/)
  .filter(l => l && !l.startsWith('#') && l.split('\t').length >= 7)
  .map(l => { const p = l.split('\t'); return p[5] + '=' + p[6]; }).join('; ');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function httpGet(u, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(u);
    const req = https.request({
      hostname: url.hostname, port: url.port || 443, path: url.pathname + url.search, headers
    }, res => {
      const c = [];
      res.on('data', d => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c) }));
    });
    req.on('error', reject);
    req.end();
  });
}

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
      if (opts.responseType === 'arraybuffer') {
        r.response = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      }
      opts.onload && opts.onload(r);
    });
  });
  req.on('error', e => opts.onerror && opts.onerror(e));
  req.setTimeout(opts.timeout || 30000, () => { req.destroy(); opts.ontimeout && opts.ontimeout(); });
  req.end();
  return { abort: () => req.destroy() };
};

// ---- mock 文件系统 ----
const written = {};
let writeCalls = 0, openName = null;
w.showSaveFilePicker = async (opt) => ({
  getFileHandle: null,
  createWritable: (() => { let chunks = []; return async () => ({
    write: async (d) => { chunks.push(Buffer.from(d)); writeCalls++; },
    close: async () => { written[opt.suggestedName] = Buffer.concat(chunks); },
    abort: async () => { }
  }); })()
});

w.showDirectoryPicker = async () => ({
  getFileHandle: async (name) => {
    openName = name;
    return {
      name,
      createWritable: async () => {
        const chunks = [];
        return {
          write: async (data) => { chunks.push(Buffer.from(data)); writeCalls++; },
          close: async () => { written[name] = Buffer.concat(chunks); },
          abort: async () => { }
        };
      }
    };
  }
});

w.eval(fs.readFileSync('bili-dl.user.js', 'utf8'));

const wait = ms => new Promise(r => setTimeout(r, ms));
const md5 = b => crypto.createHash('md5').update(b).digest('hex');

(async () => {
  await wait(200);
  w.document.getElementById('bili-dl-trigger').click();
  await wait(50);
  const hostEl = w.document.getElementById('bili-dl-panel-host');
  if (!hostEl) { console.log('FAIL 面板未创建'); w.close(); process.exit(1); }
  const shadow = hostEl.shadowRoot;

  // 等列表出来
  for (let i = 0; i < 100; i++) {
    if (shadow.querySelectorAll('#vlist .item').length) break;
    await wait(150);
  }
  const items = Array.from(shadow.querySelectorAll('#vlist .item'));
  console.log('可选项 ' + items.length + ' 条，选最小的一条做实测（360P）');
  const target = items[items.length - 1];
  const label = target.textContent.replace(/\s+/g, ' ').trim();
  console.log('选中:', label);

  target.click();
  shadow.getElementById('btnGo').click();

  const t0 = Date.now();
  let done = false;
  for (let i = 0; i < 400; i++) {
    await wait(200);
    const prog = shadow.getElementById('prog');
    if (prog && /✅/.test(prog.textContent)) { done = true; break; }
    if (prog && /失败|不完整|无法获取/.test(prog.textContent)) break;
    if (Date.now() - t0 > 90000) break;
  }
  const prog = shadow.getElementById('prog');
  console.log('\n进度区文本:', (prog ? prog.textContent : '').replace(/\s+/g, ' ').slice(0, 220));
  const el = (Date.now() - t0) / 1000;

  if (!done) {
    console.log('FAIL 下载未在 90s 内完成');
    w.close(); process.exit(1);
  }
  console.log(`\n完成用时 ${el.toFixed(1)}s，write() 调用 ${writeCalls} 次，文件名: ${openName}`);

  const names = Object.keys(written);
  console.log('写入的文件:', names.map(n => n + ' (' + written[n].length + ' bytes)').join(', '));
  const got = written[names[0]];

  // 找脚本用的那个 URL（列表第一行是其 baseUrl，这里重新探测同一清晰度）
  // 直接从"最小码率视频轨"重新取一次完整数据做基准
  const signed = JSON.parse(fs.readFileSync('signed.json', 'utf8'));
  const q = Object.keys(signed).sort().map(k => encodeURIComponent(k) + '=' + encodeURIComponent(String(signed[k]).replace(/[!'()*]/g, ''))).join('&');
  const api = await httpGet('https://api.bilibili.com/x/player/wbi/playurl?' + q,
    { 'User-Agent': UA, 'Cookie': COOKIE, 'Referer': 'https://www.bilibili.com/' });
  const vids = JSON.parse(api.body.toString()).data.dash.video
    .sort((a, b) => (b.id - a.id) || (b.bandwidth - a.bandwidth));
  // 取最低画质里 bandwidtdh 最低的一条（对应列表最后一行）
  const lowest = vids[vids.length - 1];
  console.log('\n基准流:', lowest.width + 'x' + lowest.height, lowest.codecs, (lowest.bandwidth / 1000).toFixed(0) + 'kbps');
  const ref = await httpGet(lowest.baseUrl, {
    'User-Agent': UA, 'Cookie': COOKIE, 'Referer': 'https://www.bilibili.com/', 'Origin': 'https://www.bilibili.com'
  });
  console.log('基准大小:', ref.body.length, 'bytes  md5:', md5(ref.body));
  console.log('脚本写入大小:', got.length, 'bytes  md5:', md5(got));

  const same = got.length === ref.body.length && md5(got) === md5(ref.body);
  console.log(same ? '\nOK   分块下载结果与整段下载完全一致（字节级）' : '\nFAIL 内容不一致！');
  console.log('fMP4 box:', got.slice(4, 8).toString('latin1'), ' brand:', got.slice(8, 12).toString('latin1'));

  w.close();
  process.exit(same ? 0 : 1);
})().catch(e => { console.error('ERR', e); process.exit(1); });
