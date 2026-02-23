const Playlist = require('../models/Playlist');
const Channel = require('../models/Channel');
const Customer = require('../models/Customer');
const ChannelSyncService = require('../services/channelSyncService');
const MagStalkerService = require('../services/magStalkerService');
const M3UService = require('../services/m3uService');
const XtreamService = require('../services/xtreamService');
const axios = require('axios'); // Make sure to add this if not already installed

// Create playlist
exports.createPlaylist = async (req, res) => {
    try {
        console.log('📝 Creating playlist:', req.body);
        const { 
            name, 
            type, 
            sourceUrl, 
            username, 
            password, 
            macAddress,
            assignedCustomers
        } = req.body;

        const playlistData = {
            name,
            type,
            sourceUrl,
            macAddress,
            owner: req.user._id,
            assignedCustomers: assignedCustomers || [],
            isActive: true,
            status: 'active'
        };

        // Only add Xtream fields if type is xtream
        if (type === 'xtream') {
            playlistData.xtreamUsername = username;
            playlistData.xtreamPassword = password;
        }

        const playlist = new Playlist(playlistData);
        const savedPlaylist = await playlist.save();
        
        console.log('✅ Playlist saved:', savedPlaylist._id);
        console.log('Assigned to customers:', savedPlaylist.assignedCustomers);

        // If customers were assigned, update the customer documents
        if (assignedCustomers && assignedCustomers.length > 0) {
            await Customer.updateMany(
                { _id: { $in: assignedCustomers } },
                { $addToSet: { playlists: savedPlaylist._id } }
            );
            console.log(`✅ Playlist assigned to ${assignedCustomers.length} customers`);
        }

        // POPULATE the playlist before returning it (like your customer controller does)
        const populatedPlaylist = await Playlist.findById(savedPlaylist._id)
            .populate('assignedCustomers', 'name email macAddress')
            .lean();

        res.status(201).json({
            success: true,
            playlist: populatedPlaylist  // ← Now returns populated data
        });
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

// Get all playlists
exports.getPlaylists = async (req, res) => {
    try {
        console.log('📋 Fetching all playlists');
        
        const playlists = await Playlist.find()  // ← REMOVED THE OWNER FILTER
            .populate('assignedCustomers', 'name email macAddress')
            .lean();

        console.log(`✅ Found ${playlists.length} playlists`);

        res.json({
            success: true,
            playlists: playlists || []
        });
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({
            success: false,
            message: error.message,
            playlists: []
        });
    }
};

// Update playlist
exports.updatePlaylist = async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        
        console.log('📝 Updating playlist:', id, updates);

        // Remove fields that shouldn't be updated directly
        delete updates._id;
        delete updates.owner;
        delete updates.createdAt;
        
        const playlist = await Playlist.findOneAndUpdate(
            { _id: id, owner: req.user._id },
            { $set: updates },
            { new: true, runValidators: true }
        );
        
        if (!playlist) {
            return res.status(404).json({
                success: false,
                message: 'Playlist not found or you do not have permission'
            });
        }
        
        console.log('✅ Playlist updated successfully');
        
        res.json({
            success: true,
            playlist
        });
    } catch (error) {
        console.error('❌ Error updating playlist:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

// Delete playlist
exports.deletePlaylist = async (req, res) => {
    try {
        const { id } = req.params;
        console.log('🗑️ Deleting playlist:', id);

        // Check if playlist exists (remove owner check)
        const playlist = await Playlist.findById(id);
        
        if (!playlist) {
            return res.status(404).json({
                success: false,
                message: 'Playlist not found'
            });
        }

        // Delete all channels associated with this playlist
        await Channel.deleteMany({ playlistId: id });

        // Remove playlist from all customers
        await Customer.updateMany(
            { playlists: id },
            { $pull: { playlists: id } }
        );

        // Delete the playlist
        await Playlist.findByIdAndDelete(id);

        console.log('✅ Playlist deleted successfully');

        res.json({
            success: true,
            message: 'Playlist deleted successfully'
        });
    } catch (error) {
        console.error('❌ Error deleting playlist:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

// Sync playlist
exports.syncPlaylist = async (req, res) => {
    try {
        const { playlistId } = req.params;
        console.log('🔄 Syncing playlist:', playlistId);

        const syncService = new ChannelSyncService(playlistId);
        const result = await syncService.syncPlaylist();

        res.json({
            success: true,
            message: `Synced ${result.channelCount} channels`,
            result
        });
    } catch (error) {
        console.error('❌ Sync error:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

// Get channels
exports.getChannels = async (req, res) => {
    try {
        const { playlistId } = req.params;
        console.log('📺 Fetching ALL channels for playlist:', playlistId);

        const channels = await Channel.find({
            playlistId
        }).sort('customOrder');

        console.log(`✅ Found ${channels.length} total channels (visible + hidden)`);

        res.json({
            success: true,
            channels
        });
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

// Update channel visibility
exports.updateChannelVisibility = async (req, res) => {
    try {
        const { playlistId, channelId } = req.params;
        const { isVisible, customName, customLogo, customOrder } = req.body;

        console.log('👁️ Updating channel:', channelId);

        const playlist = await Playlist.findById(playlistId);

        // Update or add channel settings
        const existingSettingIndex = playlist.channelSettings.findIndex(
            s => s.channelId === channelId
        );

        const setting = {
            channelId,
            isVisible: isVisible !== undefined ? isVisible : true,
            customName,
            customLogo,
            customOrder
        };

        if (existingSettingIndex >= 0) {
            playlist.channelSettings[existingSettingIndex] = {
                ...playlist.channelSettings[existingSettingIndex],
                ...setting
            };
        } else {
            playlist.channelSettings.push(setting);
        }

        await playlist.save();

        // Also update the channel
        await Channel.findOneAndUpdate(
            { playlistId, channelId },
            { isVisible, customName, customLogo, customOrder }
        );

        res.json({
            success: true,
            message: 'Channel settings updated'
        });
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

// Bulk update channels
exports.bulkUpdateChannels = async (req, res) => {
    try {
        const { playlistId } = req.params;
        const { updates } = req.body;

        console.log(`📦 Bulk updating ${updates.length} channels for playlist ${playlistId}`);

        // Get all channel IDs from updates
        const channelIds = updates.map(u => u.channelId);
        
        // Determine the operation (all updates should have same isVisible value)
        const targetVisibility = updates[0]?.isVisible;
        
        console.log(`🎯 Target visibility: ${targetVisibility}`);

        // SINGLE QUERY - Update all channels at once
        const result = await Channel.updateMany(
            { 
                playlistId, 
                channelId: { $in: channelIds } 
            },
            { $set: { isVisible: targetVisibility } }
        );

        console.log(`✅ Database updated: ${result.modifiedCount} channels`);

        // Update playlist settings
        const playlist = await Playlist.findById(playlistId);
        
        for (const channelId of channelIds) {
            const existingSettingIndex = playlist.channelSettings.findIndex(
                s => s.channelId === channelId
            );

            if (existingSettingIndex >= 0) {
                playlist.channelSettings[existingSettingIndex].isVisible = targetVisibility;
            } else {
                playlist.channelSettings.push({
                    channelId,
                    isVisible: targetVisibility
                });
            }
        }

        await playlist.save();

        res.json({
            success: true,
            message: `Updated ${updates.length} channels`,
            modifiedCount: result.modifiedCount
        });
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

// Test connection
exports.testConnection = async (req, res) => {
    try {
        const { type, sourceUrl, username, password, macAddress } = req.body;
        console.log('🔌 Testing connection:', type, sourceUrl);

        let service;
        let result;

        switch (type) {
            case 'mag':
                service = new MagStalkerService(sourceUrl, macAddress);
                await service.handshake();
                const accountInfo = await service.getAccountInfo();
                result = { success: true, accountInfo };
                break;

            case 'm3u':
                service = new M3UService(sourceUrl);
                const channels = await service.parseM3U();
                result = { success: true, channelsCount: channels.length };
                break;

            case 'xtream':
                service = new XtreamService(sourceUrl, username, password);
                const auth = await service.authenticate();
                result = { success: true, userInfo: auth.user_info };
                break;

            default:
                throw new Error('Unsupported type');
        }
        
        console.log('✅ Connection test successful');
        res.json(result);
    } catch (error) {
        console.error('❌ Connection test failed:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

// ============================================
// NEW: Force sync endpoint handler
// ============================================
exports.forceSyncPlaylist = async (req, res) => {
    try {
        const { playlistId } = req.params;
        
        console.log('🔴 Force syncing playlist:', playlistId);

        // Get the playlist
        const playlist = await Playlist.findById(playlistId);
        if (!playlist) {
            return res.status(404).json({ 
                success: false, 
                message: 'Playlist not found' 
            });
        }

        // Get all channels for this playlist
        const channels = await Channel.find({ playlistId }).lean();
        
        const results = {
            total: channels.length,
            updated: 0,
            failed: 0,
            details: []
        };

        console.log(`🔄 Processing ${channels.length} channels for token refresh...`);

        // Process channels in batches to avoid overwhelming the server
        const batchSize = 50;
        for (let i = 0; i < channels.length; i += batchSize) {
            const batch = channels.slice(i, i + batchSize);
            console.log(`📦 Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(channels.length/batchSize)}`);
            
            await Promise.all(batch.map(async (channel) => {
                try {
                    let newToken = null;
                    
                    if (playlist.type === 'mag' || playlist.type === 'stalker') {
                        // For MAG/Stalker portals - use the MAC address from the channel or playlist
                        const macToUse = channel.macAddress || playlist.macAddress;
                        if (macToUse) {
                            newToken = await exports.generateMagToken(playlist, macToUse);
                        }
                    } else if (playlist.type === 'xtream') {
                        // For Xtream codes - refresh the token
                        newToken = await exports.refreshXtreamToken(playlist, channel);
                    }

                    if (newToken) {
                        // Update the channel with new token
                        await Channel.findOneAndUpdate(
                            { 
                                playlistId: playlistId,
                                channelId: channel.channelId 
                            },
                            {
                                $set: {
                                    streamingToken: newToken,
                                    tokenUpdatedAt: new Date()
                                }
                            }
                        );
                        
                        results.updated++;
                        results.details.push({
                            channelId: channel.channelId,
                            name: channel.name,
                            status: 'updated'
                        });
                        
                        console.log(`  ✅ Token updated: ${channel.name}`);
                    } else {
                        results.failed++;
                        results.details.push({
                            channelId: channel.channelId,
                            name: channel.name,
                            status: 'failed',
                            reason: 'Could not generate token'
                        });
                        
                        console.log(`  ❌ Token failed: ${channel.name}`);
                    }
                } catch (channelError) {
                    console.error(`Error processing channel ${channel.channelId}:`, channelError);
                    results.failed++;
                    results.details.push({
                        channelId: channel.channelId,
                        name: channel.name,
                        status: 'error',
                        reason: channelError.message
                    });
                }
            }));
        }

        // Update playlist's last sync time
        await Playlist.findByIdAndUpdate(playlistId, {
            $set: {
                lastForceSync: new Date(),
                lastSync: new Date()
            }
        });

        console.log(`✅ Force sync completed: ${results.updated} updated, ${results.failed} failed`);

        res.json({
            success: true,
            message: `Force sync completed for playlist ${playlistId}`,
            results
        });

    } catch (error) {
        console.error('❌ Force sync error:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
};

// ============================================
// Token generation helper functions
// ============================================

// Generate token for MAG/Stalker portal
exports.generateMagToken = async (playlist, macAddress) => {
    try {
        console.log(`🎫 Generating MAG token for MAC: ${macAddress}`);
        
        // Option 1: Use the MagStalkerService if it has token generation
        const magService = new MagStalkerService(playlist.sourceUrl, macAddress);
        await magService.handshake();
        
        // Get token from the service - this depends on your MagStalkerService implementation
        // You might need to add a getToken() method to the service
        const token = magService.getToken ? magService.getToken() : `token_${Date.now()}_${macAddress.replace(/:/g, '')}`;
        
        return token;
        
        // Option 2: If you need to make a direct API call:
        /*
        const response = await axios.post(`${playlist.sourceUrl}/stalker_portal/api/v2/auth`, {
            mac: macAddress,
            token: playlist.portalToken || ''
        }, {
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0'
            },
            timeout: 10000
        });
        
        if (response.data && response.data.token) {
            return response.data.token;
        }
        */
    } catch (error) {
        console.error('❌ MAG token generation failed:', error.message);
        return null;
    }
};

// Refresh token for Xtream codes
exports.refreshXtreamToken = async (playlist, channel) => {
    try {
        console.log(`🎫 Refreshing Xtream token for: ${channel.name}`);
        
        // Option 1: Use the XtreamService
        const xtreamService = new XtreamService(
            playlist.sourceUrl, 
            playlist.xtreamUsername, 
            playlist.xtreamPassword
        );
        
        // Authenticate to get fresh token
        const auth = await xtreamService.authenticate();
        
        if (auth && auth.user_info) {
            // Generate a token string (this depends on your XtreamService)
            const token = `${playlist.xtreamUsername}:${playlist.xtreamPassword}:${Date.now()}`;
            return Buffer.from(token).toString('base64');
        }
        
        // Option 2: If you need a direct API call for Xtream:
        /*
        const response = await axios.get(
            `${playlist.sourceUrl}/player_api.php`, {
                params: {
                    username: playlist.xtreamUsername,
                    password: playlist.xtreamPassword,
                    action: 'user'
                },
                timeout: 10000
            }
        );
        
        if (response.data && response.data.user_info) {
            const token = `${playlist.xtreamUsername}:${playlist.xtreamPassword}:${Date.now()}`;
            return Buffer.from(token).toString('base64');
        }
        */
        
        return null;
    } catch (error) {
        console.error('❌ Xtream token refresh failed:', error.message);
        return null;
    }
};

// Get single playlist by ID
exports.getPlaylistById = async (req, res) => {
    try {
        const { playlistId } = req.params;
        console.log('🔍 Fetching playlist by ID:', playlistId);
        
        const playlist = await Playlist.findById(playlistId)
            .populate('assignedCustomers', 'name email macAddress')
            .lean();
            
        if (!playlist) {
            return res.status(404).json({ 
                success: false, 
                message: 'Playlist not found' 
            });
        }
        
        res.json({
            success: true,
            playlist
        });
    } catch (error) {
        console.error('❌ Error fetching playlist:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
};