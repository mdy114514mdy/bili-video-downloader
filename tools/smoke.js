/**
 * 冒烟测试：jsdom 模拟 B 站详情页 DOM → 注入用户脚本 → 点按钮 → 检查弹窗里探测出的清晰度列表
 * GM_xmlhttpRequest 用 Node https 真实请求（带用户 cookie），所以这是一次端到端验证。
 */
const fs = require('fs');
const https = require('https');
const { JSDOM } = require('jsdom');

const BV = process.argv[2] || 'BV1qM4y1w716';
const COOKIE = fs.readFileSync('cookies.txt', 'utf8').split(/\r?\n/)
  .filter(l => l && !l.startsWith('#') && l.split('\t').length >= 7)
  .map(l => { const p = l.split('\t'); return p[5] + '=' + p[6]; }).join('; ');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const dom = new JSDOM(`<!DOCTYPE html><html><head><title>t</title></head><body>
  <div id="app">
    <div class="video-info-container">
      <div class="video-toolbar-left">
        <div class="video-toolbar-left-item"><span>2.5万</span></div>
        <div class="video-toolbar-left-item"><span>6588</span></div>
        <div class="video-toolbar-left-item"><span>1.2万</span></div>
        <div class="video-toolbar-left-item video-share"><span>分享</span></div>
      </div>
    </div>
    <div class="bpx-player-control-bottom"><div class="bpx-player-control-bottom-right"></div></div>
  </div></body></html>`, {
  url: `https://www.bilibili.com/video/${BV}/`,
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});

const w = dom.window;
w.unsafeWindow = w;
if (!w.TextEncoder) w.TextEncoder = TextEncoder;
w.confirm = () => true;

// ---- mock GM_xmlhttpRequest（真实网络） ----
w.GM_xmlhttpRequest = function (opts) {
  const u = new URL(opts.url);
  const headers = Object.assign({
    'User-Agent': UA, 'Cookie': COOKIE, 'Accept': '*/*'
  }, opts.headers || {});
  const req = https.request({
    hostname: u.hostname, port: u.port || 443,
    path: u.pathname + u.search, method: opts.method || 'GET', headers
  }, res => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => {
      const buf = Buffer.concat(chunks);
      const rh = Object.entries(res.headers)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\r\n') + '\r\n';
      const r = {
        status: res.statusCode,
        responseHeaders: rh,
        responseText: buf.toString('utf8'),
      };
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

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  OK   ' + label + (extra ? '  → ' + extra : '')); }
  else { fail++; console.log('  FAIL ' + label + (extra ? '  → ' + extra : '')); }
};

// ---- 注入用户脚本 ----
const code = fs.readFileSync('bili-dl.user.js', 'utf8');
try {
  w.eval(code);
  console.log('[1] 脚本注入成功');
} catch (e) {
  console.error('[1] 脚本注入抛错:', e);
  process.exit(1);
}

setTimeout(async () => {
  const doc = w.document;
  const trigger = doc.getElementById('bili-dl-trigger');
  console.log('\n[2] 触发按钮');
  ok(!!trigger, '按钮已插入 DOM');
  if (!trigger) process.exit(1);
  ok(trigger.dataset.place === 'toolbar', '挂载位置 = 详情页工具栏', trigger.dataset.place);
  const share = doc.querySelector('.video-share');
  ok(share.nextElementSibling === trigger, '位置在「分享」按钮右侧');
  ok(/下载视频/.test(trigger.textContent), '按钮文案', trigger.textContent.trim());

  console.log('\n[3] 点击 → 弹窗 + 真实 API 探测');
  trigger.click();

  const t0 = Date.now();
  const hostEl = doc.getElementById('bili-dl-panel-host');
  ok(!!hostEl, '面板 host 已创建');
  const shadow = hostEl.shadowRoot;

  // 轮询等待列表渲染
  await new Promise(resolve => {
    const tick = () => {
      const items = shadow.querySelectorAll('.item');
      if (items.length > 0 || Date.now() - t0 > 20000) return resolve();
      setTimeout(tick, 150);
    };
    tick();
  });
  const ms = Date.now() - t0;
  ok(ms < 20000, 'API 探测在超时内完成', ms + 'ms');

  const vItems = shadow.querySelectorAll('#vlist .item');
  const aItems = shadow.querySelectorAll('#alist .item');
  console.log('\n[4] 解析结果');
  ok(vItems.length > 0, '视频轨数量', vItems.length + ' 条');
  ok(aItems.length > 0, '音频轨数量', aItems.length + ' 条');

  const firstRow = vItems[0] ? vItems[0].textContent.replace(/\s+/g, ' ').trim() : '';
  console.log('      首行:', firstRow);
  ok(/8192×4320/.test(firstRow) || /8K/.test(firstRow), '最高画质识别为 8K');
  ok(/HEVC|AVC|AV1/.test(firstRow), '编码家族已标注');
  ok(/kbps/.test(firstRow), '码率已标注');
  ok(/fps/.test(firstRow), '帧率已标注');

  const onRow = shadow.querySelector('#vlist .item.on');
  ok(!!onRow, '默认选中最高画质');
  ok(onRow && onRow === vItems[0], '默认选中项 = 列表第一行（最高画质）');

  const aOn = shadow.querySelector('#alist .item.on');
  ok(!!aOn, '默认选中最高码率音频');

  const go = shadow.getElementById('btnGo');
  ok(go && !go.disabled, '开始下载按钮可用');

  // 输出全部行，便于人工核对
  console.log('\n[5] 弹窗里的完整列表');
  vItems.forEach((it, i) => {
    console.log('   V' + String(i + 1).padStart(2) + ': ' + it.textContent.replace(/\s+/g, ' ').trim());
  });
  aItems.forEach((it, i) => {
    console.log('   A' + String(i + 1).padStart(2) + ': ' + it.textContent.replace(/\s+/g, ' ').trim());
  });

  // 复制 ffmpeg 命令（走 navigator.clipboard stub）
  let copied = '';
  try {
    Object.defineProperty(w.navigator, 'clipboard', {
      value: { writeText: t => { copied = t; return Promise.resolve(); } }, configurable: true
    });
  } catch (e) { }
  shadow.getElementById('btnFf').click();
  console.log('\n[6] ffmpeg 命令');
  ok(/ffmpeg -i/.test(copied), '复制出可用的合并命令', copied.slice(0, 120));

  shadow.getElementById('btnAria').click();
  console.log('\n[7] aria2 命令');
  ok(/aria2c/.test(copied) && /Referer/.test(copied), '复制出 aria2 命令', copied.split('\n')[0].slice(0, 110));

  // 保存方式选 fs，但 jsdom 没有 showSaveFilePicker → 应该给出明确提示而不是崩
  console.log('\n[8] 无 File System API 时的降级提示');
  const optSave = shadow.getElementById('optSave');
  optSave.value = 'fs';
  shadow.getElementById('btnGo').click();
  await new Promise(r => setTimeout(r, 600));
  const prog = shadow.getElementById('prog');
  const tipText = (prog ? prog.textContent : '') + (shadow.querySelector('.foot .tip') || {}).textContent;
  ok(/不支持|默认下载|保存位置/.test(tipText), '给出明确的降级提示', tipText.replace(/\s+/g, ' ').slice(0, 90));

  console.log(`\n===== ${pass} passed, ${fail} failed =====`);
  w.close();
  process.exit(fail ? 1 : 0);
}, 250);
