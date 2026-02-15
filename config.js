/**
 * Recording Bot Configuration
 */

// Detect if running under xvfb (virtual framebuffer)
const hasDisplay = !!process.env.DISPLAY;
const useXvfb = process.env.USE_XVFB === 'true' || hasDisplay;

// When running under xvfb, use headful mode for better video capture
// Otherwise fall back to headless (which may have video issues)
const getHeadlessMode = () => {
  if (useXvfb) {
    // Running under xvfb - use headful mode for proper video rendering
    console.log('[Config] XVFB detected (DISPLAY=' + process.env.DISPLAY + '), using headful mode');
    return false;
  }
  // No xvfb - use headless but warn about video issues
  const headless = process.env.RECORDING_BOT_HEADLESS !== 'false' ? 'new' : false;
  if (headless) {
    console.log('[Config] Running in headless mode - video capture may not work properly');
    console.log('[Config] For video recording, use: npm run start:xvfb (requires xvfb-run)');
  }
  return headless;
};

module.exports = {
  // Server settings
  port: process.env.RECORDING_BOT_PORT || 4000,

  // Security
  apiSecret: process.env.RECORDING_BOT_SECRET || 'recording-bot-secret-key-change-in-production',

  // Recording settings
  recordingsDir: process.env.RECORDINGS_DIR || './recordings',
  maxConcurrentRecordings: parseInt(process.env.MAX_CONCURRENT_RECORDINGS) || 5,
  maxRecordingDuration: parseInt(process.env.MAX_RECORDING_DURATION) || 30, // minutes
  recordingEnabled: process.env.RECORD_MEETINGS !== 'false', // matches main server config

  // Main server URL (where meetings are hosted)
  mainServerUrl: process.env.MAIN_SERVER_URL || 'https://localhost:3200',

  // Headless mode: false when using xvfb (recommended), 'new' for pure headless
  headless: getHeadlessMode(),

  // Whether xvfb is being used
  useXvfb,

  // Browser settings - optimized for xvfb or headless mode
  browserArgs: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--auto-select-desktop-capture-source=Entire screen',
    '--enable-usermedia-screen-capturing',
    '--allow-http-screen-capture',
    '--disable-dev-shm-usage',
    '--disable-web-security',
    '--allow-running-insecure-content',
    '--ignore-certificate-errors',
    '--autoplay-policy=no-user-gesture-required',
    '--enable-features=SharedArrayBuffer',
    // GPU and rendering settings
    '--enable-webgl',
    ...(useXvfb ? [
      // xvfb mode: enable GPU acceleration for better rendering
      '--enable-gpu',
      '--use-gl=desktop',
    ] : [
      // Headless mode: use software rendering
      '--use-gl=swiftshader',
      '--disable-software-rasterizer',
      '--disable-gpu-sandbox',
      '--enable-unsafe-swiftshader',
      '--disable-accelerated-2d-canvas'
    ])
  ],

  // Recording quality
  viewport: {
    width: 1920,
    height: 1080
  },

  // Recording quality settings (configurable via .env)
  recordingQuality: {
    fps: parseInt(process.env.RECORDING_FPS) || 60,
    videoBitrate: parseInt(process.env.RECORDING_VIDEO_BITRATE) || 8000000,
    audioBitrate: parseInt(process.env.RECORDING_AUDIO_BITRATE) || 192000,
    chunkInterval: parseInt(process.env.RECORDING_CHUNK_INTERVAL) || 100,
    codec: process.env.RECORDING_CODEC || 'vp9'  // vp9, vp8, or auto
  },

  // Timeouts
  pageLoadTimeout: 30000,
  joinTimeout: 15000,

  // FFmpeg path for video encoding
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',

  // Protocol timeout for CDP operations (increased for Windows)
  protocolTimeout: 60000
};
