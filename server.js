/**
 * Recording Bot Server
 *
 * API server that manages recording bots for CodeShare Meet.
 * Spawns headless browser instances that join meetings and record them.
 */

const path = require('path');
// Load .env from recording-bot folder only
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const BotManager = require('./bot-manager');
const config = require('./config');

const app = express();
const botManager = new BotManager();

// Middleware
app.use(cors());
app.use(express.json());

// API Key authentication middleware
function authenticate(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== config.apiSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Get the recorder token (same secret used for API auth, used to identify bot to main server)
function getRecorderToken() {
  return config.apiSecret;
}

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeRecordings: botManager.getAllActive().length,
    maxConcurrent: config.maxConcurrentRecordings
  });
});

/**
 * Start recording for a meeting
 * POST /recordings/start
 * Body: { meetingId, meetingUrl }
 */
app.post('/recordings/start', authenticate, async (req, res) => {
  const { meetingId, meetingUrl } = req.body;

  if (!meetingId || !meetingUrl) {
    return res.status(400).json({ error: 'meetingId and meetingUrl are required' });
  }

  // Check if recording is enabled
  if (!config.recordingEnabled) {
    return res.status(403).json({ error: 'Recording is disabled in server configuration' });
  }

  console.log(`[Server] Starting recording for meeting: ${meetingId}`);
  console.log(`[Server] Max duration: ${config.maxRecordingDuration} minutes`);

  const token = getRecorderToken();
  const result = await botManager.startRecording(meetingId, meetingUrl, token);

  if (result.error) {
    return res.status(500).json(result);
  }

  res.json({
    ...result,
    token // Return token so main server can verify bot
  });
});

/**
 * Stop recording for a meeting
 * POST /recordings/:meetingId/stop
 */
app.post('/recordings/:meetingId/stop', authenticate, async (req, res) => {
  const { meetingId } = req.params;

  console.log(`[Server] Stopping recording for meeting: ${meetingId}`);

  const result = await botManager.stopRecording(meetingId);

  if (result.error) {
    return res.status(500).json(result);
  }

  res.json(result);
});

/**
 * Get recording status
 * GET /recordings/:meetingId/status
 */
app.get('/recordings/:meetingId/status', authenticate, (req, res) => {
  const { meetingId } = req.params;
  const status = botManager.getStatus(meetingId);
  res.json(status);
});

/**
 * List all active recordings
 * GET /recordings
 */
app.get('/recordings', authenticate, (req, res) => {
  const active = botManager.getAllActive();
  res.json({ recordings: active });
});

/**
 * Download a recording file (authenticated, by filename)
 * GET /recordings/:filename/download
 */
app.get('/recordings/:filename/download', authenticate, (req, res) => {
  const { filename } = req.params;
  const filePath = path.join(config.recordingsDir, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Recording not found' });
  }

  res.download(filePath);
});

/**
 * Public streaming endpoint for video recordings (by filename)
 * Used by the main server to proxy video streams
 * GET /recordings/:filename/stream
 */
app.get('/recordings/:filename/stream', (req, res) => {
  const { filename } = req.params;

  // Decode the filename (it may be URL encoded)
  const decodedFilename = decodeURIComponent(filename);

  // Security: only allow .webm files and prevent directory traversal
  if (!decodedFilename.endsWith('.webm') || decodedFilename.includes('..') || decodedFilename.includes('/') || decodedFilename.includes('\\')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const filePath = path.join(path.resolve(config.recordingsDir), decodedFilename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Recording not found' });
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  // Set CORS headers for cross-origin streaming
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range');

  if (range) {
    // Handle range requests for seeking
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(filePath, { start, end });

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': 'video/webm'
    });

    file.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'video/webm',
      'Accept-Ranges': 'bytes'
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

/**
 * Public download endpoint for video recordings (by recordingId)
 * Used by the meeting summary page to download videos from the recording server
 * GET /recordings/:recordingId/download (public, no auth for client access)
 */
app.get('/recordings/:recordingId/download', (req, res, next) => {
  // Check if this is an authenticated request (has API key)
  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    // Let it fall through to the authenticated route
    return next('route');
  }

  const { recordingId } = req.params;
  const recordingsPath = path.resolve(config.recordingsDir);

  if (!fs.existsSync(recordingsPath)) {
    return res.status(404).json({ error: 'Recordings directory not found' });
  }

  const files = fs.readdirSync(recordingsPath).filter(f => f.endsWith('.webm'));
  let targetFile = null;

  // Check index file first
  const indexPath = path.join(recordingsPath, 'index.json');
  if (fs.existsSync(indexPath)) {
    try {
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      if (index[recordingId]) {
        targetFile = index[recordingId];
      }
    } catch (e) {
      console.error('[Server] Error reading index.json:', e.message);
    }
  }

  // Fallback: check filename patterns
  if (!targetFile) {
    if (files.includes(`${recordingId}.webm`)) {
      targetFile = `${recordingId}.webm`;
    } else {
      targetFile = files.find(f => f.startsWith(recordingId));
    }
  }

  if (!targetFile) {
    return res.status(404).json({ error: 'Recording not found' });
  }

  const filePath = path.join(recordingsPath, targetFile);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Recording file not found' });
  }

  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');

  res.download(filePath, targetFile);
});

/**
 * List all saved recordings
 * GET /recordings/files
 */
app.get('/recordings/files', authenticate, (req, res) => {
  const files = fs.readdirSync(path.resolve(config.recordingsDir))
    .filter(f => f.endsWith('.webm'))
    .map(f => {
      const filePath = path.join(config.recordingsDir, f);
      const stats = fs.statSync(filePath);
      return {
        filename: f,
        size: stats.size,
        createdAt: stats.birthtime
      };
    });

  res.json({ files });
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n[Server] Shutting down...');
  await botManager.stopAll();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n[Server] Shutting down...');
  await botManager.stopAll();
  process.exit(0);
});

// Start server
const PORT = config.port;
app.listen(PORT, () => {
  console.log(`[Recording Bot Server] Running on port ${PORT}`);
  console.log(`[Recording Bot Server] Main server URL: ${config.mainServerUrl}`);
  console.log(`[Recording Bot Server] Recordings directory: ${path.resolve(config.recordingsDir)}`);
  console.log(`[Recording Bot Server] Max concurrent recordings: ${config.maxConcurrentRecordings}`);
});
