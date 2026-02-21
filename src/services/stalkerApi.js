// backend/src/services/stalkerApi.js
const axios = require('axios');

class StalkerApi {
    constructor(portalUrl, macAddress) {
        this.portalUrl = portalUrl.replace(/\/+$/, '');
        this.macAddress = macAddress;
        this.token = null;
        this.apiPath = '/server/load.php'; // Default path
    }

    async findApiPath() {
        const pathsToTry = [
            '/server/load.php',
            '/stalker_portal/server/load.php',
            '/portal/server/load.php',
            '/c/server/load.php',
            '/load.php'
        ];

        for (const path of pathsToTry) {
            try {
                const url = `${this.portalUrl}${path}`;
                console.log(`🔍 Testing API path: ${url}`);
                
                const response = await axios.get(url, {
                    params: {
                        type: 'stb',
                        action: 'handshake',
                        token: '',
                        JsHttpRequest: `${Date.now()}-xml`
                    },
                    headers: this.getHeaders(),
                    timeout: 5000
                });

                if (response.status === 200) {
                    const data = this.parseResponse(response.data);
                    if (data && (data.token || data.js?.token)) {
                        console.log(`✅ Found working API path: ${path}`);
                        this.apiPath = path;
                        return true;
                    }
                }
            } catch (error) {
                continue;
            }
        }
        return false;
    }

    async handshake() {
        const url = `${this.portalUrl}${this.apiPath}`;
        const response = await axios.get(url, {
            params: {
                type: 'stb',
                action: 'handshake',
                token: '',
                JsHttpRequest: `${Date.now()}-xml`
            },
            headers: this.getHeaders(),
            timeout: 10000
        });

        const data = this.parseResponse(response.data);
        this.token = data?.js?.token || data?.token;
        
        if (!this.token) {
            throw new Error('Handshake failed - no token received');
        }
        
        console.log(`✅ Handshake successful, token: ${this.token}`);
        return this.token;
    }

    async getChannels() {
        if (!this.token) await this.handshake();

        const url = `${this.portalUrl}${this.apiPath}`;
        const response = await axios.get(url, {
            params: {
                type: 'itv',
                action: 'get_ordered_list',
                token: this.token,
                JsHttpRequest: `${Date.now()}-xml`
            },
            headers: this.getHeadersWithToken(),
            timeout: 30000
        });

        const data = this.parseResponse(response.data);
        const channels = data?.js?.data || data?.js || [];
        
        console.log(`📺 Retrieved ${channels.length} channels`);
        return this.transformChannels(channels);
    }

    async createStreamLink(channelCmd) {
        if (!this.token) await this.handshake();

        const url = `${this.portalUrl}${this.apiPath}`;
        const response = await axios.get(url, {
            params: {
                type: 'itv',
                action: 'create_link',
                cmd: channelCmd,
                series: 0,
                forced_storage: 0,
                disable_ad: 0,
                download: 0,
                token: this.token,
                JsHttpRequest: `${Date.now()}-xml`
            },
            headers: this.getHeadersWithToken(),
            timeout: 15000
        });

        const data = this.parseResponse(response.data);
        const cmd = data?.js?.cmd || data?.cmd;
        
        if (cmd) {
            const urlMatch = cmd.match(/(https?:\/\/[^\s]+)/);
            return urlMatch ? urlMatch[1] : null;
        }
        return null;
    }

    transformChannels(channels) {
        return channels.map(ch => ({
            channelId: String(ch.id),
            name: ch.name,
            originalName: ch.name,
            cmd: ch.cmd || '',
            logo: ch.logo || '',
            group: ch.genre || ch.category || 'Uncategorized',
            tvGenreId: ch.tv_genre_id,
            isHd: ch.hd === 1,
            useHttpTmpLink: ch.use_http_tmp_link === 1,
            sourceType: 'mag'
        }));
    }

    parseResponse(data) {
        if (typeof data === 'string') {
            const jsonMatch = data.match(/{.*}/s);
            if (jsonMatch) {
                try {
                    return JSON.parse(jsonMatch[0]);
                } catch (e) {}
            }
        }
        return data;
    }

    getHeaders() {
        return {
            'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
            'X-User-Agent': 'Model: MAG250; Link: WiFi',
            'Cookie': `mac=${this.macAddress}; stb_lang=en; timezone=GMT`
        };
    }

    getHeadersWithToken() {
        return {
            ...this.getHeaders(),
            'Cookie': `mac=${this.macAddress}; token=${this.token}; stb_lang=en; timezone=GMT`
        };
    }
}

module.exports = StalkerApi;