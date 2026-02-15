# Recording Bot -- Architecture

System architecture covering the headless browser recording design, Puppeteer-based capture pipeline, FFmpeg video encoding, audio mixing, file storage, and integration with the main CodeShare Meet server.

---

## Table of Contents

- [High-Level Design](#high-level-design)
- [System Architecture Diagram](#system-architecture-diagram)
- [Recording Pipeline](#recording-pipeline)
- [Video Capture (Screenshot Timer)](#video-capture-screenshot-timer)
- [Audio Capture (Browser MediaRecorder)](#audio-capture-browser-mediarecorder)
- [FFmpeg Encoding Pipeline](#ffmpeg-encoding-pipeline)
- [Main Server Integration](#main-server-integration)
- [Xvfb Virtual Framebuffer](#xvfb-virtual-framebuffer)
- [Concurrency and Lifecycle](#concurrency-and-lifecycle)
- [File Storage and Streaming](#file-storage-and-streaming)
- [File Map](#file-map)

---

## High-Level Design

The Recording Bot is a standalone Node.js service that records CodeShare Meet sessions by joining meetings as a bot participant. Instead of tapping into mediasoup RTP transports directly (as the transcription bridge does), it launches a full Puppeteer-controlled Chromium browser that navigates to the meeting URL, renders the meeting UI, and captures both video frames and audio from inside the browser.

This approach has a key advantage: the bot records exactly what a participant sees -- all video tiles, screen shares, UI overlays, and mixed audio -- without needing to reconstruct the meeting layout server-side.

```
Main Server (Port 3200)          Recording Bot (Port 4000)
 +------------------------+       +----------------------------+
 | Meeting hosting         | API  | Express API server          |
 | WebSocket/SFU (mediasoup)|<--->| BotManager                  |
 | Recording API triggers  |      |   +-- Puppeteer browser #1  |
 |                         |      |   +-- Puppeteer browser #2  |
 |                         |      |   +-- ... (up to N)         |
 +------------------------+       +----------------------------+
                                         |
                                         v
                                  +----------------+
                                  | FFmpeg          |
                                  | frames + audio  |
                                  | --> .webm file  |
                                  +----------------+
                                         |
                                         v
                                  +----------------+
                                  | recordings/     |
                                  | .webm files     |
                                  +----------------+
```

### Why a Headless Browser Approach?

| Aspect | Headless Browser (this service) | Direct RTP Capture |
|--------|--------------------------------|--------------------|
| Captures full meeting UI | Yes (video grid, names, screen share) | No (raw per-track streams) |
| Layout compositing | Automatic (browser renders it) | Requires server-side compositing |
| Audio mixing | Automatic (browser mixes all tracks) | Requires FFmpeg amix filter |
| Resource usage | Higher (full Chromium per recording) | Lower (no browser) |
| Quality control | Screenshot-based (configurable FPS) | Native RTP quality |
| Implementation complexity | Moderate (Puppeteer + FFmpeg) | High (SDP, PlainTransport, compositing) |

---

## System Architecture Diagram

```
+--------------------------------------------------------------------------+
|  RECORDING BOT SERVICE (Node.js, Port 4000)                               |
|                                                                            |
|  +-------------------------------------------------------------------+   |
|  | server.js -- Express API Server                                    |   |
|  |                                                                    |   |
|  |  POST /recordings/start    --> authenticate --> botManager.start   |   |
|  |  POST /recordings/:id/stop --> authenticate --> botManager.stop    |   |
|  |  GET  /recordings/:id/status                                      |   |
|  |  GET  /recordings                                                 |   |
|  |  GET  /recordings/files                                           |   |
|  |  GET  /recordings/:filename/stream   (public, range requests)     |   |
|  |  GET  /recordings/:filename/download                              |   |
|  |  GET  /health                                                     |   |
|  +---------------------------+---------------------------------------+   |
|                              |                                           |
|                              v                                           |
|  +-------------------------------------------------------------------+   |
|  | bot-manager.js -- BotManager Class                                 |   |
|  |                                                                    |   |
|  |  activeBots: Map<meetingId, BotInstance>                           |   |
|  |                                                                    |   |
|  |  BotInstance {                                                     |   |
|  |    browser       -- Puppeteer Browser                              |   |
|  |    page          -- Puppeteer Page                                 |   |
|  |    client        -- CDP Session                                    |   |
|  |    status        -- 'recording' | 'stopping'                      |   |
|  |    startedAt     -- timestamp                                      |   |
|  |    framesDir     -- temp directory for JPEG frames                 |   |
|  |    captureInterval -- setInterval handle                           |   |
|  |    stopCapture() -- stops frame capture loop                       |   |
|  |    frameCount()  -- returns current frame count                    |   |
|  |    fps           -- capture framerate (default 10)                 |   |
|  |  }                                                                 |   |
|  |                                                                    |   |
|  |  startRecording(meetingId, meetingUrl, token)                      |   |
|  |  stopRecording(meetingId)                                          |   |
|  |  framesToVideoBackground(framesDir, outputPath, fps, audio, count) |   |
|  |  getStatus(meetingId)                                              |   |
|  |  getAllActive()                                                    |   |
|  |  stopAll()                                                         |   |
|  +-------------------------------------------------------------------+   |
|                              |                                           |
|                              v                                           |
|  +-------------------------------------------------------------------+   |
|  | config.js -- Configuration Loader                                  |   |
|  |                                                                    |   |
|  |  port, apiSecret, recordingsDir, maxConcurrentRecordings,          |   |
|  |  maxRecordingDuration, headless, useXvfb, browserArgs,             |   |
|  |  viewport (1920x1080), recordingQuality { fps, videoBitrate,       |   |
|  |  audioBitrate, chunkInterval, codec }, ffmpegPath, timeouts        |   |
|  +-------------------------------------------------------------------+   |
|                                                                            |
+--------------------------------------------------------------------------+
```

---

## Recording Pipeline

The full recording lifecycle from start to final `.webm` file:

```
Step 1: API Request
  Main server sends POST /recordings/start { meetingId, meetingUrl }
  --> authenticate via X-API-Key header
  --> check concurrent recording limit
  --> pass to BotManager.startRecording()

Step 2: Launch Puppeteer Browser
  puppeteer.launch({
    headless: false (under Xvfb) or 'new' (pure headless),
    args: [--no-sandbox, --use-fake-ui-for-media-stream, ...]
  })
  --> Set viewport to 1920x1080
  --> Override media permissions (microphone, camera, notifications)

Step 3: Navigate to Meeting
  Construct URL: meetingUrl?recorder=true&token=...&fps=...&codec=...
  --> page.goto(url, { waitUntil: 'networkidle2' })
  --> Create CDP session for lifecycle control
  --> Set Page.setWebLifecycleState('active') to prevent throttling
  --> Wait for #videoGrid selector (meeting loaded)
  --> 3-second stabilization delay

Step 4: Start Video Capture (Timer-Based Screenshots)
  Create temporary frames directory: recordings/frames_{meetingId}_{timestamp}/
  setInterval(captureFrame, 1000/fps)  // default 10fps
  Each frame: page.screenshot({ type: 'jpeg', quality: 85 })
  --> Save as frame_NNNNNN.jpg (zero-padded 6 digits)
  --> Lock-based capture prevents overlapping async screenshots
  --> Consecutive error tracking with recovery (bringToFront after 10 failures)

Step 5: Start Audio Capture (In-Browser MediaRecorder)
  page.evaluate() injects JavaScript into the meeting page:
  --> Creates AudioContext + MediaStreamDestination (mixer)
  --> Scans meetApp.consumers Map for audio tracks (mediasoup consumers)
  --> Scans DOM for <audio data-producer-id> elements (fallback)
  --> Connects all audio tracks to mixer via createMediaStreamSource()
  --> MediaRecorder captures destination.stream as audio/webm;codecs=opus
  --> Periodic re-scan (every 1s) picks up new participants who join later

Step 6: Max Duration Guard
  setTimeout triggers auto-stop after maxRecordingDuration minutes
  Default: 30 minutes (configurable up to 60+)

Step 7: Stop Recording
  POST /recordings/:meetingId/stop
  --> Stop frame capture interval
  --> Stop MediaRecorder in browser, extract audio as base64
  --> Save audio.webm to frames directory
  --> Close browser immediately
  --> Spawn FFmpeg in background for encoding

Step 8: FFmpeg Encoding (Background)
  Convert JPEG frames + audio.webm --> final .webm video
  --> Handles audio/video duration mismatch
  --> Cleans up frames directory after completion
  --> Output: recordings/{meetingId}_{timestamp}.webm
```

---

## Video Capture (Screenshot Timer)

The bot uses timer-based `page.screenshot()` calls rather than CDP screencast or MediaRecorder on a canvas. This approach was chosen for reliability across platforms (especially Windows where CDP screencast can be unreliable).

```
captureFrame() loop
  |
  +--> Check captureActive flag (stops loop on recording end)
  +--> Check isCapturing lock (prevents overlapping async captures)
  |
  +--> page.screenshot({ type: 'jpeg', quality: 85, fullPage: false })
  |    |
  |    +--> Returns Buffer of JPEG data
  |    +--> fs.writeFileSync(frame_NNNNNN.jpg)
  |    +--> Verify file exists after save
  |    +--> Increment frameCount only on success (no gaps)
  |
  +--> Error handling:
       +--> consecutiveErrors counter
       +--> After 10 consecutive: attempt page.bringToFront() recovery
       +--> After 50 consecutive: log critical warning
       +--> Never increment frameCount on failure (prevents gaps in sequence)
```

### Frame Naming Convention

Frames use zero-padded 6-digit numbering: `frame_000000.jpg`, `frame_000001.jpg`, etc. This is required by FFmpeg's `%06d` pattern matching for image sequence input.

### Capture Rate

The actual capture FPS during recording is hardcoded at 10fps in the capture loop, regardless of the `RECORDING_FPS` environment variable. The `RECORDING_FPS` setting is passed to the meeting page as a URL parameter to configure the in-browser MediaRecorder quality hint, not the screenshot rate. The 10fps rate provides a good balance between CPU usage and visual smoothness for meeting recordings.

---

## Audio Capture (Browser MediaRecorder)

Audio is captured entirely inside the browser context via `page.evaluate()`. The bot injects JavaScript that:

1. Creates a Web Audio API `AudioContext` and `MediaStreamDestination` node (audio mixer)
2. Scans `window.meetApp.consumers` for mediasoup audio consumers with live tracks
3. Scans the DOM for `<audio data-producer-id>` elements as a fallback
4. Connects each discovered audio track to the mixer via `createMediaStreamSource()`
5. Starts a `MediaRecorder` on the mixer output stream (`audio/webm;codecs=opus` at 128kbps)
6. Runs a periodic scan every 1 second to discover new participants

```
meetApp.consumers (mediasoup)        DOM <audio> elements (fallback)
       |                                    |
       v                                    v
  Audio tracks                         Audio tracks
       |                                    |
       +-------------+---------------------+
                     |
                     v
           AudioContext mixer
           (MediaStreamDestination)
                     |
                     v
              MediaRecorder
           (audio/webm;codecs=opus)
                     |
                     v
            _botAudioChunks[]
           (collected every 1s)
```

On stop, the audio chunks are assembled into a Blob, converted to base64 via FileReader, returned to Node.js, and saved as `audio.webm` in the frames directory.

---

## FFmpeg Encoding Pipeline

After the browser is closed, FFmpeg runs in the background (non-blocking) to combine frames and audio into a final `.webm` video.

### Video-Only Encoding

```
ffmpeg -y -framerate 10 \
  -i frames_dir/frame_%06d.jpg \
  -c:v libvpx -b:v 4M -pix_fmt yuv420p \
  output.webm
```

### Video + Audio (Video Longer)

When the video frame sequence is longer than or equal to the audio, audio is padded with silence:

```
ffmpeg -y -framerate 10 \
  -i frames_dir/frame_%06d.jpg \
  -i frames_dir/audio.webm \
  -c:v libvpx -b:v 4M -pix_fmt yuv420p \
  -c:a libvorbis -b:a 128k \
  -filter_complex "[1:a]apad=whole_dur=VIDEO_DURATION[aout]" \
  -map 0:v -map [aout] \
  output.webm
```

### Video + Audio (Audio Longer)

When audio is longer than the frame sequence, the last frame is looped to extend video duration:

```
ffmpeg -y \
  -framerate 10 -i frames_dir/frame_%06d.jpg \
  -loop 1 -framerate 10 -t EXTRA_DURATION -i frames_dir/frame_LAST.jpg \
  -i frames_dir/audio.webm \
  -filter_complex "[0:v]fps=10[v0];[1:v]fps=10[v1];[v0][v1]concat=n=2:v=1:a=0[vout]" \
  -map [vout] -map 2:a \
  -c:v libvpx -b:v 4M -pix_fmt yuv420p \
  -c:a libvorbis -b:a 128k \
  output.webm
```

### Duration Calculation

Before encoding, the bot:
1. Calculates video duration: `frameCount / fps`
2. Probes audio duration using `ffprobe`
3. Uses the longer of the two as the target duration
4. Applies the appropriate encoding strategy

### Post-Encoding Cleanup

After FFmpeg completes (success or failure), the temporary frames directory is deleted via `fs.rmSync(framesDir, { recursive: true, force: true })`.

---

## Main Server Integration

The recording bot is triggered and controlled by the main CodeShare server via REST API calls:

```
Main Server                          Recording Bot
    |                                     |
    |  POST /recordings/start             |
    |  { meetingId, meetingUrl }           |
    |  X-API-Key: shared-secret           |
    |------------------------------------>|
    |                                     |  Launch Puppeteer
    |                                     |  Navigate to meeting
    |                                     |  Start capture
    |  { success, meetingId, token }      |
    |<------------------------------------|
    |                                     |
    |  GET /recordings/:id/status         |
    |------------------------------------>|
    |  { status, duration, frameCount }   |
    |<------------------------------------|
    |                                     |
    |  POST /recordings/:id/stop          |
    |------------------------------------>|
    |                                     |  Stop capture
    |                                     |  FFmpeg encode (background)
    |  { success, filename, status:       |
    |    'processing' }                   |
    |<------------------------------------|
    |                                     |
    |  GET /recordings/:filename/stream   |
    |  (clients access directly)          |
    |------------------------------------>|
    |  Video stream (range requests)      |
    |<------------------------------------|
```

### Authentication Flow

1. Main server and recording bot share `RECORDING_BOT_SECRET`
2. All API calls include `X-API-Key` header with the shared secret
3. The bot passes the same token as a URL parameter when joining the meeting (`?recorder=true&token=...`)
4. The main server validates the token to identify the bot as a recorder participant

### Environment Variables on Main Server

```
RECORDING_BOT_ENABLED=true
RECORDING_BOT_URL=http://localhost:4000
RECORDING_BOT_SECRET=your-secure-secret-key-here
RECORDING_BOT_PUBLIC_URL=https://recorder.your-domain.com
```

---

## Xvfb Virtual Framebuffer

On Linux servers (the recommended production environment), Chromium must run in headful mode for reliable video capture. Since servers typically lack a display, Xvfb provides a virtual framebuffer:

```
+---------------------------+
| Xvfb (X Virtual Frame    |
| Buffer)                   |
|                           |
| Virtual display :99       |
| Resolution: 1920x1080x24 |
| No physical monitor       |
+---------------------------+
         |
         v
+---------------------------+
| Chromium (headful mode)   |
|                           |
| Renders meeting UI        |
| Full WebGL/CSS/canvas     |
| support                   |
+---------------------------+
```

### Detection Logic (config.js)

```
1. Check process.env.DISPLAY exists
2. If DISPLAY is set --> useXvfb = true, headless = false
   Browser args include: --enable-gpu, --use-gl=desktop
3. If DISPLAY is not set --> headless = 'new'
   Browser args include: --use-gl=swiftshader, --disable-gpu-sandbox
```

### Startup Methods

- `npm run start:xvfb` -- Wraps with `xvfb-run --auto-servernum --server-args='-screen 0 1920x1080x24 -ac'`
- `start-xvfb.sh` -- Shell script equivalent
- Systemd/PM2/Docker -- All use `xvfb-run` as the wrapper

---

## Concurrency and Lifecycle

### Bot Instance Lifecycle

```
(API request)
     |
     v
  startRecording()
     |
     v
  [recording] ---- capture frames + audio
     |
     v
  stopRecording() or maxDuration timeout
     |
     v
  [stopping] ----- stop capture, extract audio, close browser
     |
     v
  (removed from activeBots map)
     |
     v
  [processing] --- FFmpeg runs in background
     |
     v
  .webm file saved, frames directory cleaned up
```

### Concurrency Controls

- `activeBots` Map tracks all running instances by meetingId
- `maxConcurrentRecordings` (default 5) enforced before starting new recording
- Duplicate recording prevention: rejects if meetingId already has an active bot
- `stopping` status guard prevents concurrent stop calls for the same meeting
- Max duration timeout auto-stops recordings after configured limit
- Graceful shutdown (`SIGINT`/`SIGTERM`) calls `stopAll()` to cleanly close all browsers

---

## File Storage and Streaming

### Directory Structure

```
recordings/
  +-- {meetingId}_{timestamp}.webm      (final recording)
  +-- frames_{meetingId}_{timestamp}/    (temporary, during recording)
  |     +-- frame_000000.jpg
  |     +-- frame_000001.jpg
  |     +-- ...
  |     +-- audio.webm
  +-- index.json                        (optional, maps recordingId to filename)
```

### Video Streaming

The `/recordings/:filename/stream` endpoint supports HTTP range requests for video seeking:

- `Range` header parsing for partial content (HTTP 206)
- Full content delivery when no range is specified (HTTP 200)
- CORS headers for cross-origin access
- `Content-Type: video/webm`
- Security: only `.webm` files allowed, directory traversal prevented

### Download Endpoints

Two download mechanisms:
1. **Authenticated** (`/recordings/:filename/download`) -- Requires X-API-Key, serves by exact filename
2. **Public** (`/recordings/:recordingId/download`) -- No auth, looks up recording by ID via `index.json` or filename pattern matching

---

## File Map

| File | Lines | Purpose |
|------|-------|---------|
| `server.js` | ~295 | Express API server, route handlers, authentication middleware, streaming/download endpoints, graceful shutdown |
| `bot-manager.js` | ~822 | BotManager class: Puppeteer lifecycle, screenshot capture loop, in-browser audio recording, FFmpeg encoding (background and blocking), status tracking |
| `config.js` | ~103 | Configuration loader: Xvfb detection, headless mode selection, browser args, recording quality, timeouts, environment variable mapping |
| `package.json` | 18 | Dependencies: express, puppeteer, cors, dotenv, uuid |
| `start-xvfb.sh` | 6 | Shell script to launch with xvfb-run wrapper |
| `.example.env` | 21 | Environment variable template with defaults |
| `.env.production` | 21 | Production environment configuration |
