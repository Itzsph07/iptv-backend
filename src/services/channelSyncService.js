// ═══════════════════════════════════════════════════════════════════════════
// backend/services/channelSyncService.js - OPTIMIZED FOR 20K+ CHANNELS
// ═══════════════════════════════════════════════════════════════════════════

const Playlist = require('../models/Playlist');
const Channel = require('../models/Channel');
const MagStalkerService = require('./magStalkerService');
const XtreamService = require('./xtreamService');
const M3UService = require('./m3uService');

class ChannelSyncService {
  constructor(playlistId) {
    this.playlistId = playlistId;
    this.progressCallback = null;
  }

  // Set progress callback for real-time updates
  setProgressCallback(callback) {
    this.progressCallback = callback;
  }

  reportProgress(stage, current, total, message) {
    if (this.progressCallback) {
      this.progressCallback({
        stage,
        current,
        total,
        percent: total > 0 ? Math.round((current / total) * 100) : 0,
        message,
      });
    }
  }

  async syncPlaylist() {
    try {
      const playlist = await Playlist.findById(this.playlistId);
      if (!playlist) {
        throw new Error('Playlist not found');
      }

      console.log(`🔄 Syncing: ${playlist.name} (${playlist.type})`);
      this.reportProgress('init', 0, 100, `Connecting to ${playlist.type} server...`);

      let channels = [];

      // ══════════════════════════════════════════════════════════════════
      // STEP 1: Fetch channels from source (5-10 seconds for 20K channels)
      // ══════════════════════════════════════════════════════════════════
      switch (playlist.type) {
        case 'mag':
        case 'stalker':
          this.reportProgress('fetching', 10, 100, 'Fetching MAG channels...');
          const magService = new MagStalkerService(
            playlist.sourceUrl, 
            playlist.macAddress,
            playlist._id.toString() // ★ PASS THE PLAYLIST ID
          );
          const magData = await magService.syncAll();
          channels = magData.channels || [];
          break;

        case 'xtream':
          this.reportProgress('fetching', 10, 100, 'Fetching Xtream channels...');
          const xtreamService = new XtreamService(
            playlist.sourceUrl,
            playlist.xtreamUsername,
            playlist.xtreamPassword
          );
          const xtreamData = await xtreamService.syncAll();
          channels = xtreamData.channels || [];
          break;

        case 'm3u':
          this.reportProgress('fetching', 10, 100, 'Parsing M3U playlist...');
          const m3uService = new M3UService(playlist.sourceUrl);
          channels = await m3uService.parsePlaylist();
          break;
      }

      console.log(`✅ Fetched ${channels.length} channels`);
      this.reportProgress('fetching', 50, 100, `Fetched ${channels.length} channels`);

      // ══════════════════════════════════════════════════════════════════
      // STEP 2: Update database (OPTIMIZED - 2-5 seconds for 20K channels)
      // ══════════════════════════════════════════════════════════════════
      await this.updateChannelsBulk(channels, playlist);

      // ══════════════════════════════════════════════════════════════════
      // STEP 3: Update playlist metadata
      // ══════════════════════════════════════════════════════════════════
      this.reportProgress('finalizing', 95, 100, 'Finalizing...');
      
      playlist.lastSync = new Date();
      playlist.channelCount = channels.length;
      playlist.status = 'active';
      await playlist.save();

      this.reportProgress('complete', 100, 100, `✅ Synced ${channels.length} channels`);
      console.log(`✅ Sync completed: ${channels.length} channels`);

      return {
        success: true,
        channelCount: channels.length,
        playlist,
      };

    } catch (error) {
      console.error('❌ Sync failed:', error.message);
      
      await Playlist.findByIdAndUpdate(this.playlistId, {
        status: 'error',
        lastSync: new Date(),
        error: error.message,
      });

      throw error;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ULTRA-FAST BULK UPDATE: 20K channels in 2-5 seconds
  // ═══════════════════════════════════════════════════════════════════════
  async updateChannelsBulk(channels, playlist) {
    const BATCH_SIZE = 1000; // Process 1000 channels at a time
    
    this.reportProgress('database', 60, 100, 'Preparing database updates...');

    // ──────────────────────────────────────────────────────────────────
    // STEP 1: Get all existing channels (1 query)
    // ──────────────────────────────────────────────────────────────────
    const existingChannels = await Channel.find({ playlistId: playlist._id }).lean();
    const existingMap = new Map(existingChannels.map(ch => [ch.channelId, ch]));
    
    const newChannelIds = new Set(channels.map(c => c.channelId.toString()));
    
    // ──────────────────────────────────────────────────────────────────
    // STEP 2: Delete removed channels (1 bulk query)
    // ──────────────────────────────────────────────────────────────────
    const channelsToDelete = existingChannels
      .filter(ch => !newChannelIds.has(ch.channelId.toString()))
      .map(ch => ch._id);
    
    if (channelsToDelete.length > 0) {
      await Channel.deleteMany({ _id: { $in: channelsToDelete } });
      console.log(`🗑️  Deleted ${channelsToDelete.length} old channels`);
    }

    // ──────────────────────────────────────────────────────────────────
    // STEP 3: Bulk insert/update in batches (fast!)
    // ──────────────────────────────────────────────────────────────────
    const totalBatches = Math.ceil(channels.length / BATCH_SIZE);
    
    for (let i = 0; i < channels.length; i += BATCH_SIZE) {
      const batch = channels.slice(i, i + BATCH_SIZE);
      const currentBatch = Math.floor(i / BATCH_SIZE) + 1;
      
      this.reportProgress(
        'database',
        60 + Math.round((currentBatch / totalBatches) * 30),
        100,
        `Saving batch ${currentBatch}/${totalBatches} (${i + batch.length}/${channels.length} channels)...`
      );

      // Build bulk operations
      const bulkOps = batch.map(channelData => {
        const channelId = channelData.channelId.toString();
        const existingSettings = playlist.channelSettings?.find(s => s.channelId === channelId);

        return {
          updateOne: {
            filter: { playlistId: playlist._id, channelId },
            update: {
              $set: {
                ...channelData,
                playlistId: playlist._id,
                isVisible: existingSettings ? existingSettings.isVisible : true,
                customName: existingSettings?.customName,
                customLogo: existingSettings?.customLogo,
                customOrder: existingSettings?.customOrder,
                streamingToken: channelData.streamingToken,
                streamUrl: channelData.streamUrl,
                updatedAt: new Date(),
              },
            },
            upsert: true,
          },
        };
      });

      // Execute bulk write (1 query per batch instead of 1000 individual queries!)
      await Channel.bulkWrite(bulkOps, { ordered: false });
      
      console.log(`✅ Batch ${currentBatch}/${totalBatches} saved`);
    }

    console.log(`✅ Database update complete: ${channels.length} channels`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FIXED: getChannelsForCustomer with source playlist tracking
  // ═══════════════════════════════════════════════════════════════════════
  async getChannelsForCustomer(customerId) {
    // Get ALL playlists this customer has access to
    const playlists = await Playlist.find({
        assignedCustomers: customerId,
        isActive: true,
    }).lean();

    console.log(`Customer has access to ${playlists.length} playlists`);
    
    // Create a map of accessible playlists
    const accessiblePlaylists = new Map(
        playlists.map(p => [p._id.toString(), p])
    );

    let allChannels = [];

    // For EACH playlist the customer has access to
    for (const playlist of playlists) {
        // Get ALL visible channels from this playlist
        const channels = await Channel.find({
            playlistId: playlist._id,
            isVisible: true,
        }).lean();

        console.log(`📺 Playlist ${playlist.name} (${playlist._id}): ${channels.length} channels`);

        // Enrich each channel with playlist data
        const enriched = channels.map(ch => {
            const settings = playlist.channelSettings?.find(
                s => s.channelId === ch.channelId.toString()
            );

            return {
                ...ch,
                name: settings?.customName || ch.name,
                logo: settings?.customLogo || ch.logo,
                order: settings?.customOrder || 999,
                playlistName: playlist.name,
                playlistType: playlist.type,
                macAddress: playlist.macAddress,
                streamingToken: ch.streamingToken,
                streamUrl: ch.streamUrl,
                // ★★★ CRITICAL: Store the source playlist info for sync operations
                sourcePlaylist: {
                    id: playlist._id.toString(),
                    name: playlist.name,
                    type: playlist.type,
                    macAddress: playlist.macAddress,
                    sourceUrl: playlist.sourceUrl,
                    xtreamUsername: playlist.xtreamUsername,
                    xtreamPassword: playlist.xtreamPassword
                },
                // Keep original for reference
                originalPlaylistId: ch.playlistId
            };
        });

        allChannels = [...allChannels, ...enriched];
    }

    // Sort by custom order
    allChannels.sort((a, b) => (a.order || 999) - (b.order || 999));
    
    console.log(`Returning ${allChannels.length} channels from ${playlists.length} playlists`);
    if (allChannels.length > 0) {
        const sample = allChannels[0];
        console.log('✅ Sample channel with source playlist:', {
            name: sample.name,
            originalPlaylistId: sample.originalPlaylistId,
            sourcePlaylistId: sample.sourcePlaylist?.id,
            hasToken: !!sample.streamingToken
        });
    }
    
    return allChannels;
  }
}

module.exports = ChannelSyncService;