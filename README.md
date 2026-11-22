# bili-video-downloader

在 B 站网页版视频播放页的「分享」按钮右侧，加一个 **⬇ 下载视频** 按钮。点开自动探测该视频**全部可用流**（分辨率 / 帧率 / 码率 / 编码格式），选完直接下到本地。

Tampermonkey userscript that puts a **Download** button next to Bilibili's share button, enumerates every available DASH stream (resolution / fps / bitrate / codec), and downloads the one you pick with multi-threaded HTTP range requests writing straight to disk.

---

## 特性

- **完整探测**：`fnval=4048` 一次要全 —— DASH + HDR + 4K + 杜比音频 + 杜比视界 + 8K + AV1。列表里每一行是一个真实的 CDN 流，标注 `画质 / 编码 / 宽×高 / 帧率 / 码率 / 估算大小`。
- **三编码并列**：同一画质下的 AVC / HEVC / AV1 全部列出，不会替你"选一个"——AVC 兼容最好、HEVC 同画质更小、AV1 最省流量。
- **分P 支持**：多 P 视频顶部有下拉，切换即重新探测。
- **流式写盘**：`FileSystemWritableFileStream` + 4MB Range 分块 × 4 线程，按块序号串行写入，背压 6 块 → 内存恒定，8K 几百 MB 也不会把标签页撑爆。
- **只下载音频**：勾一个框跳过视频轨，直接拿到 `.m4a`（扒 BGM 用）。
- **下载完自动合并**：纯 JS 直接重封装 fMP4，把视频轨和音频轨拼成一个**带声音的 mp4**。不重编码、不装 ffmpeg、不加载 30MB 的 wasm——合并逻辑只有几十 KB。
- **命令导出**：一键复制 `ffmpeg -c copy` 合并命令、或带 `Referer` 的 `aria2c -x8 -s8` 命令（合并失败时的兜底）。
- **三级挂载兜底**：详情页工具栏 → 播放器控制栏 → 右下角悬浮按钮。B 站改版把按钮冲掉时会自动补回。

## 安装

1. 浏览器装 [Tampermonkey](https://www.tampermonkey.net/)。
2. 打开 [`bili-dl.user.js`](bili-dl.user.js) 的 raw 地址（或点右上角 Raw），Tampermonkey 会弹安装页 → 安装。
3. 打开任意 `https://www.bilibili.com/video/BV...` 页面，「分享」右边就有 **下载视频**。

手动方式：Tampermonkey → 添加新脚本 → 粘贴全文 → Ctrl+S。

## 用法

1. 点 **下载视频**，等 0.5 秒左右弹出面板。
2. 挑视频轨 / 音频轨（默认选最高画质 + 最高码率音频）。
3. 线程选 4，保存方式选「选择保存位置」（流式）。
4. **开始下载** → 选一个文件夹（音视频两个文件一次授权）。
5. 下完点 **复制 ffmpeg 合并命令**：

```bash
ffmpeg -i "标题_8192x4320_HEVC_20281kbps.mp4" -i "标题_audio_197kbps.m4a" \
  -c copy -map 0:v:0 -map 1:a:0 "标题_8192x4320_HEVC_20281kbps_merged.mp4"
```

> **为什么必须合并**：B 站是 DASH，视频轨和音频轨是两个独立 fMP4（`ftyp/iso5`）。浏览器里没法规格化封装 MP4，所以分开下、再用 ffmpeg 无损封装（`-c copy` 不重编码，几秒完成，画质零损失）。视频轨单独改名 `.mp4` 也能播，只是没声音。

没有 ffmpeg：`winget install Gyan.FFmpeg`，或下绿色版把 `ffmpeg.exe` 加进 PATH。

### 其他

- **复制 aria2 命令**：超大文件走 aria2 比浏览器更稳。直链约 2 小时过期，过期重开面板刷新。
- **保存方式**
  - `选择保存位置（流式）`：边下边写盘，内存恒定，支持几十 GB（Chrome / Edge）。
  - `浏览器默认下载`：整段拼 Blob，大文件吃内存，只建议小视频或不支持 File System Access API 的浏览器（Firefox / Safari）。

## 自动合并是怎么做到的

B 站用的是 DASH，音视频是**两条独立的 fMP4**：

```
视频轨：ftyp + moov + (moof+mdat)×N      track_id = 1
音频轨：ftyp + moov + (moof+mdat)×M      track_id = 2
```

所以「自动合并」的关键不是转码，而是**重封装**——把两条轨的片段搬进同一个容器。市面上的做法有三类：

| 做法 | 代价 |
|---|---|
| 走 `fnval=0` 的 **durl** 接口（返回已封装的 mp4） | 画质封顶 1080P。实测 8K 视频在这个接口下只给 `qn=80`（2048×1080 / 48.1 MB），`accept_quality` 只有 `[80, 16]`，4K / 8K / HDR / 高帧率全都拿不到 |
| 内置 **ffmpeg.wasm** | 首次要下 ~30MB wasm，大文件还得整个读进 wasm 的虚拟内存 |
| 起**本地服务**（BBDown / yt-dlp） | 得在电脑上装东西，纯插件做不到 |

本项目的做法是第四类：**直接操作 MP4 的 box 结构**。

```
① 取视频 moov 的 mvhd，把 next_track_ID 改成 3
② 取视频的 trak、音频的 trak（音频 track_id 改 2）
③ 取两条轨的 trex，拼出一个含两轨的 mvex
④ 新 moov = mvhd + trak_v + trak_a + mvex
⑤ 把两边所有 (moof+mdat) 按 tfdt 解码时间排序、交错，接在 moov 后面
```

不碰任何编码数据，只改几个 4 字节字段 + 重排片段顺序，所以：

- 合并耗时在毫秒级（9MB 的文件 1 秒内完成，含下载）
- 输出体积 ≈ 视频 + 音频，一个字节都不多
- H.264 / HEVC / AV1 全都支持（只搬 trak，不看 codec 细节）

浏览器里的实现在脚本内 `FMP4` 模块，约 150 行；`tools/fmp4mux.js` 是同一套逻辑的 Node 命令行版，方便验证。

## 实测数据

测试视频 [`BV1qM4y1w716`](https://www.bilibili.com/video/BV1qM4y1w716)（8K 演示片，193s），大会员账号，探测出 **20 条视频轨 + 3 条音频轨**：

| 画质 | 编码 | 分辨率 | 帧率 | 码率 | 大小 |
|---|---|---|---|---|---|
| 8K | HEVC `hev1.1.6.L180.90` | 8192×4320 | 25 | 20281 kbps | ≈466.6 MB |
| 8K | AV1 `av01.0.16M` | 8192×4320 | 25 | 9623 kbps | ≈221.4 MB |
| 4K | AVC `avc1.640033` | 4096×2160 | 25 | 10968 kbps | ≈252.3 MB |
| 4K | AV1 | 4096×2160 | 25 | 5113 kbps | ≈117.6 MB |
| 4K | HEVC | 4096×2160 | 25 | 4891 kbps | ≈112.5 MB |
| 1080P+ | AVC / AV1 / HEVC | 2048×1080 | 25 | 4850 / 1451 / 1400 kbps | 111.6 / 33.4 / 32.2 MB |
| 1080P | AVC / HEVC / AV1 | 2048×1080 | 25 | 1664 / 902 / 862 kbps | 38.3 / 20.7 / 19.8 MB |
| 720P | AVC / AV1 / HEVC | 1364×720 | 25 | 1114 / 718 / 384 kbps | 25.6 / 16.5 / 8.8 MB |
| 480P | AVC / AV1 / HEVC | 910×480 | 25 | 505 / 359 / 226 kbps | 11.6 / 8.3 / 5.2 MB |
| 360P | HEVC / AVC / AV1 | 682×360 | 25 | 306 / 225 / 195 kbps | 7.0 / 5.2 / 4.5 MB |

音频：`30280` = 197 kbps (4.54 MB)、`30232` = 133 kbps (3.06 MB)、`30216` = 67 kbps (1.55 MB)，均为 AAC-LC。

> **8K 没有 AVC 档** —— H.264 规范上限就是 4K。老设备想播 8K 只能靠 HEVC 硬解或 AV1 软解。

下载实测（4 线程 × 4MB Range）：

| 项 | 结果 |
|---|---|
| 8K HEVC 全量 466 MB | **488,674,799 字节 / 70.8 秒 / 6.58 MB/s**，大小与 CDN 完全一致，首尾 4KB 逐字节比对通过 |
| 分块完整性 | 拼接 md5 与整段顺序下载 **字节级一致** |
| 脚本真实写盘路径 | 写入 4,716,576 字节，与 CDN 整段下载 **md5 一致** |
| 只下载音频 | 只产出 1 个 `.m4a`，4,755,777 字节，等于该音频轨 Content-Length |
| **自动合并（脚本真实产出）** | 360P AV1 轨 + 197kbps 音频 → `_merged.mp4` 9,470,592 字节；ffprobe 认出 `av1 682×360` + `aac 48kHz 2ch`，时长 192.81s，**全解码零错误**，抽帧正常 |
| 合并兼容性（三种编码） | H.264 682×360、HEVC 2048×1080、AV1 910×480 三条轨分别与音频合并，ffprobe 与全解码均通过 |
| **8K 全量合并** | 8192×4320 HEVC 488,674,799 B + 197kbps 音频 4,755,777 B → `_merged.mp4` **493,428,872 字节**（视频+音频+1.3KB moov）；ffprobe 认出 `hevc 8192×4320` + `aac 48kHz`，时长 192.81s，解码零错误。拼接本身不到 1 秒 |

## 实现要点

**接口链**

```
x/web-interface/nav          → wbi_img / wbi_sub（签名密钥）+ 登录态、大会员状态
x/web-interface/view         → aid / cid / 分P 列表 / 时长
x/player/wbi/playurl?fnval=4048 → dash.video[] / dash.audio[]
```

`fnval` 位标志：DASH(16) + HDR(64) + 4K(128) + 杜比音频(256) + 杜比视界(512) + 8K(1024) + AV1(2048) = **4048**。

**wbi 签名**（脚本内联，无外部依赖）

```js
mixinKey = 混淆表重排(imgKey + subKey).slice(0, 32)
w_rid    = md5(字典序拼接的 query + mixinKey)
```

`md5` 是脚本内手写的实现（约 60 行），已用标准测试向量 + 与 Python `hashlib` 交叉复算验证。

**为什么用 `GM_xmlhttpRequest`**：`api.bilibili.com` 同源可 fetch，但 CDN（`*.bilivideo.com` / `*.bilivideo.cn` / `mcdn`）的 CORS 头不稳定，且需要自己塞 `Referer` —— GM 请求才拿得稳。

**分块下载**：`Range: bytes=start-end`，4MB/块、4 线程；按块序号**串行写入** `FileSystemWritableFileStream`，未落盘块超过 6 个就阻塞新请求（背压），内存占用恒定在 ~24MB。

**CDN 优选**：候选 URL 按 `upos-*`（官方源）→ 其他 → `mcdn / p2p` 排序；每块失败自动换 `backupUrl`，重试 3 次。
> 实测这条不是纸上保险：8K 测试里音频轨的 `baseUrl` 恰好落在 `xy112x82x162x39xy.mcdn.bilivideo.cn:8082`，直连直接被拒（`WinError 10061`），换成 `upos-sz-mirrorhwo1.bilivideo.com` 后 0.7 秒下完。

**直链过期**：面板开着超过 10 分钟，点下载时会自动重取一次 `playurl` 换新链接。

## 仓库结构

```
bili-dl.user.js       用户脚本本体（单文件，1141 行，无外部依赖）
tools/probe.py        只用 Python 列出某个 BV 的全部可用流（不需要装脚本）
tools/smoke.js        jsdom 端到端冒烟：注入脚本 → 点按钮 → 断言弹窗内容（19 项）
tools/test_download.js jsdom + mock 文件系统：抓脚本真实写入的字节，与整段下载比 md5
tools/test_merge.js   端到端：下载 → 自动合并 → 抓出 _merged.mp4 交给 ffprobe 验
tools/fmp4mux.js      fMP4 拼接的命令行版（node fmp4mux.js v.m4s a.m4s out.mp4）
```

### 自测

`tools/` 下的脚本需要 `cookies.txt`（Netscape 格式，浏览器导出）放在**运行目录**：

```bash
npm i jsdom                       # 只有两个 js 测试需要
python tools/probe.py BV1qM4y1w716   # 列出全部流
node  tools/smoke.js   BV1qM4y1w716  # 端到端 UI 断言
node  tools/test_download.js         # 字节级下载验证
```

`cookies.txt` 已在 `.gitignore` 里，不会被提交。

## 限制

| 现象 | 原因 / 处理 |
|---|---|
| 只有 480P 及以下 | 未登录，或账号没有该清晰度权限。标题栏会显示 `未登录` / `已登录` / `大会员` |
| `-352` 触发风控 | 先在网页上正常播放几秒，刷新再试；频繁请求会被临时限制 |
| `-404` / `87007` / `87008` | 视频不存在 / 需要大会员 / 需要付费充电 |
| 提示不支持流式保存 | 用的是 Firefox/Safari，把保存方式改成「浏览器默认下载」 |
| 下载卡在 99% | 某块重试 3 次仍失败（CDN 抖动）。中断重下，或改用「复制 aria2 命令」 |
| 番剧 / 课程页没按钮 | 只匹配 `/video/*` 与 `/list/*`；番剧走 `pgc/player` 另一套接口，未实现 |
| 8K 播放卡顿 | 不是脚本问题。8K HEVC 要较新 GPU 硬解，AV1 8K 基本靠软解 |
| 自动合并被跳过 | 两条轨合计超过 900MB 时主动跳过（要读回内存）。用弹窗给的 ffmpeg 命令合并 |
| `_merged.mp4` 在某些播放器里时间轴怪 | 输出是 fragmented MP4。VLC / PotPlayer / Chrome / ffmpeg 都正常；个别老播放器只认非分片 mp4，用它看原始 `.mp4` + `.m4a` 或跑一次 `ffmpeg -i merged.mp4 -c copy fixed.mp4` |

## License

MIT
