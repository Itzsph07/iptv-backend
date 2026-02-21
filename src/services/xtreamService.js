// backend/src/services/xtreamService.js
const axios = require('axios');

class XtreamService {
    constructor(baseUrl, username, password) {
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.username = username;
        this.password = password;
        this.serverInfo = null;
    }

    /**
     * Get server info and authenticate
     */
    async getServerInfo() {
        try {
            const url = `${this.baseUrl}/player_api.php`;
            const params = {
                username: this.username,
                password: this.password,
                action: 'handshake'
            };

            console.log('Xtream handshake URL:', url);
            
            const response = await axios.get(url, {
                params,
                timeout: 10000
            });

            this.serverInfo = response.data;
            console.log('Xtream server info:', {
                status: this.serverInfo.user?.status,
                expires: this.serverInfo.user?.exp_date,
                categories: this.serverInfo.categories?.length
            });

            return this.serverInfo;
        } catch (error) {
            console.error('Xtream handshake failed:', error.message);
            throw error;
        }
    }

    /**
     * Get all live channels - this returns FRESH tokens!
     */
    async getLiveChannels() {
  try {
    const url = `${this.baseUrl}/player_api.php`;
    const params = {
      username: this.username,
      password: this.password,
      action: 'get_live_streams'
    };

    console.log('🔄 Calling Xtream API:', url);
    console.log('   With params:', params);
    
    const response = await axios.get(url, {
      params,
      timeout: 30000,
      validateStatus: () => true // Don't throw on any status
    });

    console.log('📡 API Response Status:', response.status);
    console.log('📡 API Response Headers:', response.headers);
    
    // Log the first 200 chars of response to see what's coming back
    if (typeof response.data === 'string') {
      console.log('📡 Response body (first 200):', response.data.substring(0, 200));
    } else {
      console.log('📡 Response type:', typeof response.data);
      console.log('📡 Is array?', Array.isArray(response.data));
    }

    if (Array.isArray(response.data)) {
      console.log(`✅ Got ${response.data.length} live channels`);
      return this.transformChannels(response.data);
    } else if (response.data && response.data.data && Array.isArray(response.data.data)) {
      // Some Xtream APIs wrap the response
      console.log(`✅ Got ${response.data.data.length} live channels (wrapped)`);
      return this.transformChannels(response.data.data);
    } else {
      console.log('❌ API returned unexpected data structure:', response.data);
      return [];
    }
  } catch (error) {
    console.error('❌ Get live channels failed:', error.message);
    if (error.response) {
      console.error('   Status:', error.response.status);
      console.error('   Data:', error.response.data);
    }
    return [];
        }
    }

    /**
     * Get a FRESH stream URL for a specific channel
     */
    async getFreshStreamUrl(channelId) {
        try {
            console.log(`🔄 Getting fresh URL for channel ${channelId}...`);
            
            // First, try to get all live streams (this returns fresh tokens)
            const channels = await this.getLiveChannels();
            const channel = channels.find(c => c.channelId === String(channelId));
            
            if (channel && channel.cmd) {
                // Extract the fresh URL from the cmd field
                const freshUrl = this._extractUrl(channel.cmd);
                if (freshUrl) {
                    console.log(`✅ Got fresh URL for channel ${channelId}:`, freshUrl);
                    return freshUrl;
                }
            }
            
            // Fallback: construct URL manually using current credentials
            console.log('⚠️ Could not get fresh URL from API, constructing manually');
            return `${this.baseUrl}/${this.username}/${this.password}/${channelId}.ts`;
        } catch (error) {
            console.error('Failed to get fresh stream URL:', error.message);
            return null;
        }
    }

    /**
     * Extract URL from cmd field
     */
    _extractUrl(cmd) {
        if (!cmd) return null;
        const match = cmd.match(/https?:\/\/[^\s"']+/);
        return match ? match[0] : null;
    }

    /**
     * Get channel stream URL (standard format)
     */
    getChannelStreamUrl(channelId, container = 'ts') {
        // Xtream Codes stream URL format
        return `${this.baseUrl}/live/${this.username}/${this.password}/${channelId}.${container}`;
    }

    /**
     * Transform channels to standard format
     */
    transformChannels(channels) {
        if (!Array.isArray(channels)) return [];

        return channels.map(channel => ({
            channelId: String(channel.stream_id),
            name: channel.name,
            originalName: channel.name,
            cmd: this.getChannelStreamUrl(channel.stream_id),
            logo: channel.stream_icon || '',
            group: channel.category_name || 'Uncategorized',
            epgId: channel.epg_channel_id || '',
            isHd: channel.hd === 1,
            sourceType: 'xtream'
        }));
    }

    /**
     * Sync all data
     */
    async syncAll() {
        console.log('Starting Xtream Codes sync...');
        console.log('Base URL:', this.baseUrl);
        console.log('Username:', this.username);

        try {
            // Get server info (handshake)
            const serverInfo = await this.getServerInfo();
            
            if (!serverInfo || !serverInfo.user || serverInfo.user.status !== 'Active') {
                throw new Error('Xtream account is not active');
            }

            // Get live channels
            const channels = await this.getLiveChannels();
            
            console.log(`✅ Synced ${channels.length} Xtream channels`);

            return {
                serverInfo: serverInfo.user,
                categories: serverInfo.categories,
                channels
            };
        } catch (error) {
            console.error('Xtream sync failed:', error.message);
            throw error;
        }
    }
}

module.exports = XtreamService;