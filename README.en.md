# bili-video-downloader

[中文说明](README.md) · **English**

A Tampermonkey userscript that puts a **Download** button right next to Bilibili's share button. It enumerates every DASH stream the video actually offers (resolution / frame rate / bitrate / codec), lets you pick one, downloads it with multi-threaded HTTP range requests straight to disk, and **remuxes the video and audio tracks into a single playable MP4 in the browser** — no ffmpeg, no ffmpeg.wasm.

**Current version v1.1.1** · [Release history](https://github.com/mdy114514mdy/bili-video-downloader/releases) · one-line install URL is in [Install](#install).

---

## Features

- **Full enumeration** — one `fnval=4048` request asks for everything: DASH + HDR + 4K + Dolby Audio + Dolby Vision + 8K + AV1. Every row in the list is a real CDN stream, labelled with `quality / codec / WIDTHxHEIGHT / fps / bitrate / estimated size`.
- **All three codecs side by side** — AVC, HEVC and AV1 for the same quality are listed as separate rows. AVC has the widest compatibility, HEVC is smaller at equal quality, AV1 saves the most bandwidth.
- **Multi-part videos** — a dropdown appears for multi-P videos; switching re-probes immediately.
- **Streaming writes to disk** — 4 MB HTTP `Range` chunks × 4 threads, written in chunk order through `FileSystemWritableFileStream`, with back-pressure at 6 pending chunks. Memory stays flat (~24 MB) even for a 466 MB 8K file.
- **Audio-only mode** — skip the video track entirely and get a single `.m4a` (handy for ripping BGM).
- **Automatic merge** — a pure-JS fMP4 remuxer inside the script (~150 lines) joins the two tracks into one file with sound. No re-encoding, no external binary, no 30 MB wasm payload.
- **Only one file left behind** — the intermediate video/audio tracks are deleted after a successful merge.
- **Three-tier button mounting** — detail-page toolbar → player control bar → floating button in the corner.

## Install

**① Install [Tampermonkey](https://www.tampermonkey.net/) first** (without it, opening the URL below just shows the source).

**② Click this URL to install** — Tampermonkey takes over and opens its install page:

https://raw.githubusercontent.com/mdy114514mdy/bili-video-downloader/main/bili-dl.user.js

Copy-paste friendly (identical to the line above):

`https://raw.githubusercontent.com/mdy114514mdy/bili-video-downloader/main/bili-dl.user.js`

Prefer a release attachment (same `bili-dl.user.js` file):

https://github.com/mdy114514mdy/bili-video-downloader/releases/latest

**③ Open any `https://www.bilibili.com/video/BV...` page** — a **⬇ Download** button appears next to the share button.

<details>
<summary>Manual install (paste the source)</summary>

Tampermonkey → *Add new script* → paste the entire `bili-dl.user.js` → Ctrl+S.

</details>

## Usage

1. Click **Download**. The panel lists all available streams within about half a second.
2. Pick a video track and an audio track. The highest quality and the highest-bitrate audio are pre-selected, so going straight to the next step is fine.
3. Options in the panel:

   | Option | Default | Meaning |
   |---|---|---|
   | Download audio too | on | Turn off to fetch the video track alone (the result has no sound) |
   | Audio only | off | Skip the video track and keep a single `.m4a` |
   | Auto-merge after download | on | Remux both tracks into one MP4 with sound, in pure JS |
   | Threads | 4 | 1 is the most reliable; 8 is fastest but gets throttled by the CDN more often |
   | Keep merged file only | on | Delete the intermediate video/audio tracks after a successful merge |

4. **Where to save**:

   | Option | Behaviour | Recommended for |
   |---|---|---|
   | **Save directly when done** (default) | Write to origin-private storage (OPFS) → merge → hand the result to the browser's download → delete the temp files. No folder picker at all | Most cases, and especially if you hit "system folder" errors |
   | Pick a folder yourself | Streaming writes via File System Access, constant memory | When you want control over the output location, or for very large files |
   | Browser default download | Assemble the whole thing into a Blob, then download | Browsers without the APIs above (Firefox / Safari) |

   > **A hard Chrome restriction with "pick a folder yourself"**: Desktop / Documents / Downloads / drive roots are **system-reserved directories and cannot be written to**; selecting one fails immediately. Create a normal subfolder first (e.g. `D:/bili`) and select that.

5. **Start the download.** Both tracks show their own progress and live speed; when they finish the script merges them automatically and **leaves exactly one playable MP4**:

   ```
   TITLE_8192x4320_HEVC_20281kbps_merged.mp4
   ```

   Double-click to play.

   Uncheck "Auto-merge" and you instead get the video track plus the audio track, along with an `ffmpeg -c copy` command in the panel (`-c copy` does not re-encode: takes seconds, zero quality loss). The video track alone also plays if you rename it to `.mp4`, it just has no sound.

### Other buttons

- **Copy ffmpeg merge command** — only needed when auto-merge is off or failed.
- **Copy aria2 command** — `aria2c -x8 -s8` with the required `Referer` header; more reliable than in-browser downloads for huge files. The direct CDN link expires in roughly 2 hours; reopen the panel to refresh it.

## How the automatic merge works

Bilibili serves DASH, so video and audio are **two independent fMP4 files**:

```
video: ftyp + moov + (moof+mdat)×N      track_id = 1
audio: ftyp + moov + (moof+mdat)×M      track_id = 2
```

Merging therefore isn't transcoding, it's **remuxing** — moving both sets of fragments into one container. Existing tools take one of three routes:

| Route | Cost |
|---|---|
| Use the **durl** endpoint (`fnval=0`), which returns an already-muxed MP4 | Quality caps at 1080p. For the 8K test video that endpoint returns `qn=80` only (2048×1080 / 48.1 MB) with `accept_quality = [80, 16]` — no 4K, 8K, HDR or high frame rate |
| Bundle **ffmpeg.wasm** | ~30 MB of wasm to download, and large files have to fit in the wasm virtual memory |
| Run a **local helper** (BBDown / yt-dlp) | Requires installing software on the machine; impossible for a pure userscript |

This project takes a fourth route: **operate on the MP4 box structure directly**.

```
1. take mvhd from the video moov, set next_track_ID = max(id)+1
2. keep the video trak; take the audio trak (rewrite its tkhd track_ID away from the video's)
3. build a two-track mvex from both trex boxes
4. new moov = mvhd + trak_v + trak_a + mvex
5. interleave every (moof+mdat) pair by its tfdt decode time and append them after the moov
```

No encoded data is touched — only a handful of 4-byte fields change and the fragments get reordered. As a result:

- merging takes milliseconds (a 9 MB pair finishes in under a second including the download)
- output size ≈ video + audio, plus ~1.3 KB of moov
- H.264, HEVC and AV1 all work, because only the `trak` boxes are moved

The browser implementation is the `FMP4` module inside the userscript (~150 lines). `tools/fmp4mux.js` is the same logic as a Node CLI for verification.

## Measured results

Test video [`BV1qM4y1w716`](https://www.bilibili.com/video/BV1qM4y1w716) (an 8K demo clip, 193 s), Premium account. The probe returned **20 video tracks + 3 audio tracks**:

| Quality | Codec | Resolution | fps | Bitrate | Size |
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

Audio: `30280` = 197 kbps (4.54 MB), `30232` = 133 kbps (3.06 MB), `30216` = 67 kbps (1.55 MB) — all AAC-LC.

> **8K has no AVC track** — H.264 tops out at 4K by specification. Playing 8K on older hardware means HEVC hardware decoding or software AV1.

Download and merge verification (4 threads × 4 MB ranges):

| Check | Result |
|---|---|
| 8K HEVC, full 466 MB | **488,674,799 bytes in 70.8 s (6.58 MB/s)**; size identical to the CDN, first and last 4 KB byte-verified |
| Chunk integrity | concatenated md5 equals a single sequential download, **byte for byte** |
| Real write path of the script | 4,716,576 bytes written, md5 identical to a full CDN download |
| Audio-only mode | exactly one `.m4a`, 4,755,777 bytes, equal to that track's `Content-Length` |
| **Automatic merge (real output)** | AV1 360p track + 197 kbps audio → `_merged.mp4`, 9,470,592 bytes; `ffprobe` reports `av1 682×360` + `aac 48 kHz 2ch`, duration 192.81 s, **decodes with zero errors**, frame extraction fine |
| Merge across codecs | H.264 682×360, HEVC 2048×1080 and AV1 910×480 all merged and fully decoded without errors |
| **8K full merge** | 8192×4320 HEVC 488,674,799 B + 197 kbps audio 4,755,777 B → **493,428,872 bytes**; `ffprobe` reports `hevc 8192×4320` + `aac 48 kHz`, 192.81 s, zero decode errors. The merge itself takes under a second |

## Implementation notes

**API chain**

```
x/web-interface/nav            → wbi_img / wbi_sub (signing keys) + login & Premium status
x/web-interface/view           → aid / cid / part list / duration
x/player/wbi/playurl?fnval=4048 → dash.video[] / dash.audio[]
```

`fnval` bit flags: DASH(16) + HDR(64) + 4K(128) + Dolby Audio(256) + Dolby Vision(512) + 8K(1024) + AV1(2048) = **4048**.

**wbi signing** (inlined, no dependencies)

```js
mixinKey = scramble(imgKey + subKey).slice(0, 32)
w_rid    = md5(sortedQueryString + mixinKey)
```

The `md5` implementation is written by hand inside the script (~60 lines) and was validated against the standard test vectors and cross-checked against Python's `hashlib`.

**Why `GM_xmlhttpRequest`** — `api.bilibili.com` is fetchable from the page, but the video CDNs (`*.bilivideo.com`, `*.bilivideo.cn`, `mcdn`) have inconsistent CORS headers and require a `Referer` you cannot set from `fetch`. Only a GM request gets the bytes reliably.

**Chunked download** — `Range: bytes=start-end`, 4 MB per chunk, 4 threads; chunks are written to `FileSystemWritableFileStream` strictly in index order, and new requests block once 6 chunks are pending (back-pressure), keeping memory at roughly 24 MB.

**CDN preference** — candidate URLs are ordered `upos-*` (official) → others → `mcdn / p2p`; each chunk retries up to 3 times against `backupUrl`.

> This is not a theoretical safeguard: in the 8K run the audio track's `baseUrl` landed on `xy112x82x162x39xy.mcdn.bilivideo.cn:8082`, which refused the connection outright (`WinError 10061`). Switching to `upos-sz-mirrorhwo1.bilivideo.com` downloaded 4,755,777 bytes in 0.7 s.

**Link expiry** — CDN links live for about 2 hours; if the panel has been open longer than 10 minutes, the script re-requests `playurl` before starting.

**Button mounting** — Bilibili renders the page client-side and the share button is a *nested* element (`.video-toolbar-left-item > .video-share`), so inserting after `share.nextSibling` drops the button inside the share item and it wraps onto a second line. The script first walks up to a direct child of the toolbar, inserts after it, then verifies geometry (`trigger.top > ref.bottom - 4` means it wrapped) and moves it to the end of the row if needed.

## Repository layout

```
bili-dl.user.js        the userscript itself (single file, no dependencies)
tools/probe.py         list every available stream for a BV id, plain Python
tools/fmp4mux.js       CLI version of the remuxer: node fmp4mux.js v.m4s a.m4s out.mp4
tools/smoke.js         jsdom end-to-end smoke test: inject → click → assert panel contents (19 checks)
tools/test_download.js jsdom + mocked filesystem: compare bytes the script writes against a full download
tools/test_merge.js    end-to-end: download → merge → hand the output to ffprobe
tools/test_fixes.js    regression for button placement and the OPFS save path (11 checks)
```

### Running the tests

The scripts in `tools/` expect a `cookies.txt` (Netscape format, exported from your browser) in the working directory:

```bash
npm i jsdom
python tools/probe.py BV1qM4y1w716     # list every stream
node  tools/smoke.js   BV1qM4y1w716    # end-to-end UI assertions
node  tools/test_download.js           # byte-level download verification
node  tools/test_merge.js              # download + merge + ffprobe
node  tools/test_fixes.js              # button placement + OPFS save path
```

`cookies.txt` is in `.gitignore` and never committed.

## Limitations

| Symptom | Cause / fix |
|---|---|
| Only 480p and below | Not logged in, or the account lacks that quality. The panel header shows `not logged in` / `logged in` / `premium` |
| `-352` (risk control) | Play the video for a few seconds in the page, reload, retry. Rapid repeated requests get temporarily blocked |
| `-404` / `87007` / `87008` | Video missing / Premium required / paid or "charging" exclusive |
| "This browser does not support streaming save" | Firefox or Safari; switch the save method to "Save directly when done" |
| "System folder is not allowed" | Desktop / Documents / Downloads / drive roots are Chrome system-reserved directories. Create a subfolder (e.g. `D:/bili`) and pick that |
| Download stalls at 99% | A chunk failed all 3 retries (CDN hiccup). Abort and retry, or use "Copy aria2 command" |
| Auto-merge skipped | The two tracks exceed 900 MB, so the script skips merging to avoid running out of memory. Use the `ffmpeg` command it prints |
| `_merged.mp4` has odd timing in some players | The output is a fragmented MP4. VLC / PotPlayer / Chrome / ffmpeg are all fine; a few legacy players only accept non-fragmented MP4 — run `ffmpeg -i merged.mp4 -c copy fixed.mp4` once |
| No button on bangumi / course pages | Only `/video/*` and `/list/*` are matched. Anime uses the `pgc/player` API, which is not implemented |
| 8K stutters on playback | Not a script issue: 8K HEVC needs a recent GPU decoder, and 8K AV1 is essentially software-decoded |

## License

MIT
