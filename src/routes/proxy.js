// ═══════════════════════════════════════════════════════════════════════════
// backend/proxy.js – PROXY ROUTE with VIDEO + AUDIO transcoding
// KEY FIX: H.264 now forces baseline profile + level 3.1 via libx264
// ADDED: MPEG2 support for maximum compatibility
// ═══════════════════════════════════════════════════════════════════════════

const axios = require('axios');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');
const os = require('os');
const fs = require('fs');

// ─── FFMPEG PATH ──────────────────────────────────────────────────────────────
// Try known Windows paths first, then fall back to PATH
const FFMPEG_CANDIDATES = [
  'C:\\ProgramData\\chocolatey\\lib\\ffmpeg\\tools\\ffmpeg\\bin\\ffmpeg.exe',
  'C:\\ProgramData\\chocolatey\\lib\\ffmpeg\\tools\\ffmpeg.exe',
  'C:\\ProgramData\\chocolatey\\lib\\ffmpeg-full\\tools\\ffmpeg.exe',
  'C:\\ffmpeg\\bin\\ffmpeg.exe',
  'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
];

let FFMPEG_BIN = 'ffmpeg';
for (const candidate of FFMPEG_CANDIDATES) {
  if (fs.existsSync(candidate)) {
    FFMPEG_BIN = candidate;
    break;
  }
}

// Verify ffmpeg works at startup and log the version
try {
  const version = execSync(`"${FFMPEG_BIN}" -version 2>&1`, { timeout: 5000 }).toString().split('\n')[0];
  console.log(`✅ FFmpeg found: ${FFMPEG_BIN}`);
  console.log(`   ${version}`);
} catch (e) {
  console.error(`❌ FFMPEG NOT FOUND at "${FFMPEG_BIN}" — transcoding will fail!`);
  console.error(`   Install FFmpeg: choco install ffmpeg  OR  set FFMPEG_BIN manually`);
}

// ★★★ Track active connections ★★★
const activeConnections = new Map();
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

const VIDEO_FORMATS = {
  // ★ H.264 BASELINE — THE FIX FOR QUALCOMM GREEN SCREEN ★
  'h264': {
    codec: 'h264',
    encoder: 'libx264',
    mime: 'video/mp2t',
    ext: 'ts',
    pixelFormat: 'yuv420p',
    extraArgs: [
      '-profile:v', 'baseline',
      '-level', '3.1',
      '-g', '50',
      '-sc_threshold', '0',
      '-x264opts', 'no-scenecut',
    ],
  },
  'h265': {
    codec: 'hevc',
    encoder: 'libx265',
    mime: 'video/mp2t',
    ext: 'ts',
    pixelFormat: 'yuv420p',
    extraArgs: ['-preset', 'veryfast'],
  },
  'mpeg4': {
    codec: 'mpeg4',
    encoder: 'mpeg4',
    mime: 'video/mp2t',
    ext: 'ts',
    pixelFormat: 'yuv420p',
    extraArgs: [],
  },
  // ★★★ MPEG2 — MOST COMPATIBLE, WORKS ON EVERY DEVICE ★★★
  'mpeg2': {
    codec: 'mpeg2video',
    encoder: 'mpeg2video',
    mime: 'video/mp2t',
    ext: 'ts',
    pixelFormat: 'yuv420p',
    extraArgs: [
      '-b:v', '2000k',
      '-maxrate', '2500k',
      '-bufsize', '4000k',
      '-g', '25',
      '-q:v', '5',
    ],
  },
  'copy': {
    codec: 'copy',
    mime: 'video/mp2t',
    ext: 'ts',
    extraArgs: [],
  },
};

const AUDIO_FORMATS = {
  'aac':      { encoder: 'aac',        bitrate: '128k', mime: 'audio/aac' },
  'mp3':      { encoder: 'libmp3lame', bitrate: '128k', mime: 'audio/mpeg' },
  'ac3':      { encoder: 'ac3',        bitrate: '192k', mime: 'audio/ac3' },
  'eac3':     { encoder: 'eac3',       bitrate: '256k', mime: 'audio/eac3' },
  'opus':     { encoder: 'libopus',    bitrate: '96k',  mime: 'audio/opus' },
  'copy':     { encoder: 'copy',       bitrate: null,   mime: 'audio/mp2t' },
};

const CONTAINER_FORMATS = {
  'ts':   { mime: 'video/mp2t',        ext: 'ts' },
  'mp4':  { mime: 'video/mp4',         ext: 'mp4' },
  'mkv':  { mime: 'video/x-matroska', ext: 'mkv' },
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

// ============================================================
// STREAM KILL FUNCTION
// ============================================================

function killStream(mac, channelId) {
  const key = `${mac}_${channelId}`;
  if (activeConnections.has(key)) {
    const conn = activeConnections.get(key);
    console.log(`🪓 Force killing stream for MAC: ${mac}, Channel: ${channelId}`);
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
  const killed = killStream(mac, channelId);
  res.json({ success: killed, message: killed ? 'Stream terminated' : 'Stream not found' });
});

// ============================================================
// MAIN PROXY ENDPOINT
// ============================================================

app.get('/api/proxy/stream', async (req, res) => {
  try {
    let {
      url,
      mac,
      type,
      ua_index,
      channelId,
      videoFormat = 'copy',
      audioFormat = 'copy',
      container   = 'ts',
      videoBitrate = '2000k',
      audioBitrate = '128k',
      resolution   = 'original',
      fps          = 'original',
    } = req.query;

    if (!url) return res.status(400).json({ error: 'URL is required' });

    if (!channelId) {
      const match = decodeURIComponent(url).match(/stream=(\d+)/) || decodeURIComponent(url).match(/\/(\d+)(?:\.ts)?$/);
      channelId = match ? match[1] : 'unknown';
    }

    let decodedUrl = decodeURIComponent(url);
    const originalUrl = decodedUrl;

    // Validate formats — fall back to copy if unknown
    if (!VIDEO_FORMATS[videoFormat])   videoFormat = 'copy';
    if (!AUDIO_FORMATS[audioFormat])   audioFormat = 'copy';
    if (!CONTAINER_FORMATS[container]) container   = 'ts';

    console.log(`🎬 Stream request: video=${videoFormat} audio=${audioFormat} container=${container}`);

    // Kill any existing stream for this channel
    if (mac && channelId !== 'unknown') {
      killStream(mac, channelId);
      await new Promise(r => setTimeout(r, 200));
    }

    // Block exact duplicate requests
    const urlKey = decodedUrl.split('?')[0] + (decodedUrl.match(/[?&](stream|play_token)=[^&]+/g) || []).join('');
    if (fetchingUrls.has(urlKey)) {
      console.log(`🚫 Duplicate request blocked`);
      return res.status(429).json({ error: 'Duplicate stream request' });
    }
    fetchingUrls.add(urlKey);
    setTimeout(() => fetchingUrls.delete(urlKey), 3000);

    const streamType = type || (isXtreamUrl(decodedUrl) ? 'xtream' : 'mag');
    const uaIndex    = parseInt(ua_index) || 0;
    const userAgent  = XTREAM_USER_AGENTS[uaIndex] || XTREAM_USER_AGENTS[0];

    console.log(`🔌 Proxying: MAC=${mac || 'unknown'} Channel=${channelId}`);

    // Build request headers
    let headers;
    if (streamType === 'xtream') {
      if (!decodedUrl.includes('.ts') && !decodedUrl.includes('.m3u8') && !decodedUrl.includes('.mp4')) {
        const lastSegment = decodedUrl.split('/').pop() || '';
        if (/^\d+$/.test(lastSegment)) decodedUrl = decodedUrl + '.ts';
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

    if (req.headers.range) headers['Range'] = req.headers.range;

    // Fetch source stream
    let response;
    try {
      response = await axios({
        method: 'GET',
        url: decodedUrl,
        headers,
        responseType: 'stream',
        timeout: 30000,
        validateStatus: (s) => s < 500,
        maxRedirects: 5,
      });
    } catch (err) {
      fetchingUrls.delete(urlKey);
      if (streamType === 'xtream' && err.response?.status === 404) {
        const pathMatch = originalUrl.match(/^(https?:\/\/[^/]+)(\/[^/]+\/[^/]+\/\d+)(\.ts)?$/);
        if (pathMatch) {
          const altUrl = pathMatch[1] + '/live' + pathMatch[2].replace(/\.ts$/, '') + '.ts';
          try {
            response = await axios({ method: 'GET', url: altUrl, headers, responseType: 'stream', timeout: 30000 });
          } catch (altErr) { throw err; }
        } else { throw err; }
      } else { throw err; }
    }

    console.log(`✅ Source connected: ${response.status} ${response.headers['content-type']}`);
    fetchingUrls.delete(urlKey);

    const connectionKey = `${mac}_${channelId}`;
    const needsTranscode = videoFormat !== 'copy' || audioFormat !== 'copy';

    // ============================================================
    // TRANSCODING PATH
    // ============================================================
    if (needsTranscode) {
      const videoInfo    = VIDEO_FORMATS[videoFormat];
      const audioInfo    = AUDIO_FORMATS[audioFormat];
      const containerInfo = CONTAINER_FORMATS[container] || CONTAINER_FORMATS['ts'];

      console.log(`🎬 FFmpeg transcoding: ${videoFormat} / ${audioFormat} → ${container}`);

      // ── BUILD FFMPEG ARGS ─────────────────────────────────────────────────
      const ffmpegArgs = [
        '-loglevel', 'warning',
        '-i', 'pipe:0',
        '-c:v', videoInfo.encoder,
      ];

      if (videoInfo.extraArgs && videoInfo.extraArgs.length > 0) {
        ffmpegArgs.push(...videoInfo.extraArgs);
      }

      if (videoInfo.pixelFormat) {
        ffmpegArgs.push('-pix_fmt', videoInfo.pixelFormat);
      }

      if (videoFormat !== 'copy' && videoBitrate && videoBitrate !== 'original') {
        ffmpegArgs.push('-b:v', videoBitrate, '-maxrate', videoBitrate, '-bufsize', String(parseInt(videoBitrate) * 2) + 'k');
      }

      if (resolution && resolution !== 'original') {
        ffmpegArgs.push('-vf', `scale=${resolution}:force_original_aspect_ratio=decrease`);
      }

      if (fps && fps !== 'original') {
        ffmpegArgs.push('-r', fps);
      }

      if (videoFormat !== 'copy' && videoInfo.encoder === 'libx264') {
        ffmpegArgs.push('-preset', 'veryfast', '-tune', 'zerolatency');
      } else if (videoFormat !== 'copy' && videoInfo.encoder === 'libx265') {
        ffmpegArgs.push('-preset', 'veryfast', '-tune', 'zerolatency');
      }

      ffmpegArgs.push('-c:a', audioInfo.encoder);
      if (audioFormat !== 'copy' && audioInfo.bitrate) {
        ffmpegArgs.push('-b:a', audioInfo.bitrate);
      }

      ffmpegArgs.push(
        '-f', container,
        '-movflags', '+faststart',
        'pipe:1',
      );

      console.log(`🎬 FFmpeg binary: ${FFMPEG_BIN}`);
      console.log(`🎬 FFmpeg args: ${ffmpegArgs.join(' ')}`);

      const ffmpegProc = spawn(FFMPEG_BIN, ffmpegArgs);
      response.data.pipe(ffmpegProc.stdin);

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

      ffmpegProc.stdout.pipe(res);

      activeConnections.set(connectionKey, {
        stream: response.data,
        ffmpeg: ffmpegProc,
        res, timestamp: Date.now(),
        url: decodedUrl, mac, channelId,
        transcoded: true, videoFormat, audioFormat,
      });

      ffmpegProc.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) console.log(`🎬 FFmpeg: ${msg}`);
      });

      ffmpegProc.stdin.on('error', (err) => {
        if (err.code !== 'EPIPE') console.error('FFmpeg stdin error:', err.message);
      });

      ffmpegProc.on('error', (err) => {
        console.error('❌ FFmpeg spawn error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'Transcoding failed' });
      });

      ffmpegProc.on('close', (code) => {
        console.log(`🎬 FFmpeg closed (code ${code}) for ${connectionKey}`);
        activeConnections.delete(connectionKey);
      });

      res.on('close', () => {
        try { ffmpegProc.kill('SIGTERM'); } catch (_) {}
        try { response.data.destroy(); } catch (_) {}
        activeConnections.delete(connectionKey);
      });

    } else {
      // ============================================================
      // PASSTHROUGH PATH
      // ============================================================
      console.log(`📦 Passthrough for ${connectionKey}`);

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
        stream: response.data, res,
        timestamp: Date.now(), url: decodedUrl,
        mac, channelId, transcoded: false,
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

      res.on('close', () => {
        try { response.data.destroy(); } catch (_) {}
        activeConnections.delete(connectionKey);
      });
    }

  } catch (error) {
    console.error('❌ Proxy error:', error.message);
    if (!res.headersSent) {
      const status =
        error.response?.status === 401 ? 401 :
        error.response?.status === 403 ? 403 :
        error.response?.status === 404 ? 404 :
        error.code === 'ECONNRESET'     ? 502 : 500;
      res.status(status).json({ error: 'Streaming failed' });
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
      if (conn.ffmpeg) { try { conn.ffmpeg.kill('SIGTERM'); } catch (_) {} }
      if (conn.stream) { try { conn.stream.destroy(); } catch (_) {} }
      if (conn.res && !conn.res.writableEnded) { try { conn.res.end(); } catch (_) {} }
      activeConnections.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) console.log(`🧹 Cleaned ${cleaned} stale connections`);
}, 60 * 1000);