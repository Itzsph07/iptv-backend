// ═══════════════════════════════════════════════════════════════════════════
// backend/app.js – PROXY ROUTE with fallback URL formats and detailed error logging
// ═══════════════════════════════════════════════════════════════════════════

const axios = require('axios');

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

/**
 * Attempt to fetch with given URL and headers, return response or throw.
 */
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

app.get('/api/proxy/stream', async (req, res) => {
  try {
    let { url, mac, type, ua_index } = req.query;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    let decodedUrl = decodeURIComponent(url);
    const originalUrl = decodedUrl; // keep for fallback

    // Determine stream type
    const streamType = type || (isXtreamUrl(decodedUrl) ? 'xtream' : 'mag');
    const uaIndex = parseInt(ua_index) || 0;
    const userAgent = XTREAM_USER_AGENTS[uaIndex] || XTREAM_USER_AGENTS[0];

    console.log(`🔌 Proxying stream (${streamType})`);
    console.log(`   Original URL: ${decodedUrl}`);
    console.log(`   UA index: ${uaIndex} -> ${userAgent}`);

    // Prepare headers based on type
    let headers;
    if (streamType === 'xtream') {
      // Ensure .ts extension if missing
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
        'Connection': 'keep-alive',
        'Referer': decodedUrl.substring(0, decodedUrl.indexOf('/', 8)) + '/',
        'Origin': decodedUrl.substring(0, decodedUrl.indexOf('/', 8)),
      };
      if (uaIndex === 0) headers['Icy-MetaData'] = '1';
    } else {
      // MAG headers (unchanged)
      const macAddress = mac || '00:1A:79:00:00:00';
      headers = {
        'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
        'X-User-Agent': 'Model: MAG250; Link: WiFi',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        'Connection': 'keep-alive',
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

    // Try primary URL
    let response;
    try {
      response = await attemptFetch(decodedUrl, headers);
    } catch (err) {
      // If primary fails with 404 and it's Xtream, try alternate format
      if (streamType === 'xtream' && err.response?.status === 404) {
        console.log('   Primary URL returned 404, trying alternate format...');
        // If original path is /user/pass/streamid, try /live/user/pass/streamid.ts
        const pathMatch = originalUrl.match(/^(https?:\/\/[^/]+)(\/[^/]+\/[^/]+\/\d+)(\.ts)?$/);
        if (pathMatch) {
          const base = pathMatch[1];
          const path = pathMatch[2];
          // Remove any trailing .ts from path if present
          const cleanPath = path.replace(/\.ts$/, '');
          const altUrl = base + '/live' + cleanPath + '.ts';
          console.log(`   Trying alternate: ${altUrl}`);
          try {
            response = await attemptFetch(altUrl, headers);
          } catch (altErr) {
            // If both fail, throw the original error
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

    // Set response headers
    const responseHeaders = {
      'Content-Type': response.headers['content-type'] || 'video/mp2t',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Range',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
      'Accept-Ranges': 'bytes',
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

    response.data.on('error', (err) => {
      console.error('❌ Stream pipe error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Streaming failed' });
    });
    response.data.on('end', () => console.log('✅ Stream ended'));

  } catch (error) {
    console.error('❌ Proxy error:', {
      message: error.message,
      code: error.code,
      status: error.response?.status,
      data: error.response?.data ? '（non‑stream data present）' : undefined,
    });
    // Log response body if available (for debugging)
    if (error.response && error.response.data && typeof error.response.data === 'string') {
      console.error('   Response body:', error.response.data.substring(0, 200));
    }
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