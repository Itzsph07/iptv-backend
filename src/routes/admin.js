const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const admin = require('../middleware/admin');
const playlistController = require('../controllers/playlistController');
const customerController = require('../controllers/customerController');

// Dashboard
router.get('/dashboard', [auth, admin], async (req, res) => {
    try {
        const Customer = require('../models/Customer');
        const Playlist = require('../models/Playlist');
        const User = require('../models/User');
        const Channel = require('../models/Channel');
        
        const customers = await Customer.countDocuments();
        const playlists = await Playlist.countDocuments();
        const users = await User.countDocuments({ role: 'customer' });
        const channels = await Channel.countDocuments();
        
        res.json({
            success: true,
            stats: { customers, playlists, users, channels }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ========== PLAYLIST ROUTES ==========
router.get('/playlists', [auth, admin], playlistController.getPlaylists);
router.post('/playlists', [auth, admin], playlistController.createPlaylist);
router.put('/playlists/:id', [auth, admin], playlistController.updatePlaylist);
router.delete('/playlists/:id', [auth, admin], playlistController.deletePlaylist);
router.post('/playlists/test-connection', [auth, admin], playlistController.testConnection);
router.post('/playlists/:playlistId/sync', [auth, admin], playlistController.syncPlaylist);
router.get('/playlists/:playlistId/channels', [auth, admin], playlistController.getChannels);
router.put('/playlists/:playlistId/channels/:channelId', [auth, admin], playlistController.updateChannelVisibility);
router.post('/playlists/:playlistId/channels/bulk', [auth, admin], playlistController.bulkUpdateChannels);

// ========== CUSTOMER ROUTES ==========
router.get('/customers', [auth, admin], customerController.getCustomers);
router.post('/customers', [auth, admin], customerController.createCustomer);
router.put('/customers/:id', [auth, admin], customerController.updateCustomer);
router.delete('/customers/:id', [auth, admin], customerController.deleteCustomer);
router.post('/customers/:customerId/playlists/:playlistId', [auth, admin], customerController.assignPlaylist);
router.delete('/customers/:customerId/playlists/:playlistId', [auth, admin], customerController.removePlaylist);

// ========== TOKEN MANAGEMENT ROUTES ==========
// Note: These are now in tokenRoutes.js, but we'll keep a reference here
// The actual routes are mounted at /api/admin/token in app.js

module.exports = router;