# Recording Bot -- Documentation

API reference, environment variables, deployment guide, and troubleshooting for the recording bot service.

---

## API Reference

All authenticated endpoints require the `X-API-Key` header set to `RECORDING_BOT_SECRET`.

### GET /health

Health check (no authentication required).

**Response**: `{ status, activeRecordings, maxConcurrent }`

### POST /recordings/start

Start recording a meeting. Requires `meetingId` and `meetingUrl` in the JSON body.

**Response**: `{ success, meetingId, message, maxDuration, token }`

### POST /recordings/:meetingId/stop

Stop an active recording. Returns immediately; FFmpeg encoding continues in the background.

**Response**: `{ success, meetingId, filename, filePath, status, duration, frameCount }`

### GET /recordings/:meetingId/status

Get the status of an active recording.

**Response**: `{ status, startedAt, duration, frameCount }`

### GET /recordings

List all active recordings.

**Response**: `{ recordings: [{ meetingId, status, startedAt, duration, frameCount }] }`

### GET /recordings/files

List all saved `.webm` recording files on disk.

**Response**: `{ files: [{ filename, size, createdAt }] }`

### GET /recordings/:filename/stream

Public endpoint (no auth). Streams a `.webm` file with HTTP range-request support for video seeking. Only `.webm` filenames are accepted; directory traversal is blocked.

### GET /recordings/:recordingId/download

Public download by recording ID. Looks up the filename via `index.json` or pattern matching.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RECORDING_BOT_PORT` | `4000` | Server listen port |
| `RECORDING_BOT_SECRET` | (insecure default) | Shared API secret; must match main server |
| `RECORDINGS_DIR` | `./recordings` | Directory for saved recordings |
| `MAX_CONCURRENT_RECORDINGS` | `5` | Max simultaneous recordings |
| `MAX_RECORDING_DURATION` | `30` | Auto-stop limit in minutes |
| `MAIN_SERVER_URL` | `https://localhost:3200` | Main CodeShare server URL |
| `RECORDING_BOT_HEADLESS` | auto | Set `false` for headful mode with Xvfb |
| `RECORDING_FPS` | `60` | FPS hint passed to the meeting page |
| `RECORDING_VIDEO_BITRATE` | `8000000` | Video bitrate in bps |
| `RECORDING_AUDIO_BITRATE` | `192000` | Audio bitrate in bps |
| `RECORDING_CHUNK_INTERVAL` | `100` | MediaRecorder chunk interval (ms) |
| `RECORDING_CODEC` | `vp9` | Codec hint: `vp9`, `vp8`, or `auto` |
| `FFMPEG_PATH` | `ffmpeg` | Custom path to FFmpeg binary |
| `RECORD_MEETINGS` | `true` | Set `false` to disable recording entirely |

---

## Deployment

### Quick Start

```bash
cd recording-bot
npm install
npm run start:xvfb   # Linux with Xvfb (recommended)
npm start            # Windows / headless fallback
```

### Systemd Service

Create `/etc/systemd/system/codeshare-recorder.service`:

```ini
[Unit]
Description=CodeShare Recording Bot
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/codeshare/recording-bot
ExecStart=/usr/bin/xvfb-run --auto-servernum --server-args='-screen 0 1920x1080x24 -ac' /usr/bin/node server.js
Restart=always
RestartSec=10
MemoryMax=4G

[Install]
WantedBy=multi-user.target
```

Enable: `sudo systemctl enable --now codeshare-recorder`

### Docker

```bash
docker build -t codeshare-recorder .
docker run -d -p 4000:4000 -v $(pwd)/recordings:/app/recordings --env-file .env codeshare-recorder
```

### Main Server Config

On the main CodeShare server, set these environment variables:

```
RECORDING_BOT_ENABLED=true
RECORDING_BOT_URL=http://localhost:4000
RECORDING_BOT_SECRET=<your-shared-secret>
RECORDING_BOT_PUBLIC_URL=https://recorder.your-domain.com
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Empty video file | Headless mode cannot capture video streams | Set `RECORDING_BOT_HEADLESS=false` and use Xvfb |
| "No usable sandbox" error | Missing `--no-sandbox` flag or running as root | Flag is included by default; avoid running as root |
| Cannot connect to main server | Wrong `MAIN_SERVER_URL` or SSL issue | Verify URL; `--ignore-certificate-errors` is set by default |
| High memory usage | Too many concurrent recordings | Reduce `MAX_CONCURRENT_RECORDINGS` |
| Recordings not saving | Permissions or disk space | Check `ls -la recordings/` and `df -h` |
| FFmpeg fails | Missing or wrong FFmpeg binary | Verify `ffmpeg --version`; set `FFMPEG_PATH` if needed |

### Viewing Logs

```bash
sudo journalctl -u codeshare-recorder -f   # systemd
pm2 logs codeshare-recorder                 # PM2
docker logs -f codeshare-recorder           # Docker
```
