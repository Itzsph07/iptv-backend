// backend/routes/channels.js – FIXED with MAG priority

const express  = require('express');
const router   = express.Router();
const auth     = require('../middleware/auth');
const axios    = require('axios');
const Playlist = require('../models/Playlist');

// ─── helpers ─────────────────────────────────────────────────────────────────

const MAG_UA =
  'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 ' +
  '(KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3';

function makeMagHeaders(mac, token, baseUrl) {
  const h = {
    'User-Agent':      MAG_UA,
    'X-User-Agent':    'Model: MAG250; Link: WiFi',
    'Accept':          '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'identity',
    'Connection':      'keep-alive',
    'Cookie':          `mac=${mac}; stb_lang=en; timezone=GMT`,
  };
  if (token) {
    h['Authorization'] = `Bearer ${token}`;
    h['Cookie']       += `; token=${token}`;
  }
  try {
    const u = new URL(baseUrl);
    h['Referer'] = `${u.protocol}//${u.host}/c/`;
  } catch (_) {}
  return h;
}

function parseMAG(data) {
  if (typeof data !== 'string') return data;
  for (const rx of [/^\w+\(({.*})\);?$/s, /({.*})/s]) {
    const m = data.match(rx);
    if (m) try { return JSON.parse(m[1]); } catch (_) {}
  }
  try { return JSON.parse(data); } catch (_) {}
  return { js: data };
}

function getStreamId(text) {
  const m = String(text || '').match(/[?&]stream=(\d+)/);
  return m ? m[1] : null;
}

function extractUrl(raw) {
  if (!raw) return null;
  const s = String(raw)
    .replace(/^ff(mpeg|rt)\s+/i, '')
    .replace(/[\t\n\r]/g, '')
    .trim();
  const m = s.match(/https?:\/\/[^\s"']+/);
  return m ? m[0] : null;
}

function ensureStreamId(url, streamId) {
  if (!url || !streamId) return url;
  try {
    const u = new URL(url);
    const cur = u.searchParams.get('stream');
    if (!cur || cur.trim() === '') {
      u.searchParams.set('stream', streamId);
      console.log(`🔧 Injected stream=${streamId}`);
      return u.toString();
    }
    return url;
  } catch (_) {
    return url.replace(/([?&]stream=)([^&]*)/, `$1${streamId}`);
  }
}

/**
 * Detect if URL is Xtream Codes format:
 *   http://host:port/user/pass/streamId[.ts]
 *   OR
 *   http://host:port/live/user/pass/streamId[.ts]
 */
function isXtreamUrl(url) {
  if (!url) return false;
  const base  = url.split('?')[0].split('#')[0];
  const m     = base.match(/^https?:\/\/[^/]+(\/.*)?$/);
  if (!m) return false;
  const parts = (m[1] || '').split('/').filter(Boolean);
  const last  = parts[parts.length - 1] || '';
  
  // Format 1: /live/user/pass/streamId[.ts]  (4 parts)
  if (parts.length === 4 && parts[0] === 'live') {
    return /^\d+(\.(ts|m3u8|mp4))?$/i.test(last);
  }
  
  // Format 2: /user/pass/streamId[.ts]  (3 parts, missing /live/)
  if (parts.length === 3) {
    return /^\d+(\.(ts|m3u8|mp4))?$/i.test(last);
  }
  
  return false;
}

/**
 * Clean Xtream URL:
 *  - Strip query params / fragments
 *  - Ensure .ts extension
 *  - Inject /live/ if missing
 *  - Preserve port :80 / :8080
 */
function cleanXtreamUrl(url) {
  // 1. Strip query & fragment
  let clean = url.split('?')[0].split('#')[0].trim().replace(/\/$/, '');

  // 2. Parse path to inject /live/ if needed
  const m = clean.match(/^(https?:\/\/[^/]+)(\/.*)?$/);
  if (m) {
    const base = m[1];
    const path = m[2] || '';
    const parts = path.split('/').filter(Boolean);
    
    // Check if /live/ is missing
    if (parts.length === 3 && parts[0] !== 'live') {
      // Format: /user/pass/streamId  →  /live/user/pass/streamId
      const [user, pass, streamId] = parts;
      clean = `${base}/live/${user}/${pass}/${streamId}`;
      console.log(`🔧 Injected /live/ into Xtream URL`);
    } else if (parts.length === 4 && parts[0] === 'live') {
      // Already has /live/, keep as-is
      clean = `${base}/${parts.join('/')}`;
    } else {
      // Unexpected format, return as-is
      clean = base + path;
    }
  }

  // 3. Ensure .ts extension
  if (!/\.(ts|m3u8|mp4)$/i.test(clean)) {
    clean += '.ts';
  }

  return clean;
}

// Replace the API_PATHS array with this expanded list
const API_PATHS = [
  '/portal.php',                    // This worked in your test!
  '/c/portal.php',
  '/server/load.php',
  '/c/server/load.php',
  '/stalker_portal/server/load.php',
  '/stalker_portal/portal.php',
  '/api/portal.php',
  '/c/api/portal.php',
  '/load.php',
  '/c/load.php'
];

async function doHandshake(baseUrl, mac) {
  console.log(`🔍 Testing handshake paths for ${baseUrl}...`);
  
  for (const path of API_PATHS) {
    try {
      const fullUrl = `${baseUrl}${path}`;
      console.log(`   Testing: ${fullUrl}`);
      
      const r = await axios.get(fullUrl, {
        params:  { 
          type: 'stb', 
          action: 'handshake', 
          token: '', 
          JsHttpRequest: '1-xml' 
        },
        headers: makeMagHeaders(mac, null, baseUrl),
        timeout: 8000,
        validateStatus: (status) => status < 500
      });
      
      console.log(`   → Status: ${r.status}`);
      
      if (r.status === 200) {
        const d = parseMAG(r.data);
        const token = d?.js?.token ?? d?.token;
        
        if (token) {
          console.log(`✅✅✅ Handshake SUCCESS at ${path}, NEW TOKEN: ${token}`);
          return { token, apiPath: path };
        } else {
          console.log(`   ⚠️ No token in response from ${path}`);
        }
      } else if (r.status === 401) {
        console.log(`   ⚠️ Path ${path} returned 401 -可能需要认证`);
      }
    } catch (e) {
      console.log(`   ❌ ${path} failed: ${e.message}`);
    }
  }
  
  console.warn('⚠️  All handshake paths failed');
  return { token: null, apiPath: API_PATHS[0] };
}

async function doCreateLink(baseUrl, apiPath, mac, token, cmdArg) {
  try {
    console.log(`🔗 create_link  cmd="${String(cmdArg).slice(0, 120)}"`);
    const r = await axios.get(`${baseUrl}${apiPath}`, {
      params: {
        type:           'itv',
        action:         'create_link',
        cmd:            cmdArg,
        series:         0,
        forced_storage: 0,
        disable_ad:     0,
        JsHttpRequest:  '1-xml',
        ...(token ? { token } : {}),
      },
      headers: makeMagHeaders(mac, token, baseUrl),
      timeout: 10000,
    });
    
    console.log('🔍 RAW create_link response data:', r.data);
    
    const d   = parseMAG(r.data);
    const out = d?.js?.cmd ?? d?.js?.url ?? null;
    console.log(`   → "${String(out).slice(0, 120)}"`);
    return out;
  } catch (e) {
    console.error('   create_link error:', e.message);
    return null;
  }
}

// ─── route ────────────────────────────────────────────────────────────────────

router.post('/get-stream', auth, async (req, res) => {
  try {
    const { playlistId, channelId, cmd } = req.body;

    console.log('\n══════════ get-stream ══════════');
    console.log('channelId :', channelId);
    console.log('cmd       :', cmd);

    const rawUrl   = extractUrl(cmd);
    const streamId = getStreamId(cmd) || channelId;

    console.log('rawUrl    :', rawUrl);
    console.log('streamId  :', streamId);

    // ── Get playlist ──────────────────────────────────────────────────────
    const playlist = await Playlist.findById(playlistId).lean();
    if (!playlist) {
      return res.status(404).json({ success: false, message: 'Playlist not found' });
    }

    // Log playlist details
    console.log('Playlist type:', playlist.type);
    console.log('sourceUrl:', playlist.sourceUrl);
    console.log('macAddress:', playlist.macAddress);

// ═══════════════════════════════════════════════════════════════════════
// PRIORITY 1: MAG/STALKER PLAYLIST - CACHED CHANNEL FETCH
// ═══════════════════════════════════════════════════════════════════════
const isMag = playlist?.type === 'mag' || playlist?.type === 'stalker';

if (isMag && playlist?.sourceUrl && playlist?.macAddress) {
  console.log('\n📡 PRIORITY 1: MAG PLAYLIST - Getting channel URL');
  console.log('   channelId:', channelId);

  try {
    const MagStalkerService = require('../services/magStalkerService');
    const service = new MagStalkerService(playlist.sourceUrl, playlist.macAddress);
    
    // Use the cached method - first request slow, rest instant
    const freshUrl = await service.getCachedChannelUrl(channelId);
    
    if (freshUrl) {
      console.log('✅✅✅ FRESH URL:', freshUrl);
      
      // Extract and show the token
      const tokenMatch = freshUrl.match(/\/([^\/]+)\/\d+/);
      if (tokenMatch) {
        console.log(`   🔑 Fresh token: ${tokenMatch[1]}`);
      }
      
      return res.json({ success: true, url: freshUrl, type: 'mag' });
    }
    
    console.log('⚠️ Channel not found, falling back');
    if (rawUrl) {
      return res.json({ success: true, url: rawUrl, type: 'mag_fallback' });
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (rawUrl) {
      return res.json({ success: true, url: rawUrl, type: 'mag_fallback' });
    }
  }
}
    // ── CASE 1: External Xtream URL (different host) ──────────────────────
    if (rawUrl && rawHost && playlistHost && rawHost !== playlistHost) {
      // Add .ts extension if missing (Xtream servers often need it)
      let finalUrl = rawUrl;
      if (isXtreamUrl(rawUrl) && !rawUrl.includes('.ts') && !rawUrl.includes('.m3u8') && !rawUrl.includes('.mp4')) {
        const lastSegment = rawUrl.split('/').pop() || '';
        if (/^\d+$/.test(lastSegment)) {
          finalUrl = rawUrl + '.ts';
          console.log('🔧 Added .ts extension to external Xtream URL');
        }
      }
      console.log('✅ External Xtream URL detected → using:', finalUrl);
      return res.json({ success: true, url: finalUrl, type: 'xtream' });
    }

    // ── CASE 2: Same-host Xtream URL ──────────────────────────────────────
    if (rawUrl && isXtreamUrl(rawUrl)) {
      // Try playlist credentials first
      if (playlist.sourceUrl) {
        const baseUrl = playlist.sourceUrl.replace(/\/+$/, '');
        const username = playlist.xtreamUsername || playlist.username;
        const password = playlist.xtreamPassword || playlist.password;
        
        if (username && password) {
          const xtreamUrl = `${baseUrl}/live/${username}/${password}/${streamId}.ts`;
          console.log('✅ Xtream URL (from playlist credentials):', xtreamUrl);
          return res.json({ success: true, url: xtreamUrl, type: 'xtream' });
        }
      }

      // Fallback to cleaned raw URL
      const xtreamUrl = cleanXtreamUrl(rawUrl);
      console.log('✅ Xtream URL (fallback from raw):', xtreamUrl);
      return res.json({ success: true, url: xtreamUrl, type: 'xtream' });
    }

    // ── CASE 3: Xtream playlist type (legacy check) ───────────────────────
    const isXtreamPlaylist = playlist?.type === 'xtream';

    if (isXtreamPlaylist) {
      const baseUrl  = playlist.sourceUrl?.replace(/\/+$/, '');
      const username = playlist.xtreamUsername || playlist.username;
      const password = playlist.xtreamPassword || playlist.password;

      if (baseUrl && username && password) {
        const xtreamUrl = `${baseUrl}/live/${username}/${password}/${channelId}.ts`;
        console.log('✅ Xtream playlist → returning:', xtreamUrl);
        return res.json({ success: true, url: xtreamUrl, type: 'xtream' });
      }

      if (rawUrl) {
        const cleaned = cleanXtreamUrl(rawUrl);
        console.log('✅ Xtream fallback URL:', cleaned);
        return res.json({ success: true, url: cleaned, type: 'xtream' });
      }
    }

    // ── CASE 4: Final fallback ────────────────────────────────────────────
    if (!rawUrl) {
      return res.status(400).json({ success: false, message: 'No valid URL in cmd' });
    }

    const safeUrl = ensureStreamId(rawUrl, streamId);
    console.log('ℹ️  Fallback URL:', safeUrl);
    return res.json({ success: true, url: safeUrl });

  } catch (err) {
    console.error('get-stream error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;