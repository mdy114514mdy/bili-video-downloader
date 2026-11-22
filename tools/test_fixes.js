/**
 * 针对用户反馈的两个问题的回归测试：
 * ① 按钮必须和「分享」在同一行（分享是内层元素时不能被插到它内部）
 * ② 「下完直接存」(OPFS) 模式：不弹目录框、不碰系统目录，最终只落一个合并好的 mp4，中间文件清掉
 */
const fs = require('fs');
const https = require('https');
const { JSDOM } = require('jsdom');

const BV = 'BV1qM4y1w716';
const COOKIE = fs.readFileSync('cookies.txt', 'utf8').split(/\r?\n/)
  .filter(l => l && !l.startsWith('#') && l.split('\t').length >= 7)
  .map(l => { const p = l.split('\t'); return p[5] + '=' + p[6]; }).join('; ');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  OK   ' + label + (extra ? '  → ' + extra : '')); }
  else { fail++; console.log('  FAIL ' + label + (extra ? '  → ' + extra : '')); }
};

/* ---------- ① 按钮位置 ---------- */
{
  const dom = new JSDOM(`<!DOCTYPE html><html><body>
    <div class="video-toolbar-left">
      <div class="video-toolbar-left-item"><span>2.5万</span></div>
      <div class="video-toolbar-left-item"><span>6588</span></div>
      <div class="video-toolbar-left-item">
        <div class="video-share"><svg></svg><span>分享</span></div>
      </div>
    </div></body></html>`, {
    url: `https://www.bilibili.com/video/${BV}/`, runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window;
  w.unsafeWindow = w;
  w.confirm = () => true;
  w.GM_xmlhttpRequest = () => ({ abort() { } });
  w.eval(fs.readFileSync('bili-dl.user.js', 'utf8'));

  const bar = w.document.querySelector('.video-toolbar-left');
  const trigger = w.document.getElementById('bili-dl-trigger');
  const shareItem = w.document.querySelector('.video-share').closest('.video-toolbar-left-item');

  console.log('[1] 分享按钮是内层元素时的插入位置');
  ok(!!trigger, '按钮已插入');
  ok(trigger && trigger.parentElement === bar, '父节点是操作栏本身（不是分享的内部容器）',
    trigger && trigger.parentElement && trigger.parentElement.className);
  ok(trigger && trigger.previousElementSibling === shareItem, '紧跟在「分享」那一项之后（同一行）');
  ok(trigger && trigger.parentElement.children.length === 4, '操作栏项数 4', String(trigger && trigger.parentElement.children.length));
  w.close();
}

/* ---------- ② OPFS 模式 ---------- */
(async () => {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>
    <div class="video-toolbar-left">
      <div class="video-toolbar-left-item"><span>2.5万</span></div>
      <div class="video-toolbar-left-item"><div class="video-share"><span>分享</span></div></div>
    </div></body></html>`, {
    url: `https://www.bilibili.com/video/${BV}/`, runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window;
  w.unsafeWindow = w;
  w.confirm = () => true;
  if (!w.TextEncoder) w.TextEncoder = TextEncoder;

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

  // ---- mock OPFS ----
  const opfsFiles = {};
  const removed = [];
  const opfsDir = {
    getDirectoryHandle: async () => opfsDir,
    getFileHandle: async (name) => ({
      name,
      createWritable: async () => {
        const chunks = [];
        return {
          write: async d => { chunks.push(Buffer.from(d)); },
          close: async () => { opfsFiles[name] = Buffer.concat(chunks); },
          abort: async () => { }
        };
      },
      getFile: async () => new w.File([opfsFiles[name] || Buffer.alloc(0)], name)
    }),
    removeEntry: async (name) => { removed.push(name); delete opfsFiles[name]; }
  };
  Object.defineProperty(w.navigator, 'storage', {
    value: { getDirectory: async () => opfsDir }, configurable: true
  });

  w.URL.createObjectURL = () => 'blob:mock';
  w.URL.revokeObjectURL = () => { };

  // ---- 拦截浏览器保存 ----
  const saved = [];
  w.HTMLAnchorElement.prototype.click = function () { saved.push(this.download); };

  w.eval(fs.readFileSync('bili-dl.user.js', 'utf8'));
  const wait = ms => new Promise(r => setTimeout(r, ms));
  await wait(200);

  w.document.getElementById('bili-dl-trigger').click();
  await wait(80);
  const shadow = w.document.getElementById('bili-dl-panel-host').shadowRoot;

  console.log('\n[2] 保存方式默认值');
  for (let i = 0; i < 100; i++) {
    if (shadow.querySelectorAll('#vlist .item').length) break;
    await wait(150);
  }
  const bodyEl = shadow.querySelector('#body');
  const optSave = bodyEl ? bodyEl.querySelector('#optSave') : null;
  console.log('      debug items=' + shadow.querySelectorAll('#vlist .item').length +
    ' bodyLen=' + (bodyEl ? bodyEl.innerHTML.length : -1) +
    ' optSave=' + (optSave ? optSave.value : 'null'));
  const modeVal = optSave ? (optSave.value || (optSave.options[0] && optSave.options[0].value)) : null;
  ok(modeVal === 'opfs', '默认选中「下完直接存」', String(modeVal));

  for (let i = 0; i < 100; i++) {
    if (shadow.querySelectorAll('#vlist .item').length) break;
    await wait(150);
  }
  const items = Array.from(shadow.querySelectorAll('#vlist .item'));
  items[items.length - 1].click();   // 最小一档，省时间

  console.log('\n[3] OPFS 模式全流程');
  shadow.getElementById('btnGo').click();
  const t0 = Date.now();
  let done = false;
  for (let i = 0; i < 500; i++) {
    await wait(200);
    const txt = (shadow.getElementById('prog') || {}).textContent || '';
    if (/🎬/.test(txt)) { done = true; break; }
    if (/失败|不完整|无法获取|不允许/.test(txt)) break;
    if (Date.now() - t0 > 120000) break;
  }
  const progTxt = (shadow.getElementById('prog').textContent || '').replace(/\s+/g, ' ');
  console.log('      进度区:', progTxt.slice(0, 260));

  ok(done, '下载+合并完成');
  ok(saved.length === 1, '浏览器只收到 1 个保存请求', saved.join(' | '));
  ok(saved[0] && /_merged\.mp4$/.test(saved[0]), '保存的就是合并后的 mp4', saved[0]);
  ok(removed.length === 2, '中间两个文件已清理', removed.join(' , '));
  const left = Object.keys(opfsFiles);
  ok(left.length === 1 && /_merged\.mp4$/.test(left[0]),
    '私有存储里只剩合并结果（60s 后自动清理），中间两条轨已删', JSON.stringify(left));
  ok(!/✅ 已保存：.*_audio_/.test(progTxt), '弹窗里不再列出音频轨（已清理）');

  console.log(`\n===== ${pass} passed, ${fail} failed =====`);
  w.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
