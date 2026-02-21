// backend/src/services/tokenRefreshService.js
const axios = require('axios');
const Playlist = require('../models/Playlist');
const Channel = require('../models/Channel');

class TokenRefreshService {
  /**
   * Extract base URL, username, password from an Xtream URL
   */
  parseXtreamUrl(url) {
    try {
      const patterns = [
        /^(https?:\/\/[^/]+)\/live\/([^/]+)\/([^/]+)\/(\d+)(?:\.\w+)?$/,
        /^(https?:\/\/[^/]+)\/([^/]+)\/([^/]+)\/(\d+)(?:\.\w+)?$/
      ];
      
      for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) {
          const [_, baseUrl, username, password, streamId] = match;
          return { baseUrl, username, password, streamId };
        }
      }
      return null;
    } catch (error) {
      console.error('Error parsing Xtream URL:', error);
      return null;
    }
  }

  /**
   * Get server info from Xtream server
   */
  async getServerInfo(baseUrl, username, password) {
    try {
      const response = await axios.get(`${baseUrl}/player_api.php`, {
        params: {
          username,
          password,
          action: 'handshake'
        },
        timeout: 10000
      });
      
      if (response.data && response.data.user) {
        return {
          success: true,
          user: response.data.user,
          serverInfo: response.data.server_info,
          categories: response.data.categories
        };
      }
      return { success: false, error: 'Invalid response' };
    } catch (error) {
      console.error('Server info failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get all live streams to verify credentials work
   */
  async getLiveStreams(baseUrl, username, password) {
    try {
      const response = await axios.get(`${baseUrl}/player_api.php`, {
        params: {
          username,
          password,
          action: 'get_live_streams'
        },
        timeout: 30000
      });
      
      return {
        success: true,
        streams: response.data
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Test if credentials are valid
   */
  async testCredentials(baseUrl, username, password) {
    try {
      const serverInfo = await this.getServerInfo(baseUrl, username, password);
      if (!serverInfo.success) return false;
      
      if (serverInfo.user && serverInfo.user.status === 'Active') {
        return true;
      }
      
      const streams = await this.getLiveStreams(baseUrl, username, password);
      return streams.success && Array.isArray(streams.streams) && streams.streams.length > 0;
    } catch (error) {
      return false;
    }
  }

  /**
   * Refresh a single playlist's Xtream tokens
   */
  async refreshPlaylistTokens(playlist) {
    console.log(`\n🔄 Refreshing playlist: ${playlist.name} (${playlist._id})`);
    
    if (playlist.type !== 'xtream') {
      console.log('⏭️ Not an Xtream playlist, skipping');
      return { refreshed: false, reason: 'not_xtream' };
    }

    if (!playlist.xtreamUsername || !playlist.xtreamPassword || !playlist.sourceUrl) {
      console.log('⏭️ Missing credentials or source URL');
      return { refreshed: false, reason: 'missing_credentials' };
    }

    const baseUrl = playlist.sourceUrl.replace(/\/+$/, '');
    const username = playlist.xtreamUsername;
    const password = playlist.xtreamPassword;

    console.log(`Testing credentials for: ${baseUrl}`);
    
    const isValid = await this.testCredentials(baseUrl, username, password);
    
    if (isValid) {
      console.log('✅ Credentials are still valid');
      
      // Clear expired flag if it was set
      if (playlist.metadata?.tokenExpired) {
        await Playlist.findByIdAndUpdate(playlist._id, {
          $set: {
            'metadata.tokenExpired': false,
            'metadata.lastTokenCheck': new Date()
          }
        });
      }
      
      return { refreshed: false, reason: 'already_valid' };
    }

    console.log('⚠️ Credentials expired, marking for attention');
    
    await Playlist.findByIdAndUpdate(playlist._id, {
      $set: {
        'metadata.tokenExpired': true,
        'metadata.lastTokenCheck': new Date()
      }
    });

    return { 
      refreshed: false, 
      reason: 'expired_need_manual_update',
      playlist: playlist.name
    };
  }

  /**
   * Refresh all Xtream playlists
   */
  async refreshAllPlaylists() {
    console.log('\n🔄 Starting token refresh for all Xtream playlists...');
    
    const playlists = await Playlist.find({ 
      type: 'xtream',
      isActive: true 
    });
    
    console.log(`Found ${playlists.length} active Xtream playlists`);
    
    const results = {
      total: playlists.length,
      valid: 0,
      expired: 0,
      missing: 0,
      details: []
    };

    for (const playlist of playlists) {
      const result = await this.refreshPlaylistTokens(playlist);
      results.details.push({
        playlistId: playlist._id,
        name: playlist.name,
        result
      });
      
      if (result.reason === 'already_valid') results.valid++;
      else if (result.reason === 'expired_need_manual_update') results.expired++;
      else if (result.reason === 'missing_credentials') results.missing++;
    }

    console.log('\n✅ Token refresh complete');
    console.log(`Valid: ${results.valid}, Expired: ${results.expired}, Missing: ${results.missing}`);
    
    return results;
  }

  /**
   * Update playlist with new credentials
   */
  async updatePlaylistCredentials(playlistId, newUsername, newPassword) {
    const playlist = await Playlist.findById(playlistId);
    if (!playlist) {
      throw new Error('Playlist not found');
    }

    const baseUrl = playlist.sourceUrl.replace(/\/+$/, '');
    const isValid = await this.testCredentials(baseUrl, newUsername, newPassword);
    
    if (!isValid) {
      throw new Error('New credentials are invalid');
    }

    // Update playlist
    playlist.xtreamUsername = newUsername;
    playlist.xtreamPassword = newPassword;
    playlist.metadata = {
      ...playlist.metadata,
      tokenExpired: false,
      lastTokenUpdate: new Date(),
      lastTokenCheck: new Date()
    };
    
    await playlist.save();

    // Update all channels in this playlist with new URL format
    await this.updateChannelUrls(playlist._id, baseUrl, newUsername, newPassword);

    return { success: true, playlist };
  }

  /**
   * Update all channel URLs in a playlist with new credentials
   */
  async updateChannelUrls(playlistId, baseUrl, username, password) {
    const channels = await Channel.find({ playlistId });
    let updatedCount = 0;
    
    for (const channel of channels) {
      if (channel.cmd) {
        try {
          // Extract stream ID from existing URL
          const streamIdMatch = channel.cmd.match(/\/(\d+)(?:\.\w+)?$/);
          if (streamIdMatch) {
            const streamId = streamIdMatch[1];
            const newUrl = `${baseUrl}/live/${username}/${password}/${streamId}.ts`;
            channel.cmd = channel.cmd.replace(/https?:\/\/[^\s]+/, newUrl);
            await channel.save();
            updatedCount++;
          }
        } catch (error) {
          console.error(`Failed to update channel ${channel.name}:`, error.message);
        }
      }
    }
    
    console.log(`✅ Updated ${updatedCount}/${channels.length} channel URLs`);
  }
}

module.exports = new TokenRefreshService();