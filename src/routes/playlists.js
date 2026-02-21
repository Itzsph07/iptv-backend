const express = require('express');
const router = express.Router();
const playlistController = require('../controllers/playlistController');
const auth = require('../middleware/auth');
const admin = require('../middleware/admin');

router.post('/', [auth, admin], playlistController.createPlaylist);
router.get('/', [auth, admin], playlistController.getPlaylists);
router.post('/test-connection', [auth, admin], playlistController.testConnection);
router.post('/:playlistId/sync', [auth, admin], playlistController.syncPlaylist);
router.get('/:playlistId/channels', [auth, admin], playlistController.getChannels);
router.put('/:playlistId/channels/:channelId', [auth, admin], playlistController.updateChannelVisibility);
router.post('/:playlistId/channels/bulk', [auth, admin], playlistController.bulkUpdateChannels);

router.post('/:playlistId/force-sync', [auth, admin], async (req, res) => {
    try {
        const ChannelSyncService = require('../services/channelSyncService');
        const syncService = new ChannelSyncService(req.params.playlistId);
        const result = await syncService.syncPlaylist();
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});
module.exports = router;