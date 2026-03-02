// ═══════════════════════════════════════════════════════════════════════════
// backend/app.js – PROXY ROUTE with VIDEO + AUDIO transcoding
// ═══════════════════════════════════════════════════════════════════════════

const axios = require('axios');
const crypto = require('crypto');
const ffmpeg = require('ffmpeg-static');
const { spawn } = require('child_process'); // For FFmpeg
const os = require('os');
const path = require('path');

// FFmpeg path (installed via chocolatey)
const FFMPEG_PATH = 'C:\\ProgramData\\chocolatey\\lib\\ffmpeg\\tools\\ffmpeg.exe';

// ★★★ Track active connections ★★★
const activeConnections = new Map(); // key: `${mac}_${channelId}` -> { stream, res, timestamp, ffmpeg }

// ★ Track URLs currently being fetched ★
const fetchingUrls = new Set();

const XTREAM_USER_AGENTS = [
  'VLC/3.0.18 LibVLC/3.0.18',
  'OTT Navigator/1.6.7 (Linux; Android 10)',
  'ExoPlayer/2.18.1 (Linux; Android 10) ExoPlayerLib/2.18.1',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'AppleCoreMedia/1.0.0.20L154 (Apple TV; U; CPU OS 14_0 like Mac OS X; en_us)',
];

// ============================================================
// FORMAT MAPPINGS
// ============================================================

// Video formats with codec info
const VIDEO_FORMATS = {
  // Hardware-accelerated formats (use device GPU)
  'h264': { 
    codec: 'h264', 
    encoder: 'h264_amf',      // AMD GPU
    encoderNvidia: 'h264_nvenc', // NVIDIA GPU
    encoderIntel: 'h264_qsv',    // Intel GPU
    encoderSoftware: 'libx264',  // Software fallback
    mime: 'video/H264', 
    ext: '264',
    pixelFormat: 'yuv420p'
  },
  'h265': { 
    codec: 'hevc', 
    encoder: 'hevc_amf',       // AMD GPU
    encoderNvidia: 'hevc_nvenc', // NVIDIA GPU
    encoderIntel: 'hevc_qsv',     // Intel GPU
    encoderSoftware: 'libx265',   // Software fallback
    mime: 'video/H265', 
    ext: '265',
    pixelFormat: 'yuv420p'
  },
  'vp9': { 
    codec: 'vp9', 
    encoder: 'vp9_vaapi',      // GPU via VAAPI
    encoderSoftware: 'libvpx-vp9', // Software
    mime: 'video/webm', 
    ext: 'webm',
    pixelFormat: 'yuv420p'
  },
  'mpeg4': { 
    codec: 'mpeg4', 
    encoder: 'mpeg4', 
    mime: 'video/mp4', 
    ext: 'mp4',
    pixelFormat: 'yuv420p'
  },
  'copy': { codec: 'copy', mime: 'video/mp2t', ext: 'ts' } // Passthrough
};

// Audio formats with codec info
const AUDIO_FORMATS = {
  'aac': { 
    codec: 'aac', 
    encoder: 'aac', 
    mime: 'audio/aac', 
    ext: 'aac',
    bitrate: '128k'
  },
  'mp3': { 
    codec: 'libmp3lame', 
    encoder: 'libmp3lame', 
    mime: 'audio/mpeg', 
    ext: 'mp3',
    bitrate: '128k'
  },
  'ac3': { 
    codec: 'ac3', 
    encoder: 'ac3', 
    mime: 'audio/ac3', 
    ext: 'ac3',
    bitrate: '192k'
  },
  'eac3': { 
    codec: 'eac3', 
    encoder: 'eac3', 
    mime: 'audio/eac3', 
    ext: 'eac3',
    bitrate: '256k'
  },
  'opus': { 
    codec: 'libopus', 
    encoder: 'libopus', 
    mime: 'audio/opus', 
    ext: 'opus',
    bitrate: '96k'
  },
  'pcm_s16le': { 
    codec: 'pcm_s16le', 
    encoder: 'pcm_s16le', 
    mime: 'audio/wav', 
    ext: 'wav',
    bitrate: '1536k'
  },
  'copy': { codec: 'copy', mime: 'audio/mp2t', ext: 'ts' } // Passthrough
};

// Container formats
const CONTAINER_FORMATS = {
  'ts': { mime: 'video/mp2t', ext: 'ts' },
  'mp4': { mime: 'video/mp4', ext: 'mp4' },
  'mkv': { mime: 'video/x-matroska', ext: 'mkv' },
  'webm': { mime: 'video/webm', ext: 'webm' },
};

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function isXtreamUrl(url) {
  if (!url) return false;
  const base = url.split('?')[0];
  const m = base.match(/^https?:\/\/[^/]+(\/.*)?$/);
  if (!m) return false;
  const parts = (m[1] || '').split('/').filter(Boolean);
  if (parts.length === 4 && parts[0] === 'live') return true;
  if (parts.length === 3) {
    const last = parts[parts.length - 1] || '';
    return /^\d+(\.(ts|m3u8|mp4))?$/i.test(last);
  }
  return false;
}

// Detect best available hardware encoder
function getBestVideoEncoder(requestedFormat) {
  const format = VIDEO_FORMATS[requestedFormat] || VIDEO_FORMATS['h264'];
  const platform = os.platform();
  
  // Check for NVIDIA GPU
  if (format.encoderNvidia) {
    try {
      const { execSync } = require('child_process');
      execSync('nvidia-smi', { stdio: 'ignore' });
      console.log(`✅ NVIDIA GPU detected, using ${format.encoderNvidia}`);
      return format.encoderNvidia;
    } catch (e) {
      // No NVIDIA
    }
  }
  
  // Check for AMD GPU (Windows)
  if (platform === 'win32' && format.encoder) {
    console.log(`💻 Windows detected, trying ${format.encoder}`);
    return format.encoder;
  }
  
  // Check for Intel QSV (Quick Sync)
  if (format.encoderIntel) {
    console.log(`🖥️ Trying Intel QSV: ${format.encoderIntel}`);
    return format.encoderIntel;
  }
  
  // Fallback to software
  console.log(`⚠️ Using software encoder: ${format.encoderSoftware || 'libx264'}`);
  return format.encoderSoftware || 'libx264';
}

// ============================================================
// STREAM KILL FUNCTION
// ============================================================

function killStream(mac, channelId) {
  const key = `${mac}_${channelId}`;
  if (activeConnections.has(key)) {
    const conn = activeConnections.get(key);
    console.log(`🪓 Force killing stream for MAC: ${mac}, Channel: ${channelId}`);

    // Kill FFmpeg process if it exists
    if (conn.ffmpeg) {
      try {
        conn.ffmpeg.kill('SIGTERM');
        console.log('✅ FFmpeg process killed');
      } catch (e) {
        console.log('⚠️ Error killing FFmpeg:', e.message);
      }
    }

    // Destroy the incoming stream
    if (conn.stream && typeof conn.stream.destroy === 'function') {
      try {
        conn.stream.destroy();
      } catch (e) {
        console.log('⚠️ Error destroying stream:', e.message);
      }
    }

    // End response
    if (conn.res && !conn.res.writableEnded) {
      try {
        conn.res.end();
      } catch (e) {}
    }

    activeConnections.delete(key);
    console.log(`✅ Stream killed for ${key}`);
    return true;
  }
  return false;
}

// ============================================================
// KILL ENDPOINT
// ============================================================

app.delete('/api/proxy/stream/:mac/:channelId', (req, res) => {
  const { mac, channelId } = req.params;
  console.log(`🔫 Kill request received for MAC: ${mac}, Channel: ${channelId}`);

  const killed = killStream(mac, channelId);

  res.json({
    success: killed,
    message: killed ? 'Stream terminated' : 'Stream not found'
  });
});

// ============================================================
// MAIN PROXY ENDPOINT with FULL VIDEO + AUDIO TRANSCODING
// ============================================================

app.get('/api/proxy/stream', async (req, res) => {
  try {
    let { 
      url, 
      mac, 
      type, 
      ua_index, 
      channelId,
      videoFormat = 'copy',      // h264, h265, vp9, mpeg4, copy
      audioFormat = 'copy',      // aac, mp3, ac3, eac3, opus, pcm_s16le, copy
      container = 'ts',          // ts, mp4, mkv, webm
      videoBitrate = '2000k',    // Video bitrate
      audioBitrate = '128k',     // Audio bitrate
      resolution = 'original',   // width:height or 'original'
      fps = 'original',          // FPS or 'original'
    } = req.query;
    
    if (!url) return res.status(400).json({ error: 'URL is required' });
    if (!channelId) {
      const match = decodeURIComponent(url).match(/stream=(\d+)/) || decodeURIComponent(url).match(/\/(\d+)(?:\.ts)?$/);
      channelId = match ? match[1] : 'unknown';
    }

    let decodedUrl = decodeURIComponent(url);
    const originalUrl = decodedUrl;

    // Validate formats
    if (!VIDEO_FORMATS[videoFormat]) {
      console.log(`⚠️ Unknown video format: ${videoFormat}, using copy`);
      videoFormat = 'copy';
    }
    
    if (!AUDIO_FORMATS[audioFormat]) {
      console.log(`⚠️ Unknown audio format: ${audioFormat}, using copy`);
      audioFormat = 'copy';
    }
    
    if (!CONTAINER_FORMATS[container]) {
      console.log(`⚠️ Unknown container: ${container}, using ts`);
      container = 'ts';
    }

    console.log(`🎬 Requested formats:`);
    console.log(`   Video: ${videoFormat}, Audio: ${audioFormat}, Container: ${container}`);

    // Kill any existing stream
    if (mac && channelId !== 'unknown') {
      killStream(mac, channelId);
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    // Block duplicate requests
    const urlKey = decodedUrl.split('?')[0] + (decodedUrl.match(/[?&](stream|play_token)=[^&]+/g) || []).join('');
    if (fetchingUrls.has(urlKey)) {
      console.log(`🚫 Duplicate request blocked`);
      return res.status(429).json({ error: 'Duplicate stream request' });
    }
    fetchingUrls.add(urlKey);
    setTimeout(() => fetchingUrls.delete(urlKey), 3000);

    const streamType = type || (isXtreamUrl(decodedUrl) ? 'xtream' : 'mag');
    const uaIndex = parseInt(ua_index) || 0;
    const userAgent = XTREAM_USER_AGENTS[uaIndex] || XTREAM_USER_AGENTS[0];

    console.log(`🔌 Proxying stream for MAC: ${mac || 'unknown'}, Channel: ${channelId}`);
    console.log(`   URL: ${decodedUrl.substring(0, 100)}...`);

    // Build headers
    let headers;
    if (streamType === 'xtream') {
      if (!decodedUrl.includes('.ts') && !decodedUrl.includes('.m3u8') && !decodedUrl.includes('.mp4')) {
        const lastSegment = decodedUrl.split('/').pop() || '';
        if (/^\d+$/.test(lastSegment)) {
          decodedUrl = decodedUrl + '.ts';
        }
      }
      headers = {
        'User-Agent': userAgent,
        'Accept': 'video/mp2t, video/quicktime, video/*, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        'Connection': 'close',
        'Referer': decodedUrl.substring(0, decodedUrl.indexOf('/', 8)) + '/',
        'Origin': decodedUrl.substring(0, decodedUrl.indexOf('/', 8)),
      };
    } else {
      const macAddress = mac || '00:1A:79:00:00:00';
      headers = {
        'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
        'X-User-Agent': 'Model: MAG250; Link: WiFi',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        'Connection': 'close',
        'Cookie': `mac=${macAddress}; stb_lang=en; timezone=GMT`,
      };
      try {
        const u = new URL(decodedUrl);
        headers['Referer'] = `${u.protocol}//${u.host}/c/`;
      } catch (_) {}
    }

    if (req.headers.range) {
      headers['Range'] = req.headers.range;
      console.log('   Range:', req.headers.range);
    }

    // Fetch source stream
    let response;
    try {
      response = await axios({
        method: 'GET',
        url: decodedUrl,
        headers,
        responseType: 'stream',
        timeout: 30000,
        validateStatus: (status) => status < 500,
        maxRedirects: 5,
      });
    } catch (err) {
      fetchingUrls.delete(urlKey);
      
      // Try alternate format if 404
      if (streamType === 'xtream' && err.response?.status === 404) {
        console.log('   Primary URL 404, trying alternate...');
        const pathMatch = originalUrl.match(/^(https?:\/\/[^/]+)(\/[^/]+\/[^/]+\/\d+)(\.ts)?$/);
        if (pathMatch) {
          const base = pathMatch[1];
          const path = pathMatch[2];
          const cleanPath = path.replace(/\.ts$/, '');
          const altUrl = base + '/live' + cleanPath + '.ts';
          try {
            response = await axios({
              method: 'GET',
              url: altUrl,
              headers,
              responseType: 'stream',
              timeout: 30000,
            });
          } catch (altErr) {
            throw err;
          }
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }

    console.log('✅ Source stream connected:', response.status, response.headers['content-type']);
    fetchingUrls.delete(urlKey);

    const connectionKey = `${mac}_${channelId}`;

    // ============================================================
    // TRANSCODING SECTION (if requested)
    // ============================================================
    if (videoFormat !== 'copy' || audioFormat !== 'copy') {
      console.log(`🎬 Starting FFmpeg transcoding...`);
      
      const videoInfo = VIDEO_FORMATS[videoFormat] || VIDEO_FORMATS['h264'];
      const audioInfo = AUDIO_FORMATS[audioFormat] || AUDIO_FORMATS['aac'];
      const containerInfo = CONTAINER_FORMATS[container];
      
      // Get best available video encoder
      const videoEncoder = getBestVideoEncoder(videoFormat);
      
      // Build FFmpeg arguments
      let ffmpegArgs = [
        '-i', 'pipe:0',                    // Input from stdin
        '-c:v', videoEncoder,               // Video codec
        '-c:a', audioInfo.encoder,          // Audio codec
      ];
      
      // Video bitrate
      if (videoBitrate !== 'original') {
        ffmpegArgs.push('-b:v', videoBitrate);
      }
      
      // Audio bitrate
      if (audioBitrate !== 'original') {
        ffmpegArgs.push('-b:a', audioInfo.bitrate || audioBitrate);
      }
      
      // Resolution scaling
      if (resolution !== 'original') {
        ffmpegArgs.push('-vf', `scale=${resolution}:force_original_aspect_ratio=decrease`);
      }
      
      // FPS control
      if (fps !== 'original') {
        ffmpegArgs.push('-r', fps);
      }
      
      // Pixel format
      if (videoInfo.pixelFormat) {
        ffmpegArgs.push('-pix_fmt', videoInfo.pixelFormat);
      }
      
      // Additional quality settings
      ffmpegArgs.push(
        '-preset', 'veryfast',               // Fast encoding
        '-threads', '4',                      // Use 4 CPU threads
        '-movflags', '+faststart',            // Fast start for streaming
        '-f', container,                      // Output container
        '-loglevel', 'error',                  // Only show errors
        'pipe:1'                                // Output to stdout
      );

      console.log(`🎬 FFmpeg args: ${ffmpegArgs.join(' ')}`);

      // Spawn FFmpeg
      const ffmpeg = spawn('ffmpeg', ffmpegArgs);
      
      // Pipe source to FFmpeg
      response.data.pipe(ffmpeg.stdin);

      // Set response headers
      res.set({
        'Content-Type': containerInfo.mime,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Access-Control-Allow-Origin': '*',
        'X-Video-Format': videoFormat,
        'X-Audio-Format': audioFormat,
        'X-Container': container,
        'X-Transcoded': 'true',
        'Connection': 'close',
      });

      // Pipe FFmpeg output to response
      ffmpeg.stdout.pipe(res);

      // Store connection
      activeConnections.set(connectionKey, {
        stream: response.data,
        ffmpeg: ffmpeg,
        res: res,
        timestamp: Date.now(),
        url: decodedUrl,
        mac: mac,
        channelId: channelId,
        transcoded: true,
        videoFormat,
        audioFormat
      });

      // Handle FFmpeg errors
      ffmpeg.stderr.on('data', (data) => {
        const msg = data.toString();
        if (!msg.includes('kb/s')) { // Filter out bitrate logs
          console.log(`🎬 FFmpeg: ${msg}`);
        }
      });

      ffmpeg.on('error', (err) => {
        console.error('❌ FFmpeg error:', err.message);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Transcoding failed' });
        }
      });

      ffmpeg.on('close', (code) => {
        console.log(`🎬 FFmpeg closed with code ${code} for ${connectionKey}`);
        activeConnections.delete(connectionKey);
      });

      ffmpeg.stdout.on('end', () => {
        console.log(`✅ Transcoded stream ended for ${connectionKey}`);
        activeConnections.delete(connectionKey);
      });

    } else {
      // ============================================================
      // PASSTHROUGH MODE (no transcoding)
      // ============================================================
      console.log(`📦 Direct passthrough for ${connectionKey}`);
      
      const responseHeaders = {
        'Content-Type': response.headers['content-type'] || 'video/mp2t',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Range',
        'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
        'Accept-Ranges': 'bytes',
        'Connection': 'close',
      };
      
      if (response.status === 206) {
        res.status(206);
        responseHeaders['Content-Range'] = response.headers['content-range'];
      }
      if (response.headers['content-length']) {
        responseHeaders['Content-Length'] = response.headers['content-length'];
      }
      
      res.set(responseHeaders);
      response.data.pipe(res);

      activeConnections.set(connectionKey, {
        stream: response.data,
        res: res,
        timestamp: Date.now(),
        url: decodedUrl,
        mac: mac,
        channelId: channelId,
        transcoded: false
      });

      response.data.on('end', () => {
        console.log(`✅ Stream ended for ${connectionKey}`);
        activeConnections.delete(connectionKey);
      });

      response.data.on('error', (err) => {
        console.error(`❌ Stream error for ${connectionKey}:`, err.message);
        activeConnections.delete(connectionKey);
        if (!res.headersSent) res.status(500).json({ error: 'Streaming failed' });
      });
    }

  } catch (error) {
    console.error('❌ Proxy error:', {
      message: error.message,
      code: error.code,
      status: error.response?.status,
    });
    if (!res.headersSent) {
      let status = 500;
      let message = 'Streaming failed';
      if (error.response?.status === 401) status = 401;
      else if (error.response?.status === 403) status = 403;
      else if (error.response?.status === 404) status = 404;
      else if (error.code === 'ECONNRESET') status = 502;
      
      res.status(status).json({ error: message });
    }
  }
});

// ============================================================
// OPTIONS HANDLER
// ============================================================
app.options('/api/proxy/stream', (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type',
    'Access-Control-Max-Age': '86400',
  });
  res.sendStatus(204);
});

// ============================================================
// CLEANUP INTERVAL
// ============================================================
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, conn] of activeConnections.entries()) {
    if (now - conn.timestamp > 5 * 60 * 1000) {
      console.log(`🧹 Cleaning stale connection for ${key}`);
      
      if (conn.ffmpeg) {
        try { conn.ffmpeg.kill('SIGTERM'); } catch (e) {}
      }
      
      if (conn.stream && typeof conn.stream.destroy === 'function') {
        try { conn.stream.destroy(); } catch (e) {}
      }
      if (conn.res && !conn.res.writableEnded) {
        try { conn.res.end(); } catch (e) {}
      }
      activeConnections.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`✅ Cleaned ${cleaned} stale connections`);
  }
}, 60 * 1000);