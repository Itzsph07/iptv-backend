const express = require('express');
const router = express.Router();
const playlistController = require('../controllers/playlistController');
const auth = require('../middleware/auth');
const admin = require('../middleware/admin');
const Playlist = require('../models/Playlist');
const Channel = require('../models/Channel');
const Customer = require('../models/Customer');

// ─── Admin routes ─────────────────────────────────────────────────────────────
router.post('/', [auth, admin], playlistController.createPlaylist);
router.get('/', [auth, admin], playlistController.getPlaylists);
router.post('/test-connection', [auth, admin], playlistController.testConnection);
router.post('/:playlistId/sync', [auth, admin], playlistController.syncPlaylist);
router.get('/:playlistId/channels', [auth, admin], playlistController.getChannels);
router.put('/:playlistId/channels/:channelId', [auth, admin], playlistController.updateChannelVisibility);
router.post('/:playlistId/channels/bulk', [auth, admin], playlistController.bulkUpdateChannels);

router.post('/:playlistId/force-sync', [auth, admin], async (req, res) => {
    try {
        console.log('🔄 Force sync requested for playlist:', req.params.playlistId);
        const ChannelSyncService = require('../services/channelSyncService');
        const syncService = new ChannelSyncService(req.params.playlistId);
        const result = await syncService.syncPlaylist();
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Customer force-sync
// FIXES:
//  1. req.user.customerId (not req.user._id which is the User._id, not Customer._id)
//  2. bulkWrite instead of per-channel findOneAndUpdate (was 27K round-trips → timeout)
//  3. Save channels that have streamUrl even without streamingToken (live.php portals)
//  4. 10-minute background resync registered once per playlistId
// ─────────────────────────────────────────────────────────────────────────────
const scheduledResyncs = new Set(); // track which playlists already have a timer

function scheduleBackgroundResync(playlistId, playlistDoc) {
    if (scheduledResyncs.has(playlistId)) return;
    scheduledResyncs.add(playlistId);

    const runResync = async () => {
        try {
            console.log(`🔁 [10-min resync] Starting for playlist ${playlistId}...`);
            const MagStalkerService = require('../services/magStalkerService');
            const svc = new MagStalkerService(playlistDoc.sourceUrl, playlistDoc.macAddress, playlistId);
            const result = await svc.syncAll();
            if (result.channels && result.channels.length > 0) {
                const n = await bulkSaveTokens(playlistId, result.channels);
                console.log(`✅ [10-min resync] Saved ${n} tokens for ${playlistId}`);
            }
        } catch (e) {
            console.error(`❌ [10-min resync] Failed for ${playlistId}:`, e.message);
        }
        setTimeout(runResync, 10 * 60 * 1000); // schedule next
    };

    setTimeout(runResync, 10 * 60 * 1000); // first run after 10 min
    console.log(`⏰ [10-min resync] Scheduled for playlist ${playlistId}`);
}

async function bulkSaveTokens(playlistId, channels) {
    const ops = [];
    for (const ch of channels) {
        if (!ch.streamingToken && !ch.streamUrl) continue;
        ops.push({
            updateOne: {
                filter: { playlistId, channelId: String(ch.channelId) },
                update: { $set: {
                    ...(ch.streamingToken ? { streamingToken: ch.streamingToken } : {}),
                    ...(ch.streamUrl      ? { streamUrl: ch.streamUrl }           : {}),
                    tokenUpdatedAt: new Date(),
                }}
            }
        });
    }
    if (!ops.length) return 0;

    // MongoDB bulkWrite limit is 100k ops; batch at 1000 to be safe
    let saved = 0;
    for (let i = 0; i < ops.length; i += 1000) {
        await Channel.bulkWrite(ops.slice(i, i + 1000), { ordered: false });
        saved += Math.min(1000, ops.length - i);
    }
    return saved;
}

router.post('/:playlistId/customer-force-sync', auth, async (req, res) => {
    try {
        const { playlistId } = req.params;

        console.log('👤 Customer requesting force sync for playlist:', playlistId);
        console.log('   User ID:', req.user.id || req.user._id);
        console.log('   Customer ID:', req.user.customerId);

        // ★ FIX 1: JWT has { id: user._id, customerId: customer._id }
        const customerId = req.user.customerId;
        if (!customerId) {
            return res.status(403).json({ success: false, message: 'Not a customer account' });
        }

        // Verify access — check Customer.playlists array
        const customer = await Customer.findOne({ _id: customerId, playlists: playlistId }).lean();
        if (!customer) {
            // Belt-and-suspenders via playlist.assignedCustomers
            const pl = await Playlist.findOne({ _id: playlistId, assignedCustomers: customerId, isActive: true }).lean();
            if (!pl) {
                console.log('⛔ Access denied');
                return res.status(403).json({ success: false, message: 'Access denied' });
            }
        }

        const playlist = await Playlist.findById(playlistId).lean();
        if (!playlist) {
            return res.status(404).json({ success: false, message: 'Playlist not found' });
        }

        console.log(`📋 Playlist found: ${playlist.name} (${playlist.type})`);

        let result;

        if (playlist.type === 'mag' || playlist.type === 'stalker') {
            const MagStalkerService = require('../services/magStalkerService');
            const svc = new MagStalkerService(playlist.sourceUrl, playlist.macAddress, playlistId);

            console.log('🔄 Forcing immediate MAG sync...');
            result = await svc.syncAll();

            // ★ FIX 2: one bulkWrite for all channels (not 27K findOneAndUpdate calls)
            if (result.channels && result.channels.length > 0) {
                const saved = await bulkSaveTokens(playlistId, result.channels);
                const s = result.channels.find(c => c.streamingToken || c.streamUrl);
                console.log(`✅ Saved ${saved} tokens to database in bulk`);
                if (s) {
                    const tok = s.streamingToken || '(url only)';
                    console.log(`   Token 1: ${s.name} -> ${String(tok).substring(0, 15)}...`);
                }
            }

            // ★ FIX 3: register 10-min background resync (idempotent)
            scheduleBackgroundResync(playlistId, playlist);

        } else {
            const ChannelSyncService = require('../services/channelSyncService');
            result = await new ChannelSyncService(playlistId).syncPlaylist();
        }

        console.log(`✅ Force sync completed for playlist: ${playlistId}`);
        res.json({ success: true, message: 'Force sync completed', result });

    } catch (error) {
        console.error('❌ Customer force sync error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

router.get('/:playlistId', auth, async (req, res) => {
    try {
        const playlist = await Playlist.findById(req.params.playlistId).lean();
        if (!playlist) return res.status(404).json({ success: false, message: 'Playlist not found' });
        res.json(playlist);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;