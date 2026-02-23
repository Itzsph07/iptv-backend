// ═══════════════════════════════════════════════════════════════════════════
// backend/app.js – PROXY ROUTE with connection tracking and FORCE KILL
// ═══════════════════════════════════════════════════════════════════════════

const axios = require('axios');
const crypto = require('crypto');

// ★★★ Track active connections by a unique ID for precise killing ★★★
const activeConnections = new Map(); // key: `${mac}_${channelId}` -> { stream, res, timestamp }

// ★ Track URLs currently being fetched — blocks duplicate simultaneous requests
// (ExoPlayer sends 2 rapid requests for the same URL; the second would cause 458/401)
const fetchingUrls = new Set();

const XTREAM_USER_AGENTS = [
  'VLC/3.0.18 LibVLC/3.0.18',
  'OTT Navigator/1.6.7 (Linux; Android 10)',
  'ExoPlayer/2.18.1 (Linux; Android 10) ExoPlayerLib/2.18.1',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'AppleCoreMedia/1.0.0.20L154 (Apple TV; U; CPU OS 14_0 like Mac OS X; en_us)',
];

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

async function attemptFetch(url, headers) {
  return await axios({
    method: 'GET',
    url,
    headers,
    responseType: 'stream',
    timeout: 30000,
    validateStatus: (status) => status < 500,
    maxRedirects: 5,
  });
}

// ★★★ NEW: Function to forcefully kill a specific stream ★★★
function killStream(mac, channelId) {
  const key = `${mac}_${channelId}`;
  if (activeConnections.has(key)) {
    const conn = activeConnections.get(key);
    console.log(`🪓 Force killing stream for MAC: ${mac}, Channel: ${channelId}`);

    // Destroy the incoming stream from the source
    if (conn.stream && typeof conn.stream.destroy === 'function') {
      try {
        conn.stream.destroy();
      } catch (e) {
        console.log('⚠️ Error destroying stream:', e.message);
      }
    }

    // End the response to the client if it's still writable
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

// ★★★ NEW: Endpoint to kill a stream, called by your backend ★★★
app.delete('/api/proxy/stream/:mac/:channelId', (req, res) => {
  const { mac, channelId } = req.params;
  console.log(`🔫 Kill request received for MAC: ${mac}, Channel: ${channelId}`);

  const killed = killStream(mac, channelId);

  res.json({
    success: killed,
    message: killed ? 'Stream terminated' : 'Stream not found'
  });
});

app.get('/api/proxy/stream', async (req, res) => {
  try {
    let { url, mac, type, ua_index, channelId } = req.query;
    if (!url) return res.status(400).json({ error: 'URL is required' });
    if (!channelId) {
      const match = decodeURIComponent(url).match(/stream=(\d+)/) || decodeURIComponent(url).match(/\/(\d+)(?:\.ts)?$/);
      channelId = match ? match[1] : 'unknown';
    }

    let decodedUrl = decodeURIComponent(url);
    const originalUrl = decodedUrl;

    // ★★★ CRITICAL: Kill any existing stream for this MAC+channel before starting a new one ★★★
    if (mac && channelId !== 'unknown') {
      killStream(mac, channelId);
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    // ★ Block duplicate simultaneous requests for the same URL.
    // ExoPlayer fires 2 rapid requests (preflight + real stream) with the same URL.
    // If both reach the portal, it sees 2 concurrent streams → 458/401 on the second.
    // We track URLs currently being fetched and drop any duplicate within 3 seconds.
    const urlKey = decodedUrl.split('?')[0] + (decodedUrl.match(/[?&](stream|play_token)=[^&]+/g) || []).join('');
    if (fetchingUrls.has(urlKey)) {
      console.log(`🚫 Duplicate request blocked for URL: ${urlKey.slice(0, 80)}`);
      return res.status(429).json({ error: 'Duplicate stream request — already connecting' });
    }
    fetchingUrls.add(urlKey);
    // Auto-remove after 3 seconds regardless (guards against fetch failures)
    setTimeout(() => fetchingUrls.delete(urlKey), 3000);

    const streamType = type || (isXtreamUrl(decodedUrl) ? 'xtream' : 'mag');
    const uaIndex = parseInt(ua_index) || 0;
    const userAgent = XTREAM_USER_AGENTS[uaIndex] || XTREAM_USER_AGENTS[0];

    console.log(`🔌 Proxying stream (${streamType}) for MAC: ${mac || 'unknown'}, Channel: ${channelId}`);
    console.log(`   Original URL: ${decodedUrl}`);

    let headers;
    if (streamType === 'xtream') {
      if (!decodedUrl.includes('.ts') && !decodedUrl.includes('.m3u8') && !decodedUrl.includes('.mp4')) {
        const lastSegment = decodedUrl.split('/').pop() || '';
        if (/^\d+$/.test(lastSegment)) {
          decodedUrl = decodedUrl + '.ts';
          console.log('   Added .ts extension');
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
      if (uaIndex === 0) headers['Icy-MetaData'] = '1';
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

    let response;
    try {
      response = await attemptFetch(decodedUrl, headers);
    } catch (err) {
      fetchingUrls.delete(urlKey); // allow retry
      if (streamType === 'xtream' && err.response?.status === 404) {
        console.log('   Primary URL returned 404, trying alternate format...');
        const pathMatch = originalUrl.match(/^(https?:\/\/[^/]+)(\/[^/]+\/[^/]+\/\d+)(\.ts)?$/);
        if (pathMatch) {
          const base = pathMatch[1];
          const path = pathMatch[2];
          const cleanPath = path.replace(/\.ts$/, '');
          const altUrl = base + '/live' + cleanPath + '.ts';
          console.log(`   Trying alternate: ${altUrl}`);
          try {
            response = await attemptFetch(altUrl, headers);
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

    console.log('✅ Stream response:', response.status, response.headers['content-type']);

    // Stream is established — remove from dedup set so a future re-select works
    fetchingUrls.delete(urlKey);

    // ★★★ Store the connection with composite key (MAC + channelId) ★★★
    const connectionKey = `${mac}_${channelId}`;
    activeConnections.set(connectionKey, {
      stream: response.data,
      res: res,
      timestamp: Date.now(),
      url: decodedUrl,
      mac: mac,
      channelId: channelId
    });
    console.log(`📦 Stored connection for ${connectionKey}, total active: ${activeConnections.size}`);

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

    response.data.on('end', () => {
      console.log(`✅ Stream ended for ${connectionKey}`);
      activeConnections.delete(connectionKey);
    });

    response.data.on('error', (err) => {
      console.error('❌ Stream pipe error for ${connectionKey}:', err.message);
      activeConnections.delete(connectionKey);
      if (!res.headersSent) res.status(500).json({ error: 'Streaming failed' });
    });

  } catch (error) {
    console.error('❌ Proxy error:', {
      message: error.message,
      code: error.code,
      status: error.response?.status,
    });
    if (!res.headersSent) {
      let status = 500;
      let message = 'Streaming failed: ' + error.message;
      if (error.response?.status === 401) {
        status = 401;
        message = 'Unauthorized - stream credentials may be expired';
      } else if (error.response?.status === 403) {
        status = 403;
        message = 'Forbidden';
      } else if (error.response?.status === 404) {
        status = 404;
        message = 'Stream not found (404)';
      } else if (error.code === 'ECONNRESET') {
        status = 502;
        message = 'Connection reset by server';
      }
      res.status(status).json({ error: message });
    }
  }
});

app.options('/api/proxy/stream', (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type',
    'Access-Control-Max-Age': '86400',
  });
  res.sendStatus(204);
});

setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, conn] of activeConnections.entries()) {
    if (now - conn.timestamp > 5 * 60 * 1000) {
      console.log(`🧹 Cleaning up stale connection for ${key}`);
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
    console.log(`✅ Cleaned up ${cleaned} stale connections, remaining: ${activeConnections.size}`);
  }
}, 60 * 1000);