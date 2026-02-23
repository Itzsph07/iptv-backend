// ═══════════════════════════════════════════════════════════════════════════
// src/routes/fastSync.js
// Real-time progress via Server-Sent Events (SSE)
// Frontend polls /api/fast-sync/:playlistId/status for progress
// OR connects to /api/fast-sync/:playlistId/stream for live SSE updates
// ═══════════════════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const admin = require('../middleware/admin');
const FastChannelSyncService = require('../services/fastChannelSyncService');
const Playlist = require('../models/Playlist');

// In-memory progress store (per playlistId)
const syncProgress = new Map(); // playlistId → { stage, percent, message, channelCount, done, error }
const syncSseClients = new Map(); // playlistId → Set of SSE response objects

function broadcastProgress(playlistId, data) {
  syncProgress.set(playlistId, data);
  const clients = syncSseClients.get(playlistId);
  if (clients) {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    clients.forEach(res => {
      try { res.write(payload); } catch (_) {}
    });
    if (data.done || data.error) {
      clients.forEach(res => { try { res.end(); } catch (_) {} });
      syncSseClients.delete(playlistId);
    }
  }
}

// ─── SSE stream endpoint ──────────────────────────────────────────────────
// Client connects here and gets real-time progress events
router.get('/:playlistId/stream', [auth, admin], (req, res) => {
  const { playlistId } = req.params;

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no', // Disable nginx buffering
  });
  res.flushHeaders();

  // Send current progress immediately if sync already running
  const current = syncProgress.get(playlistId);
  if (current) {
    res.write(`data: ${JSON.stringify(current)}\n\n`);
    if (current.done || current.error) { res.end(); return; }
  } else {
    res.write(`data: ${JSON.stringify({ stage: 'waiting', percent: 0, message: 'Waiting...' })}\n\n`);
  }

  // Register client
  if (!syncSseClients.has(playlistId)) syncSseClients.set(playlistId, new Set());
  syncSseClients.get(playlistId).add(res);

  // Keep-alive ping every 20s
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { clearInterval(ping); }
  }, 20000);

  req.on('close', () => {
    clearInterval(ping);
    const clients = syncSseClients.get(playlistId);
    if (clients) clients.delete(res);
  });
});

// ─── HTTP polling endpoint (for React Native which can't do SSE easily) ──
router.get('/:playlistId/status', [auth, admin], (req, res) => {
  const { playlistId } = req.params;
  const progress = syncProgress.get(playlistId) || { stage: 'idle', percent: 0, message: 'No sync running' };
  res.json(progress);
});

// ─── Trigger sync endpoint ────────────────────────────────────────────────
router.post('/:playlistId/start', [auth, admin], async (req, res) => {
  const { playlistId } = req.params;

  const playlist = await Playlist.findById(playlistId);
  if (!playlist) return res.status(404).json({ success: false, message: 'Playlist not found' });

  // Respond immediately - don't make the client wait
  res.json({ success: true, message: 'Sync started', playlistId });

  // Reset progress
  syncProgress.set(playlistId, { stage: 'init', percent: 0, message: 'Starting...', channelCount: 0, done: false });

  // Run sync in background
  setImmediate(async () => {
    const service = new FastChannelSyncService(playlistId);

    service.setProgressCallback(({ stage, percent, message, channelCount }) => {
      broadcastProgress(playlistId, { stage, percent, message, channelCount, done: false });
    });

    try {
      const result = await service.syncPlaylist();
      broadcastProgress(playlistId, {
        stage: 'complete',
        percent: 100,
        message: `Done! ${result.channelCount} channels synced in ${result.elapsed}s`,
        channelCount: result.channelCount,
        done: true,
        elapsed: result.elapsed,
      });
    } catch (err) {
      console.error('❌ Fast sync error:', err);
      broadcastProgress(playlistId, {
        stage: 'error',
        percent: 0,
        message: `Sync failed: ${err.message}`,
        done: true,
        error: true,
      });
      await Playlist.findByIdAndUpdate(playlistId, { status: 'error', error: err.message });
    }
  });
});

module.exports = router;