/**
 * Bot Manager - Manages Puppeteer instances for recording meetings
 * Uses CDP (Chrome DevTools Protocol) screencast for reliable video capture on Windows
 */

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const config = require('./config');

class BotManager {
  constructor() {
    this.activeBots = new Map(); // meetingId -> { browser, page, status, startedAt, ... }
    this.recordingsDir = path.resolve(config.recordingsDir);

    // Ensure recordings directory exists
    if (!fs.existsSync(this.recordingsDir)) {
      fs.mkdirSync(this.recordingsDir, { recursive: true });
    }
  }

  /**
   * Start recording for a meeting
   */
  async startRecording(meetingId, meetingUrl, token) {
    if (this.activeBots.has(meetingId)) {
      return { error: 'Recording already in progress for this meeting' };
    }

    if (this.activeBots.size >= config.maxConcurrentRecordings) {
      return { error: 'Maximum concurrent recordings reached' };
    }

    console.log(`[BotManager] Starting recording for meeting: ${meetingId}`);
    console.log(`[BotManager] Meeting URL: ${meetingUrl}`);

    try {
      // Launch browser with configurable headless mode
      console.log(`[BotManager] Launching browser (headless: ${config.headless}, xvfb: ${config.useXvfb})`);
      if (!config.headless && !config.useXvfb) {
        console.warn(`[BotManager] WARNING: Running headful without xvfb - this requires a display!`);
      }
      const browser = await puppeteer.launch({
        headless: config.headless,
        args: config.browserArgs,
        protocolTimeout: config.protocolTimeout || 60000
      });

      const page = await browser.newPage();

      // Forward console messages from the page
      page.on('console', msg => {
        const type = msg.type();
        const text = msg.text();
        if (type === 'error') {
          console.error(`[BotPage] ${text}`);
        } else if (type === 'warning') {
          console.warn(`[BotPage] ${text}`);
        } else {
          console.log(`[BotPage] ${text}`);
        }
      });

      page.on('pageerror', err => {
        console.error(`[BotPage Error]`, err.message);
      });

      // Set viewport for recording quality
      await page.setViewport(config.viewport);

      // Grant permissions for media
      const context = browser.defaultBrowserContext();
      await context.overridePermissions(meetingUrl, [
        'microphone',
        'camera',
        'notifications'
      ]);

      // Navigate to meeting with recorder params and quality settings
      const qualityParams = new URLSearchParams({
        recorder: 'true',
        token: token,
        fps: config.recordingQuality.fps,
        videoBitrate: config.recordingQuality.videoBitrate,
        audioBitrate: config.recordingQuality.audioBitrate,
        chunkInterval: config.recordingQuality.chunkInterval,
        codec: config.recordingQuality.codec
      });
      const recorderUrl = `${meetingUrl}?${qualityParams.toString()}`;
      console.log(`[BotManager] Navigating to: ${recorderUrl}`);
      console.log(`[BotManager] Recording quality: ${config.recordingQuality.fps}fps, ${config.recordingQuality.videoBitrate/1000000}Mbps video, ${config.recordingQuality.audioBitrate/1000}kbps audio, codec=${config.recordingQuality.codec}`);

      await page.goto(recorderUrl, {
        waitUntil: 'networkidle2',
        timeout: config.pageLoadTimeout
      });

      // Bring page to front and focus it (important for canvas capture on Windows)
      await page.bringToFront();

      // Create CDP session for screen recording
      const client = await page.target().createCDPSession();

      // Prevent page from being throttled in background
      try {
        await client.send('Page.setWebLifecycleState', { state: 'active' });
        console.log('[BotManager] Page lifecycle set to active (prevents background throttling)');
      } catch (e) {
        console.log('[BotManager] Could not set lifecycle state:', e.message);
      }

      // Wait for the meeting app to load
      await page.waitForSelector('#videoGrid', { timeout: config.joinTimeout });
      console.log(`[BotManager] Video grid found, bot connected to meeting`);

      // Wait for meetApp to be available (simplified to avoid timeout)
      console.log('[BotManager] Waiting for meeting UI to stabilize...');
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Check if meetApp is available
      const meetAppReady = await page.evaluate(() => {
        return !!(window.meetApp && window.meetApp.peers);
      });
      console.log('[BotManager] MeetApp ready:', meetAppReady);

      // Start timer-based screenshot recording (more reliable than CDP screencast)
      console.log('[BotManager] Starting timer-based screenshot recording...');

      const timestamp = Date.now();
      const framesDir = path.join(this.recordingsDir, `frames_${meetingId}_${timestamp}`);
      fs.mkdirSync(framesDir, { recursive: true });

      let frameCount = 0;
      const fps = 10; // Target FPS - 10fps is good for meetings (lower CPU usage, still smooth)
      const frameInterval = 1000 / fps;
      let captureActive = true;
      let isCapturing = false; // Prevent overlapping captures
      let consecutiveErrors = 0; // Track consecutive capture failures
      let lastSuccessTime = Date.now();

      // Timer-based frame capture using page.screenshot()
      // Uses a lock to prevent overlapping async captures
      const captureFrame = async () => {
        if (!captureActive) return;
        if (isCapturing) return; // Skip if previous capture still in progress

        isCapturing = true;
        try {
          // Get current frame number BEFORE incrementing
          const currentFrame = frameCount;
          const frameNumber = String(currentFrame).padStart(6, '0');
          const framePath = path.join(framesDir, `frame_${frameNumber}.jpg`);

          // Capture screenshot
          const screenshot = await page.screenshot({
            type: 'jpeg',
            quality: 85,
            fullPage: false
          });

          fs.writeFileSync(framePath, screenshot);

          // Verify frame was saved
          if (!fs.existsSync(framePath)) {
            console.error(`[BotManager] Frame ${frameNumber} NOT FOUND after save!`);
          }

          // Only increment AFTER successful save to avoid gaps
          frameCount++;
          consecutiveErrors = 0; // Reset error counter on success
          lastSuccessTime = Date.now();

          // Log progress every 10 frames (1 second at 10fps)
          if (frameCount % 10 === 0) {
            // Also verify earlier frames still exist
            const frame0Exists = fs.existsSync(path.join(framesDir, 'frame_000000.jpg'));
            const prevFrameNum = String(currentFrame - 10).padStart(6, '0');
            const prevFrameExists = currentFrame >= 10 ? fs.existsSync(path.join(framesDir, `frame_${prevFrameNum}.jpg`)) : true;
            console.log(`[BotManager] Captured ${frameCount} frames (${(frameCount / fps).toFixed(1)}s) | frame_000000: ${frame0Exists}, frame_${prevFrameNum}: ${prevFrameExists}`);
          }
        } catch (e) {
          consecutiveErrors++;
          // DON'T increment frameCount here - this prevents gaps in the sequence
          if (captureActive) {
            // Log every error, but with more detail for consecutive failures
            const timeSinceSuccess = ((Date.now() - lastSuccessTime) / 1000).toFixed(1);
            console.error(`[BotManager] Frame capture error #${consecutiveErrors} (${timeSinceSuccess}s since last success): ${e.message}`);

            // Try to recover after 10 consecutive errors
            if (consecutiveErrors === 10) {
              console.log('[BotManager] Attempting to recover - bringing page to front...');
              try {
                await page.bringToFront();
              } catch (recoveryError) {
                console.error('[BotManager] Recovery failed:', recoveryError.message);
              }
            }

            // If we've had many consecutive errors, something is seriously wrong
            if (consecutiveErrors >= 50 && consecutiveErrors % 50 === 0) {
              console.error(`[BotManager] WARNING: ${consecutiveErrors} consecutive capture failures! Browser may be unresponsive.`);
            }
          }
        } finally {
          isCapturing = false;
        }
      };

      // Start capturing frames at regular intervals
      const captureInterval = setInterval(captureFrame, frameInterval);
      // Capture first frame immediately
      await captureFrame();

      console.log(`[BotManager] Screenshot recording started for meeting: ${meetingId} (${fps}fps)`);

      // Start audio recording in the browser
      const audioPath = path.join(framesDir, 'audio.webm');
      console.log('[BotManager] Starting audio capture in browser...');

      const audioStarted = await page.evaluate(() => {
        return new Promise((resolve) => {
          try {
            // Create AudioContext and destination for mixing all audio
            const audioContext = new AudioContext();
            const destination = audioContext.createMediaStreamDestination();
            const connectedSources = new Set();

            // Function to connect an audio track to the mixer
            const connectAudioTrack = (track, label) => {
              const trackId = track.id || label;
              if (connectedSources.has(trackId)) return false;

              try {
                const stream = new MediaStream([track]);
                const source = audioContext.createMediaStreamSource(stream);
                source.connect(destination);
                connectedSources.add(trackId);
                console.log(`[RecorderBot] Connected audio track: ${label} (total: ${connectedSources.size})`);
                return true;
              } catch (e) {
                console.log(`[RecorderBot] Could not connect track ${label}:`, e.message);
                return false;
              }
            };

            // Function to scan for audio tracks from meetApp consumers
            // Audio tracks are stored in meetApp.consumers Map as { consumer: { track }, kind, peerId }
            const scanForAudio = () => {
              if (!window.meetApp) return;

              let foundNew = 0;

              // Scan consumers for audio tracks (this is where mediasoup stores remote audio)
              if (window.meetApp.consumers) {
                window.meetApp.consumers.forEach((data, consumerId) => {
                  if (data.kind === 'audio' && data.consumer && data.consumer.track) {
                    const track = data.consumer.track;
                    if (track.readyState === 'live') {
                      if (connectAudioTrack(track, `consumer-${consumerId}-${data.peerId}`)) {
                        foundNew++;
                      }
                    }
                  }
                });
              }

              // Also check for audio elements in the DOM (fallback)
              const audioElements = document.querySelectorAll('audio[data-producer-id]');
              audioElements.forEach(audio => {
                if (audio.srcObject) {
                  const tracks = audio.srcObject.getAudioTracks();
                  tracks.forEach(track => {
                    if (track.readyState === 'live') {
                      const producerId = audio.dataset.producerId;
                      if (connectAudioTrack(track, `audio-element-${producerId}`)) {
                        foundNew++;
                      }
                    }
                  });
                }
              });

              if (foundNew > 0) {
                console.log(`[RecorderBot] Scan found ${foundNew} new audio track(s), total: ${connectedSources.size}`);
              }
            };

            // Initial scan
            scanForAudio();

            // Set up periodic scanning for new audio tracks (every 1 second for faster detection)
            window._botAudioScanInterval = setInterval(scanForAudio, 1000);

            // Create MediaRecorder for audio
            window._botAudioRecorder = new MediaRecorder(destination.stream, {
              mimeType: 'audio/webm;codecs=opus',
              audioBitsPerSecond: 128000
            });

            window._botAudioChunks = [];

            window._botAudioRecorder.ondataavailable = (e) => {
              if (e.data.size > 0) {
                window._botAudioChunks.push(e.data);
              }
            };

            window._botAudioRecorder.start(1000); // Collect data every second
            console.log('[RecorderBot] Audio recording started (scanning consumers for audio tracks)');
            console.log('[RecorderBot] Initial connected sources:', connectedSources.size);

            // Store reference for debugging
            window._botAudioConnectedSources = connectedSources;
            window._botAudioContext = audioContext;
            window._botAudioDestination = destination;

            resolve(true);
          } catch (e) {
            console.error('[RecorderBot] Failed to start audio recording:', e.message);
            resolve(false);
          }
        });
      });

      console.log(`[BotManager] Audio capture started: ${audioStarted}`);

      // Set up max duration timeout
      const maxDurationMs = config.maxRecordingDuration * 60 * 1000;
      const maxDurationTimeout = setTimeout(async () => {
        console.log(`[BotManager] Max recording duration (${config.maxRecordingDuration} min) reached for meeting: ${meetingId}`);
        await this.stopRecording(meetingId);
      }, maxDurationMs);

      this.activeBots.set(meetingId, {
        browser,
        page,
        client,
        token,
        status: 'recording',
        startedAt: Date.now(),
        maxDurationTimeout,
        framesDir,
        frameCount: () => frameCount,
        timestamp,
        captureInterval,
        stopCapture: () => { captureActive = false; },
        fps
      });

      console.log(`[BotManager] Max duration timeout set: ${config.maxRecordingDuration} minutes`);

      return {
        success: true,
        meetingId,
        message: 'Recording started successfully',
        maxDuration: config.maxRecordingDuration
      };

    } catch (error) {
      console.error(`[BotManager] Error starting recording:`, error.message);
      return { error: error.message };
    }
  }

  /**
   * Stop recording and convert frames to video
   */
  async stopRecording(meetingId) {
    const bot = this.activeBots.get(meetingId);
    if (!bot) {
      return { error: 'No active recording for this meeting' };
    }

    // Guard against multiple concurrent stop calls
    if (bot.status === 'stopping') {
      console.log(`[BotManager] Recording already stopping for meeting: ${meetingId}`);
      return { error: 'Recording is already being stopped' };
    }

    // Mark as stopping immediately to prevent concurrent calls
    bot.status = 'stopping';

    // Clear max duration timeout
    if (bot.maxDurationTimeout) {
      clearTimeout(bot.maxDurationTimeout);
    }

    console.log(`[BotManager] Stopping recording for meeting: ${meetingId}`);

    try {
      // Stop frame capture
      if (bot.stopCapture) {
        bot.stopCapture();
      }
      if (bot.captureInterval) {
        clearInterval(bot.captureInterval);
        console.log('[BotManager] Frame capture stopped');
      }

      // Stop audio recording and get the audio data
      let audioData = null;
      const audioPath = path.join(bot.framesDir, 'audio.webm');
      try {
        audioData = await bot.page.evaluate(() => {
          return new Promise((resolve) => {
            // Clear the audio scan interval
            if (window._botAudioScanInterval) {
              clearInterval(window._botAudioScanInterval);
              window._botAudioScanInterval = null;
            }

            if (!window._botAudioRecorder) {
              console.log('[RecorderBot] No audio recorder found');
              resolve(null);
              return;
            }

            console.log('[RecorderBot] Stopping audio recorder, chunks:', window._botAudioChunks?.length || 0);

            window._botAudioRecorder.onstop = async () => {
              if (!window._botAudioChunks || window._botAudioChunks.length === 0) {
                console.log('[RecorderBot] No audio chunks recorded');
                resolve(null);
                return;
              }

              const blob = new Blob(window._botAudioChunks, { type: 'audio/webm' });
              const reader = new FileReader();
              reader.onloadend = () => {
                const base64 = reader.result.split(',')[1];
                console.log('[RecorderBot] Audio data ready, size:', blob.size, 'chunks:', window._botAudioChunks.length);
                resolve(base64);
              };
              reader.readAsDataURL(blob);
            };

            window._botAudioRecorder.stop();
          });
        });

        if (audioData) {
          fs.writeFileSync(audioPath, Buffer.from(audioData, 'base64'));
          console.log('[BotManager] Audio saved to:', audioPath);
        } else {
          console.log('[BotManager] No audio data captured');
        }
      } catch (e) {
        console.log('[BotManager] Error stopping audio recording:', e.message);
      }

      const totalFrames = bot.frameCount();
      console.log(`[BotManager] Total frames captured: ${totalFrames}`);

      if (totalFrames === 0) {
        throw new Error('No frames captured');
      }

      // Close browser immediately - we're done capturing
      await bot.browser.close();
      this.activeBots.delete(meetingId);

      // Convert frames to video (with audio if available)
      const outputFilename = `${meetingId}_${bot.timestamp}.webm`;
      const outputPath = path.join(this.recordingsDir, outputFilename);
      const hasAudio = audioData && fs.existsSync(audioPath);
      const framesDir = bot.framesDir;
      const recordingDuration = Date.now() - bot.startedAt;

      const actualFps = bot.fps || 10;
      console.log(`[BotManager] Starting background ffmpeg conversion of ${totalFrames} frames at ${actualFps}fps...`);

      // Run ffmpeg in background - don't await
      this.framesToVideoBackground(framesDir, outputPath, actualFps, hasAudio ? audioPath : null, totalFrames);

      // Return immediately with pending status
      return {
        success: true,
        meetingId,
        filename: outputFilename,
        filePath: outputPath,
        status: 'processing',
        message: 'Recording stopped. Video is being processed in background.',
        duration: recordingDuration,
        frameCount: totalFrames
      };

    } catch (error) {
      console.error(`[BotManager] Error stopping recording:`, error.message);

      // Try to close browser anyway
      try {
        await bot.browser.close();
      } catch (e) {}

      // Clean up frames if they exist
      if (bot.framesDir && fs.existsSync(bot.framesDir)) {
        try {
          fs.rmSync(bot.framesDir, { recursive: true, force: true });
        } catch (e) {}
      }

      this.activeBots.delete(meetingId);

      return { error: error.message };
    }
  }

  /**
   * Convert frames to video using ffmpeg (background, non-blocking)
   * Cleans up frames directory after conversion completes
   */
  framesToVideoBackground(framesDir, outputPath, fps, audioPath, frameCount) {
    const ffmpegPath = config.ffmpegPath || 'ffmpeg';
    // Use forward slashes for ffmpeg paths (works on all platforms)
    const inputPattern = path.join(framesDir, 'frame_%06d.jpg').replace(/\\/g, '/');
    const audioPathNorm = audioPath ? audioPath.replace(/\\/g, '/') : null;
    const outputPathNorm = outputPath.replace(/\\/g, '/');

    console.log(`[BotManager] Background ffmpeg starting...`);
    console.log(`[BotManager] Input: ${inputPattern} (${frameCount} frames)`);
    console.log(`[BotManager] Audio: ${audioPathNorm || 'none'}`);
    console.log(`[BotManager] Output: ${outputPathNorm}`);
    console.log(`[BotManager] FPS: ${fps}, frameCount: ${frameCount}`);

    // Verify frames exist before processing
    const firstFrame = path.join(framesDir, 'frame_000000.jpg');
    const lastFrameNum = String(frameCount - 1).padStart(6, '0');
    const lastFrame = path.join(framesDir, `frame_${lastFrameNum}.jpg`);
    console.log(`[BotManager] First frame exists: ${fs.existsSync(firstFrame)}`);
    console.log(`[BotManager] Last frame (${lastFrameNum}) exists: ${fs.existsSync(lastFrame)}`);

    // Calculate expected video duration from frame count and fps
    const videoDuration = frameCount / fps;
    console.log(`[BotManager] Expected video duration: ${videoDuration.toFixed(1)}s (${frameCount} frames at ${fps}fps)`);

    // Get audio duration if audio file exists
    let audioDuration = 0;
    if (audioPathNorm) {
      try {
        const { execSync } = require('child_process');
        const ffprobePath = ffmpegPath.replace('ffmpeg', 'ffprobe');
        const result = execSync(`"${ffprobePath}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`, { encoding: 'utf8' });
        audioDuration = parseFloat(result.trim()) || 0;
        console.log(`[BotManager] Audio duration: ${audioDuration.toFixed(1)}s`);
      } catch (e) {
        console.log(`[BotManager] Could not get audio duration: ${e.message}`);
      }
    }

    // Determine the target duration (use the longer of video or audio)
    const targetDuration = Math.max(videoDuration, audioDuration);
    console.log(`[BotManager] Target duration: ${targetDuration.toFixed(1)}s (video: ${videoDuration.toFixed(1)}s, audio: ${audioDuration.toFixed(1)}s)`);

    // Get the last frame path for looping if needed
    const lastFramePath = path.join(framesDir, `frame_${lastFrameNum}.jpg`).replace(/\\/g, '/');

    let args;
    if (audioPathNorm) {
      // With audio - merge video frames and audio
      // If audio is longer than video, we need to extend video to match audio
      if (audioDuration > videoDuration && fs.existsSync(lastFrame)) {
        // Audio is longer - create video from frames, then append looped last frame
        // Use a two-step approach: first create video from frames, then extend with last frame
        const extraDuration = audioDuration - videoDuration;
        console.log(`[BotManager] Audio is ${extraDuration.toFixed(1)}s longer than video, will extend with last frame`);

        // Use filter to pad video with last frame repeated
        args = [
          '-y',                          // Overwrite output
          '-framerate', String(fps),     // Input framerate for image sequence
          '-i', inputPattern,            // Input video frames
          '-loop', '1',                  // Loop the last frame input
          '-framerate', String(fps),     // Framerate for looped frame
          '-t', String(extraDuration.toFixed(2)), // Duration to loop
          '-i', lastFramePath,           // Last frame to loop
          '-i', audioPathNorm,           // Input audio (normalized path)
          '-filter_complex',
            `[0:v]fps=${fps}[v0];` +     // Normalize first video fps
            `[1:v]fps=${fps}[v1];` +     // Normalize looped frame fps
            `[v0][v1]concat=n=2:v=1:a=0[vout]`, // Concatenate video streams
          '-map', '[vout]',              // Use concatenated video
          '-map', '2:a',                 // Use audio (third input)
          '-c:v', 'libvpx',              // VP8 video codec
          '-b:v', '4M',                  // Video bitrate
          '-pix_fmt', 'yuv420p',         // Pixel format
          '-c:a', 'libvorbis',           // Audio codec for webm
          '-b:a', '128k',                // Audio bitrate
          outputPathNorm
        ];
      } else {
        // Video is longer or equal - pad audio to match video
        args = [
          '-y',                          // Overwrite output
          '-framerate', String(fps),     // Input framerate
          '-i', inputPattern,            // Input video frames
          '-i', audioPathNorm,           // Input audio (normalized path)
          '-c:v', 'libvpx',              // VP8 video codec
          '-b:v', '4M',                  // Video bitrate
          '-pix_fmt', 'yuv420p',         // Pixel format
          '-c:a', 'libvorbis',           // Audio codec for webm
          '-b:a', '128k',                // Audio bitrate
          '-filter_complex', `[1:a]apad=whole_dur=${videoDuration}[aout]`, // Pad audio to match video duration
          '-map', '0:v',                 // Use video from first input
          '-map', '[aout]',              // Use padded audio
          outputPathNorm
        ];
      }
    } else {
      // Video only
      args = [
        '-y',                          // Overwrite output
        '-framerate', String(fps),     // Input framerate
        '-i', inputPattern,            // Input pattern
        '-c:v', 'libvpx',              // VP8 codec
        '-b:v', '4M',                  // Bitrate
        '-pix_fmt', 'yuv420p',         // Pixel format
        outputPathNorm
      ];
    }

    console.log(`[BotManager] FFmpeg command: ${ffmpegPath} ${args.join(' ')}`);

    const startTime = Date.now();
    const ffmpeg = spawn(ffmpegPath, args);
    let stderrOutput = '';

    ffmpeg.stderr.on('data', (data) => {
      stderrOutput += data.toString();
    });

    ffmpeg.on('close', (code) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      if (code === 0) {
        try {
          const stats = fs.statSync(outputPath);
          console.log(`[BotManager] Background ffmpeg completed in ${elapsed}s`);
          console.log(`[BotManager] Recording saved: ${outputPath} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
          // Log ffmpeg output for debugging
          console.log(`[BotManager] FFmpeg output (last 1000 chars): ${stderrOutput.slice(-1000)}`);
        } catch (e) {
          console.log(`[BotManager] Background ffmpeg completed in ${elapsed}s`);
        }
      } else {
        console.error(`[BotManager] Background ffmpeg failed with code ${code} after ${elapsed}s`);
        console.error(`[BotManager] ffmpeg stderr: ${stderrOutput.slice(-2000)}`);
      }

      // Clean up frames directory after conversion (success or failure)
      try {
        fs.rmSync(framesDir, { recursive: true, force: true });
        console.log('[BotManager] Cleaned up frames directory');
      } catch (e) {
        console.log('[BotManager] Could not clean up frames:', e.message);
      }
    });

    ffmpeg.on('error', (err) => {
      console.error('[BotManager] Background ffmpeg error:', err.message);
      // Clean up frames on error too
      try {
        fs.rmSync(framesDir, { recursive: true, force: true });
      } catch (e) {}
    });

    // Log progress periodically (every 30 seconds)
    const progressInterval = setInterval(() => {
      if (ffmpeg.exitCode === null) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        console.log(`[BotManager] ffmpeg still processing... (${elapsed}s elapsed)`);
      } else {
        clearInterval(progressInterval);
      }
    }, 30000);

    ffmpeg.on('close', () => clearInterval(progressInterval));
  }

  /**
   * Convert frames to video using ffmpeg (blocking, for compatibility)
   * @param {string} framesDir - Directory containing frame images
   * @param {string} outputPath - Output video file path
   * @param {number} fps - Frames per second
   * @param {string|null} audioPath - Optional audio file to merge
   * @param {number} frameCount - Number of frames (for duration calculation)
   */
  framesToVideo(framesDir, outputPath, fps, audioPath = null, frameCount = 0) {
    return new Promise((resolve, reject) => {
      const ffmpegPath = config.ffmpegPath || 'ffmpeg';
      const inputPattern = path.join(framesDir, 'frame_%06d.jpg');

      console.log(`[BotManager] Running ffmpeg: ${ffmpegPath}`);
      console.log(`[BotManager] Input pattern: ${inputPattern}`);
      console.log(`[BotManager] Audio: ${audioPath || 'none'}`);
      console.log(`[BotManager] Output: ${outputPath}`);

      // Calculate expected video duration from frame count and fps
      const videoDuration = frameCount > 0 ? frameCount / fps : 0;

      let args;
      if (audioPath && videoDuration > 0) {
        // With audio - merge video frames and audio
        // Use video as the primary duration reference, pad audio if shorter
        args = [
          '-y',                          // Overwrite output
          '-framerate', String(fps),     // Input framerate
          '-i', inputPattern,            // Input video frames
          '-i', audioPath,               // Input audio
          '-c:v', 'libvpx',              // VP8 video codec
          '-b:v', '4M',                  // Video bitrate
          '-pix_fmt', 'yuv420p',         // Pixel format
          '-c:a', 'libvorbis',           // Audio codec for webm
          '-b:a', '128k',                // Audio bitrate
          '-filter_complex', `[1:a]apad=whole_dur=${videoDuration}[aout]`, // Pad audio to match video duration
          '-map', '0:v',                 // Use video from first input
          '-map', '[aout]',              // Use padded audio
          outputPath
        ];
      } else if (audioPath) {
        // Audio present but no frame count - use simple merge (less reliable)
        args = [
          '-y',                          // Overwrite output
          '-framerate', String(fps),     // Input framerate
          '-i', inputPattern,            // Input video frames
          '-i', audioPath,               // Input audio
          '-c:v', 'libvpx',              // VP8 video codec
          '-b:v', '4M',                  // Video bitrate
          '-pix_fmt', 'yuv420p',         // Pixel format
          '-c:a', 'libvorbis',           // Audio codec for webm
          '-b:a', '128k',                // Audio bitrate
          outputPath
        ];
      } else {
        // Video only
        args = [
          '-y',                          // Overwrite output
          '-framerate', String(fps),     // Input framerate
          '-i', inputPattern,            // Input pattern
          '-c:v', 'libvpx',              // VP8 codec
          '-b:v', '4M',                  // Bitrate
          '-pix_fmt', 'yuv420p',         // Pixel format
          outputPath
        ];
      }

      const ffmpeg = spawn(ffmpegPath, args);

      let stderr = '';

      ffmpeg.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          console.log('[BotManager] ffmpeg completed successfully');
          resolve();
        } else {
          console.error('[BotManager] ffmpeg failed with code:', code);
          console.error('[BotManager] ffmpeg stderr:', stderr);
          reject(new Error(`ffmpeg exited with code ${code}`));
        }
      });

      ffmpeg.on('error', (err) => {
        console.error('[BotManager] ffmpeg error:', err.message);
        reject(err);
      });
    });
  }

  /**
   * Get status of a recording
   */
  getStatus(meetingId) {
    const bot = this.activeBots.get(meetingId);
    if (!bot) {
      return { status: 'not_found' };
    }

    return {
      status: bot.status,
      startedAt: bot.startedAt,
      duration: Date.now() - bot.startedAt,
      frameCount: bot.frameCount ? bot.frameCount() : 0
    };
  }

  /**
   * Get all active recordings
   */
  getAllActive() {
    const active = [];
    for (const [meetingId, bot] of this.activeBots) {
      active.push({
        meetingId,
        status: bot.status,
        startedAt: bot.startedAt,
        duration: Date.now() - bot.startedAt,
        frameCount: bot.frameCount ? bot.frameCount() : 0
      });
    }
    return active;
  }

  /**
   * Force stop all recordings (for shutdown)
   */
  async stopAll() {
    console.log(`[BotManager] Stopping all ${this.activeBots.size} active recordings`);

    const promises = [];
    for (const meetingId of this.activeBots.keys()) {
      promises.push(this.stopRecording(meetingId));
    }

    await Promise.allSettled(promises);
  }
}

module.exports = BotManager;
