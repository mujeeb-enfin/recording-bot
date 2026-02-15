# CodeShare Recording Bot

A headless browser-based recording bot for CodeShare Meet. This service joins meetings as a bot participant and records the video/audio using Puppeteer and the MediaRecorder API.

## Architecture

```
┌─────────────────────┐         ┌─────────────────────┐
│   Main Server       │◄───────►│   Recording Bot     │
│   (Port 3200)       │  API    │   (Port 4000)       │
│                     │         │                     │
│  - Meeting hosting  │         │  - Puppeteer        │
│  - WebSocket/SFU    │         │  - Xvfb (Linux)     │
│  - Recording API    │         │  - MediaRecorder    │
└─────────────────────┘         └─────────────────────┘
```

## Prerequisites

### System Requirements
- **OS**: Ubuntu 20.04+ / Debian 11+ (recommended)
- **RAM**: Minimum 2GB (4GB+ recommended for multiple recordings)
- **CPU**: 2+ cores recommended
- **Disk**: Sufficient space for recordings (~500MB per hour at 1080p)

### Required Software
- Node.js 18+ (LTS recommended)
- npm or yarn
- Xvfb (X Virtual Framebuffer)
- Chromium/Chrome dependencies

## Installation

### Step 1: Install Node.js

```bash
# Using NodeSource repository (recommended)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify installation
node --version  # Should be 18+
npm --version
```

### Step 2: Install Xvfb and Chrome Dependencies

Xvfb is required for video recording. Headless Chrome cannot properly capture video streams, so we run Chrome in headful mode inside a virtual framebuffer.

```bash
# Update package list
sudo apt-get update

# Install Xvfb
sudo apt-get install -y xvfb

# Install Chrome/Chromium dependencies
sudo apt-get install -y \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libxshmfence1 \
    libxss1 \
    libxtst6 \
    fonts-liberation \
    libappindicator3-1 \
    libu2f-udev \
    libvulkan1 \
    xdg-utils

# Install additional fonts for proper rendering
sudo apt-get install -y \
    fonts-noto \
    fonts-noto-cjk \
    fonts-freefont-ttf
```

### Step 3: Clone and Setup Recording Bot

```bash
# Navigate to your project directory
cd /opt  # or your preferred location

# Clone the repository (if not already done)
git clone https://github.com/your-repo/codeshare.git
cd codeshare/recording-bot

# Install dependencies
npm install

# Puppeteer will automatically download Chromium
# This may take a few minutes
```

### Step 4: Configure Environment

Create or edit the `.env` file:

```bash
cp .env.example .env  # If example exists
# Or create new:
nano .env
```

Add the following configuration:

```env
# Recording Bot Server Configuration

# Server Port
RECORDING_BOT_PORT=4000

# API Secret (MUST match main server's RECORDING_BOT_SECRET)
RECORDING_BOT_SECRET=your-secure-secret-key-here

# Recording Storage
RECORDINGS_DIR=./recordings
MAX_CONCURRENT_RECORDINGS=5
MAX_RECORDING_DURATION=60

# Main Server URL (where meetings are hosted)
# Use your actual domain in production
MAIN_SERVER_URL=https://your-domain.com

# Recording Quality Settings
RECORDING_FPS=30                 # 30 or 60 fps
RECORDING_VIDEO_BITRATE=4000000  # 4 Mbps (use 8000000 for 8 Mbps)
RECORDING_AUDIO_BITRATE=128000   # 128 kbps
RECORDING_CHUNK_INTERVAL=100     # MediaRecorder chunk interval in ms
RECORDING_CODEC=vp9              # vp9, vp8, or auto

# Headless mode - MUST be false for video recording on Linux
# Xvfb provides the virtual display
RECORDING_BOT_HEADLESS=false
```

### Step 5: Create Recordings Directory

```bash
mkdir -p recordings
chmod 755 recordings
```

### Step 6: Test the Installation

```bash
# Test with Xvfb
npm run start:xvfb

# You should see:
# [Config] XVFB detected (DISPLAY=:99), using headful mode
# [Recording Bot Server] Running on port 4000
```

Press `Ctrl+C` to stop.

## Running in Production

### Option 1: Systemd Service (Recommended)

Create a systemd service file:

```bash
sudo nano /etc/systemd/system/codeshare-recorder.service
```

Add the following content:

```ini
[Unit]
Description=CodeShare Recording Bot
After=network.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/opt/codeshare/recording-bot
Environment=NODE_ENV=production
ExecStart=/usr/bin/xvfb-run --auto-servernum --server-args='-screen 0 1920x1080x24 -ac' /usr/bin/node server.js
Restart=always
RestartSec=10

# Resource limits
LimitNOFILE=65536
MemoryMax=4G

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=codeshare-recorder

[Install]
WantedBy=multi-user.target
```

Enable and start the service:

```bash
# Reload systemd
sudo systemctl daemon-reload

# Enable service to start on boot
sudo systemctl enable codeshare-recorder

# Start the service
sudo systemctl start codeshare-recorder

# Check status
sudo systemctl status codeshare-recorder

# View logs
sudo journalctl -u codeshare-recorder -f
```

### Option 2: PM2 Process Manager

```bash
# Install PM2 globally
sudo npm install -g pm2

# Create PM2 ecosystem file
nano ecosystem.config.js
```

Add the following:

```javascript
module.exports = {
  apps: [{
    name: 'codeshare-recorder',
    script: 'server.js',
    cwd: '/opt/codeshare/recording-bot',
    interpreter: '/usr/bin/xvfb-run',
    interpreter_args: '--auto-servernum --server-args="-screen 0 1920x1080x24 -ac" /usr/bin/node',
    env: {
      NODE_ENV: 'production'
    },
    max_memory_restart: '4G',
    error_file: '/var/log/codeshare-recorder-error.log',
    out_file: '/var/log/codeshare-recorder-out.log'
  }]
};
```

Start with PM2:

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup  # Follow the instructions to enable startup on boot
```

### Option 3: Docker (Alternative)

Create a `Dockerfile`:

```dockerfile
FROM node:20-slim

# Install Xvfb and Chrome dependencies
RUN apt-get update && apt-get install -y \
    xvfb \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libxshmfence1 \
    libxss1 \
    libxtst6 \
    fonts-liberation \
    fonts-noto \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

RUN mkdir -p recordings

EXPOSE 4000

CMD ["xvfb-run", "--auto-servernum", "--server-args=-screen 0 1920x1080x24 -ac", "node", "server.js"]
```

Build and run:

```bash
docker build -t codeshare-recorder .
docker run -d \
  --name codeshare-recorder \
  -p 4000:4000 \
  -v $(pwd)/recordings:/app/recordings \
  --env-file .env \
  codeshare-recorder
```

## Nginx Reverse Proxy (Optional)

If you want to expose the recording bot through Nginx:

```nginx
server {
    listen 443 ssl http2;
    server_name recorder.your-domain.com;

    ssl_certificate /etc/letsencrypt/live/recorder.your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/recorder.your-domain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # For video streaming
        proxy_buffering off;
        proxy_read_timeout 300s;
    }

    # Video streaming endpoint
    location /recordings/ {
        proxy_pass http://127.0.0.1:4000/recordings/;
        proxy_buffering off;
        proxy_cache off;

        # Allow range requests for video seeking
        proxy_set_header Range $http_range;
        proxy_set_header If-Range $http_if_range;
    }
}
```

## Main Server Configuration

On your main CodeShare server, configure these environment variables:

```env
# Enable recording bot integration
RECORDING_BOT_ENABLED=true
RECORDING_BOT_URL=http://localhost:4000  # Or http://recorder-ip:4000
RECORDING_BOT_SECRET=your-secure-secret-key-here  # Must match bot's secret

# Public URL for clients to stream recordings
RECORDING_BOT_PUBLIC_URL=https://recorder.your-domain.com
```

## API Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/health` | No | Health check |
| POST | `/recordings/start` | Yes | Start recording a meeting |
| POST | `/recordings/:meetingId/stop` | Yes | Stop recording |
| GET | `/recordings/:meetingId/status` | Yes | Get recording status |
| GET | `/recordings` | Yes | List active recordings |
| GET | `/recordings/files` | Yes | List saved recording files |
| GET | `/recordings/:filename/stream` | No | Stream video file (public) |
| GET | `/recordings/:filename/download` | Yes | Download recording file |

Authentication is done via `X-API-Key` header with the `RECORDING_BOT_SECRET` value.

## Troubleshooting

### Issue: "No usable sandbox" error

```bash
# Check if you have --no-sandbox in browser args (should be there by default)
# If running as root (not recommended), this is required
```

### Issue: Video recording produces empty file

1. Ensure Xvfb is running:
```bash
ps aux | grep Xvfb
```

2. Check if DISPLAY is set:
```bash
echo $DISPLAY  # Should show :99 or similar
```

3. Verify headless mode is disabled:
```bash
grep RECORDING_BOT_HEADLESS .env  # Should be false
```

### Issue: Cannot connect to main server

1. Check the main server URL:
```bash
curl -k https://your-domain.com/health
```

2. Verify SSL certificates are valid or `--ignore-certificate-errors` is set

### Issue: High memory usage

Reduce concurrent recordings:
```env
MAX_CONCURRENT_RECORDINGS=2
```

Lower video quality:
```env
RECORDING_FPS=30
RECORDING_VIDEO_BITRATE=2000000
```

### Issue: Recordings not saving

1. Check directory permissions:
```bash
ls -la recordings/
```

2. Check disk space:
```bash
df -h
```

### View Logs

```bash
# Systemd
sudo journalctl -u codeshare-recorder -f

# PM2
pm2 logs codeshare-recorder

# Docker
docker logs -f codeshare-recorder
```

## Recording Quality Presets

### High Quality (1080p 60fps)
```env
RECORDING_FPS=60
RECORDING_VIDEO_BITRATE=8000000
RECORDING_AUDIO_BITRATE=192000
RECORDING_CODEC=vp9
```

### Medium Quality (1080p 30fps)
```env
RECORDING_FPS=30
RECORDING_VIDEO_BITRATE=4000000
RECORDING_AUDIO_BITRATE=128000
RECORDING_CODEC=vp9
```

### Low Quality (720p 30fps)
```env
RECORDING_FPS=30
RECORDING_VIDEO_BITRATE=2000000
RECORDING_AUDIO_BITRATE=96000
RECORDING_CODEC=vp8
```

## Security Considerations

1. **Change the default API secret** in production
2. **Use HTTPS** for the main server URL
3. **Restrict access** to the recording bot port (4000) via firewall
4. **Run as non-root user** (e.g., www-data)
5. **Set up log rotation** for recording logs
6. **Monitor disk usage** for recordings directory

## File Structure

```
recording-bot/
├── server.js          # Main Express server
├── bot-manager.js     # Manages recording bot instances
├── config.js          # Configuration loader
├── package.json       # Dependencies
├── .env               # Environment configuration
├── start-xvfb.sh      # Shell script for Xvfb startup
├── recordings/        # Recorded video files
└── README.md          # This file
```

## License

MIT License - See main project LICENSE file.
