const axios = require('axios');
const crypto = require('crypto');

class MagStalkerService {
    constructor(baseUrl, macAddress, playlistId = null) {
        // Handle both string and object inputs
        this.baseUrl = baseUrl && baseUrl.Url ? baseUrl.Url : baseUrl;
        
        // Remove trailing slash if present
        if (this.baseUrl && this.baseUrl.endsWith('/')) {
            this.baseUrl = this.baseUrl.slice(0, -1);
        }
        
        this.macAddress = macAddress;
        this.playlistId = playlistId; // ★ NEW: Store playlistId for database updates
        this.token = null;
        this.cookie = `mac=${macAddress}; stb_lang=en; timezone=GMT`;
        this.userAgent = 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3';
        this.genresMap = new Map();

        // Cache settings
        this.channelsCache = null;           // Store all channels
        this.cacheTimestamp = null;           // When cache was last updated
        this.cacheTTL = 10 * 60 * 1000;       // Cache for 10 minutes
        
        // Token cache for ultra-fast access
        this.tokenCache = new Map();           // channelId -> { token, url, timestamp }
        this.tokenCacheTTL = 10 * 60 * 1000;   // 10 minutes
        
        // Common API paths to try
        this.apiPaths = [
            '/c/portal.php',
            '/portal.php',
            '/c/server/portal.php',
            '/stalker_portal/portal.php',
            '/c/stalker_portal/portal.php',
            '/server/portal.php',
            '/api/portal.php',
            '/c/api/portal.php',
            '/server/load.php',
            '/c/server/load.php',
            '/stalker_portal/server/load.php',
            '/portal/server/load.php',
            '/api/server/load.php',
            '/stb/server/load.php',
            '/load.php',
            '/stalker_portal/api/load.php',
            '/api/load.php',
            '/portal/load.php',
            '/xmltv/server/load.php',
            '/itv/server/load.php',
            ''
        ];
        this.currentApiPath = '/c/portal.php';
        
        // Start background sync
        this._initBackgroundSync();
    }

    _initBackgroundSync() {
        // Only run once globally
        if (typeof global.magStalkerSyncRunning === 'undefined') {
            global.magStalkerSyncRunning = false;
        }
        
        if (!global.magStalkerSyncRunning) {
            global.magStalkerSyncRunning = true;
            this._runBackgroundSync();
        }
    }
    
    // ★★★ FIXED: Background sync now saves tokens to database ★★★
    async _runBackgroundSync() {
        console.log('🔄 Starting background channel sync every 10 minutes...');
        
        const syncLoop = async () => {
            try {
                console.log('📡 Background sync running...');
                const startTime = Date.now();
                
                const result = await this.syncAll();
                
                // ★★★ CRITICAL: Save tokens to database ★★★
                if (result.channels && result.channels.length > 0 && this.playlistId) {
                    console.log(`🎯 Got ${result.channels.length} channels from sync`);
                    
                    // Count channels with tokens
                    const channelsWithTokens = result.channels.filter(c => c.streamingToken);
                    console.log(`🔑 Found ${channelsWithTokens.length} channels with tokens`);
                    
                    if (channelsWithTokens.length > 0) {
                        // Show sample token
                        console.log('Sample token:', {
                            channel: channelsWithTokens[0].name,
                            token: channelsWithTokens[0].streamingToken?.substring(0, 10) + '...'
                        });
                        
                        // ★★★ SAVE TO DATABASE ★★★
                        const savedCount = await this.saveTokensToDatabase(this.playlistId, result.channels);
                        
                        // Update token cache with fresh tokens
                        let cacheUpdated = 0;
                        for (const channel of result.channels) {
                            if (channel.streamingToken || channel.streamUrl) {
                                this.tokenCache.set(channel.channelId, {
                                    token: channel.streamingToken,
                                    url: channel.streamUrl,
                                    timestamp: Date.now()
                                });
                                cacheUpdated++;
                            }
                        }
                        
                        console.log(`✅ Background sync completed in ${(Date.now() - startTime)/1000}s`);
                        console.log(`   📦 Cache: ${cacheUpdated} tokens`);
                        console.log(`   💾 Database: ${savedCount} tokens saved`);
                    } else {
                        console.log('⚠️ No tokens found in sync results');
                    }
                }
            } catch (error) {
                console.error('❌ Background sync failed:', error.message);
            }
            
            // Schedule next sync in 10 minutes
            setTimeout(syncLoop, 10 * 60 * 1000);
        };
        
        // Start first sync immediately (non-blocking)
        syncLoop();
    }

    // ★★★ NEW: Method to save tokens to database ★★★
    async saveTokensToDatabase(playlistId, channels) {
        try {
            console.log(`💾 Saving tokens for ${channels.length} channels to database...`);
            
            const Channel = require('../models/Channel');
            let tokenCount = 0;
            const batchSize = 100;
            
            for (let i = 0; i < channels.length; i += batchSize) {
                const batch = channels.slice(i, i + batchSize);
                const bulkOps = [];
                
                for (const channel of batch) {
                    if (channel.streamingToken || channel.streamUrl) {
                        bulkOps.push({
                            updateOne: {
                                filter: { 
                                    playlistId: playlistId,
                                    channelId: channel.channelId 
                                },
                                update: {
                                    $set: {
                                        streamingToken: channel.streamingToken,
                                        streamUrl: channel.streamUrl,
                                        tokenUpdatedAt: new Date()
                                    }
                                }
                            }
                        });
                        tokenCount++;
                    }
                }
                
                if (bulkOps.length > 0) {
                    await Channel.bulkWrite(bulkOps, { ordered: false });
                    console.log(`✅ Saved batch ${Math.floor(i/batchSize) + 1}: ${bulkOps.length} tokens`);
                }
            }
            
            console.log(`✅ Successfully saved ${tokenCount} tokens to database`);
            return tokenCount;
        } catch (error) {
            console.error('❌ Failed to save tokens to database:', error.message);
            return 0;
        }
    }

    async getChannelToken(channelId) {
        // Convert to string for consistent comparison
        const searchId = String(channelId);
        
        // Check token cache first (MILLISECONDS)
        const cached = this.tokenCache.get(searchId);
        if (cached && (Date.now() - cached.timestamp < this.tokenCacheTTL)) {
            console.log(`⚡ Token cache hit for channel ${searchId}:`, {
                hasToken: !!cached.token,
                hasUrl: !!cached.url,
                token: cached.token ? cached.token.substring(0, 10) + '...' : 'none',
                url: cached.url ? cached.url.substring(0, 50) + '...' : 'none'
            });
            return cached;
        }
        
        // If not in cache, try to get from channels cache
        if (this.channelsCache) {
            // Try exact match first
            let channel = this.channelsCache.find(c => String(c.channelId) === searchId);
            
            // If not found, try matching without leading/trailing spaces
            if (!channel) {
                channel = this.channelsCache.find(c => String(c.channelId).trim() === searchId.trim());
            }
            
            if (channel?.streamingToken || channel?.streamUrl) {
                const tokenData = {
                    token: channel.streamingToken,
                    url: channel.streamUrl,
                    timestamp: Date.now()
                };
                this.tokenCache.set(searchId, tokenData);
                console.log(`📦 Loaded from channels cache for ${searchId}:`, {
                    hasToken: !!tokenData.token,
                    hasUrl: !!tokenData.url,
                    token: tokenData.token ? tokenData.token.substring(0, 10) + '...' : 'none'
                });
                return tokenData;
            }
        }
        
        console.log(`❌ Cache miss for channel ${searchId}`);
        return null;
    }

    /**
     * Find the correct API path
     */
    async findApiPath() {
        for (const path of this.apiPaths) {
            try {
                const testUrl = `${this.baseUrl}${path}`;
                console.log(`Testing API path: ${testUrl}`);
                
                const params = {
                    type: 'stb',
                    action: 'handshake',
                    token: '',
                    JsHttpRequest: '1-xml'
                };
                
                const response = await axios.get(testUrl, {
                    params,
                    headers: this.getHeaders(),
                    timeout: 5000,
                    validateStatus: (status) => status < 500
                });
                
                if (response.status === 200) {
                    const data = this.parseResponse(response.data);
                    if (data && (data.js || data.token)) {
                        console.log(`✅ Found working API path: ${path}`);
                        this.currentApiPath = path;
                        return path;
                    }
                }
            } catch (error) {
                console.log(`Path ${path} failed:`, error.message);
            }
        }
        
        console.log('No working API path found, using default: /server/load.php');
        return this.currentApiPath;
    }

    /**
     * Step 1: Perform handshake to get token
     */
    async handshake() {
        try {
            if (!this.baseUrl) {
                throw new Error('Invalid URL: baseUrl is empty');
            }

            // Try to find correct API path if not set
            if (!this.currentApiPath) {
                await this.findApiPath();
            }

            const url = `${this.baseUrl}${this.currentApiPath}`;
            const params = {
                type: 'stb',
                action: 'handshake',
                token: '',
                JsHttpRequest: '1-xml'
            };
            
            console.log('Handshake URL:', url);
            console.log('Handshake params:', params);
            
            const response = await axios.get(url, {
                params,
                headers: this.getHeaders(),
                timeout: 10000
            });

            console.log('Handshake response status:', response.status);
            
            const data = this.parseResponse(response.data);
            
            // Check if token exists in response
            if (data && data.js && data.js.token) {
                this.token = data.js.token;
                console.log('✅ Token found:', this.token);
                return this.token;
            } else if (data && data.token) {
                this.token = data.token;
                console.log('✅ Token found:', this.token);
                return this.token;
            } else {
                console.log('No token found in response, continuing without token');
                this.token = 'no_token_required';
                return this.token;
            }
        }
        catch (error) {
            console.error('MAG Handshake failed:', error.message);
            if (error.response) {
                console.error('Response status:', error.response.status);
                console.error('Response data:', error.response.data);
            }
            
            // Try alternative paths
            return await this.handshakeAlternative();
        }
    }

    /**
     * Alternative handshake with different paths
     */
    async handshakeAlternative() {
        const alternativePaths = this.apiPaths.filter(p => p !== this.currentApiPath);
        
        for (const path of alternativePaths) {
            try {
                const url = `${this.baseUrl}${path}`;
                console.log('Trying alternative handshake URL:', url);
                
                const params = {
                    type: 'stb',
                    action: 'handshake',
                    token: '',
                    JsHttpRequest: '1-xml'
                };
                
                const response = await axios.get(url, {
                    params,
                    headers: this.getHeaders(),
                    timeout: 10000
                });

                const data = this.parseResponse(response.data);
                
                if (data && data.js && data.js.token) {
                    this.token = data.js.token;
                    this.currentApiPath = path;
                    console.log(`✅ Token found with alternative path: ${path}`);
                    return this.token;
                }
            } catch (error) {
                console.log(`Alternative path ${path} failed:`, error.message);
            }
        }
        
        console.log('All handshake attempts failed, continuing without token');
        this.token = 'no_token_required';
        return this.token;
    }

    /**
     * Step 2: Get account information
     */
    async getAccountInfo() {
        try {
            const url = `${this.baseUrl}${this.currentApiPath}`;
            const params = {
                type: 'account_info',
                action: 'get_main_info',
                JsHttpRequest: '1-xml',
                ...(this.token && this.token !== 'no_token_required' && { token: this.token })
            };
            
            const response = await axios.get(url, {
                params,
                headers: this.getHeadersWithAuth(),
                timeout: 10000
            });
            
            return this.parseResponse(response.data);
        }
        catch (error) {
            console.error('Get account info failed:', error.message);
            return { js: { status: 'offline' } };
        }
    }

    /**
     * Step 3: Get User profile
     */
    async getProfile() {
        try {
            const url = `${this.baseUrl}${this.currentApiPath}`;
            
            // Generate random for metrics
            const random = crypto.randomBytes(16).toString('hex');
            const timestamp = Math.floor(Date.now() / 1000);

            const metrics = JSON.stringify({
                mac: this.macAddress,
                sn: this.generateSerialNumber(),
                model: 'MAG250',
                type: 'STB',
                uid: '',
                random: random
            });
            
            const params = {
                type: 'stb',
                action: 'get_profile',
                hd: 1,
                ver: this.getVersionString(),
                num_banks: 2,
                sn: this.generateSerialNumber(),
                stb_type: 'MAG250',
                image_version: '218',
                video_out: 'hdmi',
                device_id: '',
                device_id2: '',
                signature: '',
                auth_second_step: 1,
                h2_version: '1.7-BD-00',
                not_valid_token: 0,
                client_type: 'STB',
                hw_version_2: this.generateHwVersion2(),
                timestamp: timestamp,
                api_signature: 263,
                metrics: metrics,
                JsHttpRequest: '1-xml',
                ...(this.token && this.token !== 'no_token_required' && { token: this.token })
            };
            
            const response = await axios.get(url, {
                params,
                headers: this.getHeadersWithAuth(),
                timeout: 15000
            });

            return this.parseResponse(response.data);
        } catch (error) {
            console.error('Get profile failed:', error.message);
            return null;
        }
    }

    /**
     * Get all genres
     */
    async getGenres() {
        try {
            const url = `${this.baseUrl}${this.currentApiPath}`;
            const params = {
                type: 'itv',
                action: 'get_genres',
                JsHttpRequest: '1-xml',
                ...(this.token && this.token !== 'no_token_required' && { token: this.token })
            };
            
            const response = await axios.get(url, {
                params,
                headers: this.getHeadersWithAuth(),
                timeout: 10000
            });

            const data = this.parseResponse(response.data);
            
            // Create a map of genre IDs to names for easy lookup
            if (data.js && Array.isArray(data.js)) {
                this.genresMap = new Map();
                data.js.forEach(genre => {
                    this.genresMap.set(genre.id.toString(), genre.title || genre.name);
                });
                console.log(`✅ Found ${data.js.length} genres`);
            }
            
            return data;
        } catch (error) {
            console.error('Get genres failed:', error.message);
            return { js: [] };
        }
    }

    /**
     * Get all Channels - Main method
     */
    async getAllChannels() {
        try {
            const url = `${this.baseUrl}${this.currentApiPath}`;
            
            // Try primary method first
            const channels = await this.getAllChannelsOptimized();
            
            if (channels && channels.length > 0) {
                return channels;
            }
            
            // If no channels, try alternative methods
            console.log('No channels from optimized method, trying alternatives...');
            return await this.getAllChannelsAlternative();
            
        } catch (error) {
            console.error('Get channels failed:', error.message);
            return [];
        }
    }

    /**
     * Optimized channel fetching (tries all at once first)
     */
    async getAllChannelsOptimized() {
        try {
            const url = `${this.baseUrl}${this.currentApiPath}`;
            
            // Try different actions that might return all channels
            const actions = [
                { type: 'itv', action: 'get_all_channels', all: 1 },
                { type: 'itv', action: 'get_ordered_list' },
                { type: 'itv', action: 'get_all_channels' },
                { type: 'itv', action: 'get_all_items' }
            ];

            for (const actionParams of actions) {
                try {
                    console.log(`Trying to fetch all channels with:`, actionParams);
                    
                    const params = {
                        ...actionParams,
                        JsHttpRequest: '1-xml',
                        ...(this.token && this.token !== 'no_token_required' && { token: this.token })
                    };

                    const response = await axios.get(url, {
                        params,
                        headers: this.getHeadersWithAuth(),
                        timeout: 30000
                    });

                    const data = this.parseResponse(response.data);
                    
                    // Extract channels from response
                    let channels = [];
                    
                    if (data && data.js) {
                        if (Array.isArray(data.js)) {
                            channels = data.js;
                        } else if (data.js.data && Array.isArray(data.js.data)) {
                            channels = data.js.data;
                        } else if (data.js.items && Array.isArray(data.js.items)) {
                            channels = data.js.items;
                        } else if (data.js.channels && Array.isArray(data.js.channels)) {
                            channels = data.js.channels;
                        } else if (typeof data.js === 'object') {
                            // If it's an object with numeric keys
                            const values = Object.values(data.js);
                            if (values.length > 0 && values[0] && (values[0].id || values[0].name)) {
                                channels = values;
                            }
                        }
                    }
                    
                    if (channels.length > 0) {
                        console.log(`✅ Retrieved ${channels.length} channels with action: ${actionParams.action}`);
                        return this.transformChannels(channels);
                    }
                } catch (e) {
                    console.log(`Failed with action ${actionParams.action}:`, e.message);
                }
            }
            
            return [];
            
        } catch (error) {
            console.error('Optimized channel fetch failed:', error.message);
            return [];
        }
    }

    /**
     * Alternative channel fetching methods
     */
    async getAllChannelsAlternative() {
        try {
            const url = `${this.baseUrl}${this.currentApiPath}`;
            
            // Try different action types
            const actions = [
                { type: 'itv', action: 'get_channels' },
                { type: 'itv', action: 'get_all_channels', force_ch_link_check: 1 },
                { type: 'itv', action: 'get_all_channels', genre: 1 },
                { type: 'vod', action: 'get_ordered_list' }
            ];
            
            for (const actionParams of actions) {
                try {
                    const params = {
                        ...actionParams,
                        JsHttpRequest: '1-xml',
                        ...(this.token && this.token !== 'no_token_required' && { token: this.token })
                    };
                    
                    console.log('Trying alternative params:', params);
                    
                    const response = await axios.get(url, {
                        params,
                        headers: this.getHeadersWithAuth(),
                        timeout: 10000
                    });

                    const data = this.parseResponse(response.data);
                    
                    let channels = [];
                    
                    if (data && data.js) {
                        if (Array.isArray(data.js) && data.js.length > 0) {
                            channels = data.js;
                        } else if (data.js.data && Array.isArray(data.js.data)) {
                            channels = data.js.data;
                        } else if (data.js.items && Array.isArray(data.js.items)) {
                            channels = data.js.items;
                        }
                    }
                    
                    if (channels.length > 0) {
                        console.log(`✅ Found ${channels.length} channels with alternative method`);
                        return this.transformChannels(channels);
                    }
                } catch (e) {
                    console.log(`Failed with alternative method:`, e.message);
                }
            }
            
            // If still no channels, try getting by genre
            return await this.getChannelsByGenre();
            
        } catch (error) {
            console.error('All channel fetch methods failed:', error.message);
            return [];
        }
    }

    /**
     * Get channels by genre (parallel fetching)
     */
    async getChannelsByGenre() {
        try {
            // Get genres first if not already loaded
            if (this.genresMap.size === 0) {
                await this.getGenres();
            }
            
            const genres = Array.from(this.genresMap.keys());
            
            if (genres.length === 0) {
                console.log('No genres found');
                return [];
            }
            
            console.log(`Fetching channels for ${genres.length} genres in parallel...`);
            
            const url = `${this.baseUrl}${this.currentApiPath}`;
            
            // Create an array of promises for each genre
            const promises = genres.map(async (genreId) => {
                try {
                    const params = {
                        type: 'itv',
                        action: 'get_channels',
                        genre: genreId,
                        JsHttpRequest: '1-xml',
                        ...(this.token && this.token !== 'no_token_required' && { token: this.token })
                    };
                    
                    const response = await axios.get(url, {
                        params,
                        headers: this.getHeadersWithAuth(),
                        timeout: 15000
                    });
                    
                    const data = this.parseResponse(response.data);
                    
                    if (data && data.js) {
                        if (Array.isArray(data.js)) {
                            return data.js;
                        } else if (data.js.data && Array.isArray(data.js.data)) {
                            return data.js.data;
                        }
                    }
                    return [];
                } catch (error) {
                    console.log(`Failed to fetch genre ${genreId}:`, error.message);
                    return [];
                }
            });
            
            // Execute all promises in parallel with concurrency limit
            const batchSize = 5;
            const allChannels = [];
            
            for (let i = 0; i < promises.length; i += batchSize) {
                const batch = promises.slice(i, i + batchSize);
                const batchResults = await Promise.all(batch);
                batchResults.forEach(channels => {
                    allChannels.push(...channels);
                });
                console.log(`Processed ${Math.min(i + batchSize, promises.length)}/${promises.length} genres`);
            }
            
            console.log(`Total channels collected by genre: ${allChannels.length}`);
            
            // Remove duplicates based on channel ID
            const uniqueChannels = Array.from(
                new Map(allChannels.map(ch => [ch.id, ch])).values()
            );
            
            console.log(`Unique channels after deduplication: ${uniqueChannels.length}`);
            
            return this.transformChannels(uniqueChannels);
            
        } catch (error) {
            console.error('Get channels by genre failed:', error.message);
            return [];
        }
    }

    /**
     * Get channel link for streaming
     */
    async getChannelLink(channelId) {
        try {
            const url = `${this.baseUrl}${this.currentApiPath}`;
            const params = {
                type: 'itv',
                action: 'create_link',
                cmd: channelId,
                series: 0,
                forced_storage: 0,
                disable_ad: 0,
                JsHttpRequest: '1-xml',
                ...(this.token && this.token !== 'no_token_required' && { token: this.token })
            };

            const response = await axios.get(url, {
                params,
                headers: this.getHeadersWithAuth(),
                timeout: 10000
            });

            const data = this.parseResponse(response.data);
            
            if (data && data.js) {
                return data.js.cmd || data.js.url;
            }
            
            // Fallback: generate stream URL
            return this.generateStreamUrl(channelId);
            
        } catch (error) {
            console.error('Get channel link failed:', error.message);
            return this.generateStreamUrl(channelId);
        }
    }

    /**
     * Generate stream URL as fallback
     */
    generateStreamUrl(channelId) {
        return `${this.baseUrl}/live/${encodeURIComponent(this.macAddress)}/${this.token || ''}/${channelId}.ts`;
    }

    /**
     * Main sync method
     */
    async syncAll() {
        console.log('Starting MAG Stalker sync...');
        console.log('Base URL:', this.baseUrl);
        console.log('MAC Address:', this.macAddress);

        try {
            // Step 1: Handshake
            await this.handshake();
            console.log('Handshake completed, token:', this.token);

            // Step 2: Get account info (optional)
            const accountInfo = await this.getAccountInfo();
            console.log('Account info retrieved');

            // Step 3: Get Profile (optional)
            const profile = await this.getProfile();
            console.log('Profile retrieved');

            // Step 4: Get genres and build genre map
            const genres = await this.getGenres();
            console.log('Genres retrieved:', genres.js ? genres.js.length : 0);

            // Step 5: Get all Channels
            const startTime = Date.now();
            const channels = await this.getAllChannels();
            const endTime = Date.now();
            
            console.log(`✅ Channels retrieved: ${channels.length} in ${(endTime - startTime) / 1000} seconds`);

            // Update cache
            this.channelsCache = channels;
            this.cacheTimestamp = Date.now();
            
            // Update token cache
            for (const channel of channels) {
                if (channel.streamingToken || channel.streamUrl) {
                    this.tokenCache.set(channel.channelId, {
                        token: channel.streamingToken,
                        url: channel.streamUrl,
                        timestamp: Date.now()
                    });
                }
            }

            return {
                accountInfo: accountInfo.js || { status: 'ok' },
                profile: profile?.js || null,
                genres: genres.js || [],
                channels: channels
            };
        } catch (error) {
            console.error('Sync failed:', error.message);
            return {
                accountInfo: { status: 'error' },
                profile: null,
                genres: [],
                channels: []
            };
        }
    }

    /**
     * Get cached channel data
     */
    async getCachedChannelData(channelId) {
        try {
            console.log(`🔍 Getting cached data for channel: ${channelId}`);
            
            const now = Date.now();
            
            // Check if cache is valid
            if (this.channelsCache && this.cacheTimestamp && (now - this.cacheTimestamp < this.cacheTTL)) {
                console.log(`📦 Using cached channels (${this.channelsCache.length} channels)`);
                
                // Find channel in cache
                const cachedChannel = this.channelsCache.find(c => c.channelId === String(channelId));
                if (cachedChannel) {
                    console.log(`✅ Found channel in cache: ${cachedChannel.name}`);
                    return cachedChannel;
                }
                console.log(`⚠️ Channel ${channelId} not found in cache`);
            }
            
            // Cache expired or channel not found - do a fresh sync
            console.log(`🔄 Cache miss, syncing all channels (this will take ~8-14 seconds)...`);
            const result = await this.syncAll();
            
            // Find the channel
            const freshChannel = result.channels.find(c => c.channelId === String(channelId));
            return freshChannel || null;
            
        } catch (error) {
            console.error('❌ Cache error:', error.message);
            return null;
        }
    }

    /**
     * Transform channels to standard format with token extraction
     */
// In magStalkerService.js - Modify transformChannels

transformChannels(channels) {
    if (!channels || !Array.isArray(channels)) {
        return [];
    }

    return channels.map(channel => {
        const channelId = channel.id || 
                        channel.channel_id || 
                        channel.channelId || 
                        String(Math.random()).substring(2, 10);
        
        const name = channel.name || 
                    channel.title || 
                    channel.display_name || 
                    'Unknown';
        
        // Get stream URL or command
        let cmd = channel.cmd || channel.url || '';
        
        // Extract the REAL streaming token from the channel data
        // The portal returns the correct token in the channel object!
        let streamingToken = channel.password || channel.streaming_token || null;
        let streamUrl = null;
        
        // If we have a URL in cmd, extract it
        const urlMatch = cmd.match(/https?:\/\/[^\s]+/);
        if (urlMatch) {
            streamUrl = urlMatch[0];
        }
        
        const logo = channel.logo || 
                    channel.icon || 
                    channel.logo_uri || 
                    '';
        
        // Get genre name from the map if available
        const genreId = channel.tv_genre_id ? channel.tv_genre_id.toString() : 
                    channel.genre_id ? channel.genre_id.toString() : null;
        const genreName = this.genresMap?.get(genreId) || 
                        channel.genre || 
                        channel.group || 
                        channel.category || 
                        'Uncategorized';
        
        return {
            channelId: String(channelId),
            name: String(name),
            originalName: String(name),
            cmd: cmd,
            logo: logo,
            group: genreName,
            tvGenreId: genreId,
            isHd: channel.hd === 1 || channel.hd === '1' || false,
            is4k: channel.hs === 4 || channel.hs === '4' || false,
            useHttpTmpLink: channel.use_http_tmp_link === 1 || false,
            ageRestricted: channel.censored === 1 || false,
            sourceType: 'mag',
            macAddress: this.macAddress,
            // ★★★ CRITICAL: Store the REAL password from the portal ★★★
            streamingToken: streamingToken,
            streamUrl: streamUrl
        };
    });
}
    /**
     * Parse MAG response (handles JavaScript wrapped responses)
     */
    parseResponse(data) {
        if (typeof data === 'string') {
            // Remove any JavaScript wrapper if present
            const jsWrapperMatch = data.match(/^\w+\(({.*})\);?$/s);
            if (jsWrapperMatch) {
                try {
                    return JSON.parse(jsWrapperMatch[1]);
                } catch (e) {
                    console.error('Failed to parse JS wrapper:', e.message);
                }
            }
            
            // Try to find JSON object in the response
            const jsonMatch = data.match(/({.*})/s);
            if (jsonMatch) {
                try {
                    return JSON.parse(jsonMatch[0]);
                } catch (e) {
                    console.error('Failed to parse JSON from string:', e.message);
                }
            }
            
            try {
                return JSON.parse(data);
            } catch (e) {
                console.error('Failed to parse response as JSON:', e.message);
                return { js: data };
            }
        }
        return data;
    }

    /**
     * Get headers for requests
     */
    getHeaders() {
        return {
            'User-Agent': this.userAgent,
            'X-User-Agent': 'Model: MAG250; Link: WiFi',
            'Referer': `${this.baseUrl}/`,
            'Cookie': this.cookie,
            'Accept': '*/*',
            'Accept-Encoding': 'gzip',
            'Connection': 'Keep-Alive'
        };
    }

    /**
     * Get headers with authentication
     */
    getHeadersWithAuth() {
        const headers = this.getHeaders();
        if (this.token && this.token !== 'no_token_required') {
            headers['Authorization'] = `Bearer ${this.token}`;
            headers['Cookie'] = `${this.cookie}; token=${this.token}`;
        }
        return headers;
    }

    /**
     * Generate serial number for MAG device
     */
    generateSerialNumber() {
        return '313356B172963';
    }

    /**
     * Generate hardware version
     */
    generateHwVersion2() {
        return '313356b17296332b483ccaa49f3eb8f7';
    }

    /**
     * Get version string for MAG device
     */
    getVersionString() {
        return 'ImageDescription: 0.2.18-r14-pub-250; ImageDate: Fri Jan 15 15:20:44 EET 2016; PORTAL version: 5.1.0; API Version: JS API version: 328; STB API version: 134; Player Engine version: 0x566';
    }
}

module.exports = MagStalkerService;