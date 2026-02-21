// backend/src/routes/tokenRoutes.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const admin = require('../middleware/admin');
const tokenRefreshService = require('../services/tokenRefreshService');
const Playlist = require('../models/Playlist');

/**
 * GET /api/admin/token/status
 * Get token status for all playlists
 */
router.get('/status', [auth, admin], async (req, res) => {
  try {
    const playlists = await Playlist.find({ 
      type: 'xtream',
      isActive: true 
    }).select('name xtreamUsername metadata lastSync sourceUrl');
    
    const status = playlists.map(p => ({
      id: p._id,
      name: p.name,
      username: p.xtreamUsername,
      sourceUrl: p.sourceUrl,
      tokenExpired: p.metadata?.tokenExpired || false,
      lastCheck: p.metadata?.lastTokenCheck,
      lastUpdate: p.metadata?.lastTokenUpdate,
      lastSync: p.lastSync
    }));
    
    res.json({ success: true, playlists: status });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/admin/token/refresh-all
 * Manually trigger token refresh for all playlists
 */
router.post('/refresh-all', [auth, admin], async (req, res) => {
  try {
    const results = await tokenRefreshService.refreshAllPlaylists();
    res.json({ success: true, results });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/admin/token/refresh/:playlistId
 * Refresh a single playlist
 */
router.post('/refresh/:playlistId', [auth, admin], async (req, res) => {
  try {
    const playlist = await Playlist.findById(req.params.playlistId);
    if (!playlist) {
      return res.status(404).json({ success: false, error: 'Playlist not found' });
    }
    
    const result = await tokenRefreshService.refreshPlaylistTokens(playlist);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/admin/token/update/:playlistId
 * Update playlist with new credentials
 */
router.put('/update/:playlistId', [auth, admin], async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password required' });
    }
    
    const result = await tokenRefreshService.updatePlaylistCredentials(
      req.params.playlistId,
      username,
      password
    );
    
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/admin/token/test
 * Test credentials without saving
 */
router.post('/test', [auth, admin], async (req, res) => {
  try {
    const { baseUrl, username, password } = req.body;
    if (!baseUrl || !username || !password) {
      return res.status(400).json({ success: false, error: 'Missing parameters' });
    }
    
    const isValid = await tokenRefreshService.testCredentials(baseUrl, username, password);
    res.json({ success: true, valid: isValid });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/admin/token/expired
 * Get only expired playlists
 */
router.get('/expired', [auth, admin], async (req, res) => {
  try {
    const playlists = await Playlist.find({ 
      type: 'xtream',
      isActive: true,
      'metadata.tokenExpired': true
    }).select('name xtreamUsername metadata lastSync sourceUrl');
    
    res.json({ 
      success: true, 
      count: playlists.length,
      playlists 
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;