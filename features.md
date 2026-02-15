# Recording Bot -- Features

Complete feature reference covering meeting recording capabilities, video/audio capture, encoding options, quality presets, streaming, and configuration.

---

## Table of Contents

- [Feature Overview](#feature-overview)
- [Meeting Recording](#meeting-recording)
- [Video Capture](#video-capture)
- [Audio Capture](#audio-capture)
- [FFmpeg Video Encoding](#ffmpeg-video-encoding)
- [Video Streaming and Download](#video-streaming-and-download)
- [Quality Presets](#quality-presets)
- [Concurrency Management](#concurrency-management)
- [Max Duration Guard](#max-duration-guard)
- [Xvfb Virtual Display](#xvfb-virtual-display)
- [Security Features](#security-features)
- [Graceful Shutdown](#graceful-shutdown)
- [Configuration Reference](#configuration-reference)
- [Supported Formats](#supported-formats)

---

## Feature Overview

| Feature | Description |
|---------|-------------|
| Headless browser recording | Joins meetings as a Puppeteer bot and records the full meeting UI |
| Screenshot-based video capture | Timer-driven `page.screenshot()` at configurable FPS |
| In-browser audio mixing | Web Audio API captures and mixes all participant audio tracks |
| FFmpeg background encoding | Non-blocking conversion of frames + audio to `.webm` |
| HTTP range-request streaming | Enables video seeking and progressive playback |
| Concurrent recording support | Multiple meetings recorded simultaneously (configurable limit) |
| Auto-stop on max duration | Prevents runaway recordings with configurable time limit |
| Xvfb support | Virtual framebuffer for headful Chrome on headless Linux servers |
| API key authentication | Shared-secret auth between main server and recording bot |
| Cross-origin streaming | CORS headers for client-side video playback |
| Dynamic participant detection | Periodic scanning picks up audio from participants who join mid-meeting |
| Error recovery | Automatic recovery attempts after consecutive capture failures |

---

## Meeting Recording

The bot joins a meeting by navigating a Puppeteer-controlled Chromium browser to the meeting URL. It appears as a special recorder participant identified by URL parameters.

### How It Works

1. The main server sends a `POST /recordings/start` request with `meetingId` and `meetingUrl`
2. The bot launches a Chromium instance and navigates to the meeting with `?recorder=true&token=...`
3. The browser renders the full meeting UI including all video tiles and screen shares
4. Video frames are captured via screenshots, audio via the Web Audio API
5. On stop, the browser closes and FFmpeg encodes the final video in the background

### Bot Identification

The bot joins with these URL parameters:
- `recorder=true` -- Identifies this browser as a recording bot
- `token=<secret>` -- Authentication token matching `RECORDING_BOT_SECRET`
- `fps=<value>` -- Recording FPS hint for the meeting page
- `videoBitrate=<value>` -- Video bitrate hint
- `audioBitrate=<value>` -- Audio bitrate hint
- `chunkInterval=<value>` -- MediaRecorder chunk interval
- `codec=<value>` -- Preferred codec (vp8, vp9, or auto)

### CDP Lifecycle Control

The bot uses Chrome DevTools Protocol to set `Page.setWebLifecycleState('active')`, which prevents the browser from throttling the page when it is in the background. This is essential for consistent frame capture.

---

## Video Capture

Video is captured using timer-based screenshots rather than CDP screencast or canvas-based MediaRecorder.

### Capture Method

- `page.screenshot({ type: 'jpeg', quality: 85, fullPage: false })` called at regular intervals
- Default capture rate: 10 FPS (hardcoded in the capture loop)
- Frame format: JPEG at 85% quality
- Resolution: 1920x1080 (configured via viewport)
- Frames saved sequentially: `frame_000000.jpg`, `frame_000001.jpg`, etc.

### Reliability Features

- **Lock-based capture**: An `isCapturing` flag prevents overlapping async screenshot calls
- **Gap-free numbering**: Frame counter only increments on successful saves, ensuring no gaps in the sequence
- **Consecutive error tracking**: Counts sequential failures and logs escalating warnings
- **Auto-recovery**: After 10 consecutive capture failures, attempts `page.bringToFront()` to recover
- **Critical warning**: After 50 consecutive failures, logs a critical warning about unresponsive browser
- **Frame verification**: Each saved frame is verified with `fs.existsSync()` after write
- **Progress logging**: Every 10 frames (1 second at 10fps), logs frame count and verifies earlier frames still exist

---

## Audio Capture

Audio is captured entirely inside the browser using the Web Audio API, ensuring all meeting audio is mixed into a single stream.

### Audio Sources

The bot discovers audio tracks from two sources:

1. **mediasoup consumers** (`window.meetApp.consumers` Map) -- Primary source. Iterates all consumers, filters by `kind === 'audio'`, checks `track.readyState === 'live'`
2. **DOM audio elements** (`<audio data-producer-id>` elements) -- Fallback source. Checks `srcObject` for live audio tracks

### Mixing Pipeline

All discovered audio tracks are connected to a shared `MediaStreamDestination` node via `createMediaStreamSource()`. This provides automatic mixing of all participant audio.

### MediaRecorder Configuration

- MIME type: `audio/webm;codecs=opus`
- Audio bitrate: 128,000 bps
- Chunk interval: 1 second (`start(1000)`)
- Output: Accumulated `Blob` chunks converted to base64 on stop

### Dynamic Participant Detection

A scan interval runs every 1 second to discover new audio tracks from participants who join after recording started. The `connectedSources` Set prevents duplicate connections.

### Audio Data Extraction

On recording stop:
1. `MediaRecorder.stop()` is called
2. All chunks are assembled into a single `Blob`
3. `FileReader.readAsDataURL()` converts to base64
4. Base64 data is returned to Node.js via `page.evaluate()`
5. Decoded and saved as `audio.webm` in the frames directory

---

## FFmpeg Video Encoding

After capture ends, FFmpeg combines the JPEG frame sequence and audio file into a final `.webm` video.

### Encoding Modes

| Mode | Condition | Strategy |
|------|-----------|----------|
| Video only | No audio captured | JPEG sequence to VP8 WebM |
| Video + Audio (equal/video longer) | Video duration >= audio duration | Pad audio with silence (`apad` filter) |
| Video + Audio (audio longer) | Audio duration > video duration | Loop last frame to extend video, then concatenate |

### Codec and Format

- Video codec: `libvpx` (VP8)
- Audio codec: `libvorbis` (Vorbis)
- Container: WebM
- Video bitrate: 4 Mbps (`-b:v 4M`)
- Audio bitrate: 128 kbps (`-b:a 128k`)
- Pixel format: `yuv420p`

### Background Processing

Encoding runs as a background child process (`spawn`) so the API can respond immediately with `status: 'processing'`. Progress is logged every 30 seconds. After completion, the temporary frames directory is automatically cleaned up.

### Duration Mismatch Handling

The bot probes audio duration using `ffprobe` before encoding. If audio is longer than video:
- Extra duration is calculated: `audioDuration - videoDuration`
- The last captured frame is looped for the extra duration
- Both segments are concatenated using FFmpeg's `concat` filter

---

## Video Streaming and Download

### HTTP Range-Request Streaming

The `/recordings/:filename/stream` endpoint supports progressive video playback:

- Parses `Range` header for byte-range requests
- Returns `206 Partial Content` with `Content-Range` header for seeks
- Returns `200 OK` with full file for initial load
- `Accept-Ranges: bytes` header enables client-side seeking
- `Content-Type: video/webm`
- CORS headers: `Access-Control-Allow-Origin: *`

### Security

- Only `.webm` files can be streamed
- Directory traversal is prevented (rejects `..`, `/`, `\` in filenames)
- Filenames are URL-decoded before validation

### Download

Two download methods:
1. **By filename** (authenticated): `/recordings/:filename/download` with X-API-Key
2. **By recording ID** (public): `/recordings/:recordingId/download` -- Looks up filename via `index.json` or pattern matching

### File Listing

`GET /recordings/files` (authenticated) returns all `.webm` files with size and creation timestamp.

---

## Quality Presets

### High Quality (1080p 60fps)

```env
RECORDING_FPS=60
RECORDING_VIDEO_BITRATE=8000000
RECORDING_AUDIO_BITRATE=192000
RECORDING_CODEC=vp9
```

Expected storage: ~1 GB per hour.

### Medium Quality (1080p 30fps) -- Recommended

```env
RECORDING_FPS=30
RECORDING_VIDEO_BITRATE=4000000
RECORDING_AUDIO_BITRATE=128000
RECORDING_CODEC=vp9
```

Expected storage: ~500 MB per hour.

### Low Quality (720p 30fps)

```env
RECORDING_FPS=30
RECORDING_VIDEO_BITRATE=2000000
RECORDING_AUDIO_BITRATE=96000
RECORDING_CODEC=vp8
```

Expected storage: ~250 MB per hour.

### Minimal (Meeting-Optimized)

```env
RECORDING_FPS=20
RECORDING_VIDEO_BITRATE=1000000
RECORDING_AUDIO_BITRATE=64000
RECORDING_CODEC=vp8
```

Expected storage: ~125 MB per hour. Good for bandwidth-constrained environments.

---

## Concurrency Management

- **Max concurrent recordings**: Configurable via `MAX_CONCURRENT_RECORDINGS` (default: 5)
- **Duplicate prevention**: Only one recording per `meetingId` at a time
- **Resource tracking**: `activeBots` Map stores all running bot instances
- **Status queries**: API endpoints expose per-meeting and global recording status
- **Memory guidance**: Each Chromium instance uses ~300-500 MB RAM; plan accordingly

---

## Max Duration Guard

Recordings automatically stop after a configurable time limit to prevent runaway recordings.

- Default: 30 minutes (`MAX_RECORDING_DURATION`)
- Configured in minutes via environment variable
- Implemented as `setTimeout` that calls `stopRecording(meetingId)`
- Timeout is cleared if recording is stopped manually before limit
- The README suggests values up to 60 minutes

---

## Xvfb Virtual Display

On Linux servers without a physical display, Xvfb provides a virtual X11 framebuffer.

### Why Xvfb Is Required

Headless Chrome cannot reliably capture video streams from WebRTC pages. Running Chrome in headful mode inside a virtual framebuffer provides:
- Full GPU/WebGL rendering support
- Proper CSS animations and transitions
- Reliable `page.screenshot()` capture
- Accurate media playback

### Detection

`config.js` auto-detects Xvfb by checking if `process.env.DISPLAY` is set. When detected:
- `headless` is set to `false` (headful mode)
- Browser args include `--enable-gpu` and `--use-gl=desktop`

### Virtual Display Configuration

- Resolution: 1920x1080 (24-bit color)
- Auto server number selection (`--auto-servernum`)
- Access control disabled (`-ac`)

---

## Security Features

| Feature | Implementation |
|---------|----------------|
| API key authentication | `X-API-Key` header validated against `RECORDING_BOT_SECRET` |
| Shared secret with main server | Same secret used for API auth and bot identification |
| File access restriction | Only `.webm` files served; directory traversal blocked |
| HTTPS support | `--ignore-certificate-errors` for self-signed certs; production should use valid certs |
| Non-root execution | Recommended to run as `www-data` or similar restricted user |
| Firewall recommendation | Port 4000 should be restricted to main server access only |

---

## Graceful Shutdown

On `SIGINT` or `SIGTERM`:
1. All active recordings are stopped via `botManager.stopAll()`
2. Each recording goes through the normal stop flow (capture stop, audio extraction, browser close)
3. FFmpeg encoding may continue in background after process exits
4. Process exits with code 0

---

## Configuration Reference

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RECORDING_BOT_PORT` | `4000` | Express server listen port |
| `RECORDING_BOT_SECRET` | `recording-bot-secret-key-change-in-production` | Shared API secret |
| `RECORDINGS_DIR` | `./recordings` | Directory for saved recordings |
| `MAX_CONCURRENT_RECORDINGS` | `5` | Maximum simultaneous recordings |
| `MAX_RECORDING_DURATION` | `30` | Max recording length in minutes |
| `MAIN_SERVER_URL` | `https://localhost:3200` | Main CodeShare server URL |
| `RECORDING_BOT_HEADLESS` | `true` (auto-detected) | Set to `false` for headful mode |
| `RECORDING_FPS` | `60` | FPS hint passed to meeting page |
| `RECORDING_VIDEO_BITRATE` | `8000000` | Video bitrate in bps (8 Mbps default) |
| `RECORDING_AUDIO_BITRATE` | `192000` | Audio bitrate in bps (192 kbps default) |
| `RECORDING_CHUNK_INTERVAL` | `100` | MediaRecorder chunk interval in ms |
| `RECORDING_CODEC` | `vp9` | Codec hint: `vp9`, `vp8`, or `auto` |
| `FFMPEG_PATH` | `ffmpeg` | Custom path to FFmpeg binary |
| `RECORD_MEETINGS` | `true` | Set to `false` to disable recording |
| `USE_XVFB` | auto-detected | Force Xvfb mode |

### Hardcoded Settings

| Setting | Value | Location |
|---------|-------|----------|
| Screenshot capture FPS | 10 | `bot-manager.js` |
| Screenshot quality | 85% JPEG | `bot-manager.js` |
| Viewport resolution | 1920x1080 | `config.js` |
| Page load timeout | 30,000 ms | `config.js` |
| Join timeout (#videoGrid) | 15,000 ms | `config.js` |
| CDP protocol timeout | 60,000 ms | `config.js` |
| FFmpeg video bitrate | 4 Mbps (libvpx) | `bot-manager.js` |
| FFmpeg audio bitrate | 128 kbps (libvorbis) | `bot-manager.js` |
| Audio scan interval | 1,000 ms | `bot-manager.js` |
| Stabilization delay | 3,000 ms | `bot-manager.js` |

---

## Supported Formats

### Output

| Format | Codec | Container | Use Case |
|--------|-------|-----------|----------|
| WebM (VP8 + Vorbis) | `libvpx` + `libvorbis` | `.webm` | Default output, broad browser support |

### Intermediate

| Format | Description |
|--------|-------------|
| JPEG frames | `frame_NNNNNN.jpg` at 85% quality, 1920x1080 |
| WebM audio | `audio.webm` with Opus codec, captured in-browser |

### Codec Hints (Passed to Meeting Page)

| Codec | Description |
|-------|-------------|
| `vp9` | Higher quality at same bitrate, higher CPU usage |
| `vp8` | Lower CPU usage, good compatibility |
| `auto` | Let the browser choose the best available codec |

### Browser Requirements

- Chromium (bundled with Puppeteer) or Chrome
- Web Audio API support
- MediaRecorder API support
- WebRTC support (for connecting to mediasoup SFU)
