// backend/src/services/portalParser.js
const axios = require('axios');

class PortalParser {
    constructor(portalBaseUrl) {
        this.baseUrl = portalBaseUrl.replace(/\/+$/, '') + '/';
        this.apiPath = null;
        this.actions = new Set();
        this.streams = new Set();
        this.mac = '00:1A:79:09:5A:BB';
    }

    async fetchFile(url) {
        try {
            const response = await axios.get(url, {
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            return response.data;
        } catch (error) {
            return null;
        }
    }

    async findApiPath(content, fileName) {
        console.log(`   Analyzing ${fileName}...`);
        
        // Look for API path definitions
        const pathPatterns = [
            /apiPath\s*=\s*['"]([^'"]+)['"]/,
            /load_path\s*=\s*['"]([^'"]+)['"]/,
            /serverUrl\s*=\s*['"]([^'"]+)['"]/,
            /baseUrl\s*=\s*['"]([^'"]+)['"]/,
            /['"]([^'"]*\/server\/load\.php[^'"]*)['"]/,
            /['"]([^'"]*\/stalker_portal\/api\/[^'"]*)['"]/,
            /url:\s*['"]([^'"]*load\.php[^'"]*)['"]/,
            /load\(\s*['"]([^'"]*load\.php[^'"]*)['"]/
        ];

        for (const pattern of pathPatterns) {
            const match = content.match(pattern);
            if (match && match[1] && !this.apiPath) {
                let path = match[1];
                // Clean up the path
                path = path.replace(/^\.\//, '');
                if (path.includes('load.php') || path.includes('api')) {
                    console.log(`   ✅ Found API path: ${path}`);
                    this.apiPath = path;
                }
            }
        }

        // Look for stb.load calls to extract actions and paths
        const loadPattern = /stb\.load\(\s*{[\s\S]*?['"]type['"]\s*:\s*['"]([^'"]+)['"][\s\S]*?['"]action['"]\s*:\s*['"]([^'"]+)['"][\s\S]*?}\)/g;
        let loadMatch;
        while ((loadMatch = loadPattern.exec(content)) !== null) {
            const type = loadMatch[1];
            const action = loadMatch[2];
            if (type && action) {
                this.actions.add(`${type}.${action}`);
            }
        }

        // Also look for standalone action definitions
        const actionPattern = /['"]action['"]\s*:\s*['"]([^'"]+)['"]/g;
        let actionMatch;
        while ((actionMatch = actionPattern.exec(content)) !== null) {
            if (actionMatch[1]) {
                this.actions.add(actionMatch[1]);
            }
        }
    }

    async testApiEndpoint(endpoint, action, params = {}) {
        if (!endpoint) return null;

        const fullUrl = endpoint.startsWith('http') 
            ? endpoint 
            : this.baseUrl + endpoint.replace(/^\.\//, '');

        console.log(`   🔍 Testing ${fullUrl} with action: ${action}`);
        
        try {
            const response = await axios.get(fullUrl, {
                params: {
                    type: action.startsWith('itv') ? 'itv' : 'stb',
                    action: action,
                    JsHttpRequest: '1-xml',
                    ...params
                },
                headers: {
                    'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3',
                    'X-User-Agent': 'Model: MAG250; Link: WiFi',
                    'Cookie': `mac=${this.mac}; stb_lang=en; timezone=GMT`
                },
                timeout: 8000,
                validateStatus: (status) => status < 500
            });

            if (response.status === 200) {
                console.log(`   ✅ ${action} responded with status 200`);
                
                // Parse JsHttpRequest response
                const jsonMatch = response.data.match(/{.*}/s);
                if (jsonMatch) {
                    try {
                        const data = JSON.parse(jsonMatch[0]);
                        if (data.js) {
                            this.extractStreamsFromData(data.js);
                        }
                        return data;
                    } catch (e) {
                        console.log(`   ⚠️  Could not parse response: ${e.message}`);
                    }
                }
            } else {
                console.log(`   ⚠️  ${action} returned status ${response.status}`);
            }
        } catch (error) {
            console.log(`   ❌ ${action} failed: ${error.message}`);
        }
        return null;
    }

    extractStreamsFromData(data) {
        if (!data) return;
        
        const dataStr = JSON.stringify(data);
        const urlPattern = /(https?:\/\/[^\s"'`]+(?:\.ts|\.m3u8|\.mp4)?)/g;
        let match;
        
        while ((match = urlPattern.exec(dataStr)) !== null) {
            const url = match[1] || match[0];
            if (url.includes('.ts') || url.includes('.m3u8') || url.includes('stream') || url.includes('live')) {
                if (!url.includes('player.js') && !url.includes('.css') && !url.includes('.html')) {
                    this.streams.add(url);
                }
            }
        }

        // Check for cmd fields (often contain ffmpeg commands)
        if (data.cmd && typeof data.cmd === 'string') {
            const cmdMatch = data.cmd.match(/(https?:\/\/[^\s]+)/);
            if (cmdMatch) {
                this.streams.add(cmdMatch[1]);
            }
        }
    }

    async tryAllPossiblePaths() {
        console.log('\n🔍 Trying common API paths...');
        
        const possiblePaths = [
            './server/load.php',
            '/server/load.php',
            'server/load.php',
            './stalker_portal/server/load.php',
            '/stalker_portal/server/load.php',
            'stalker_portal/server/load.php',
            './api/load.php',
            '/api/load.php',
            'api/load.php',
            './load.php',
            '/load.php',
            'load.php',
            './c/server/load.php',
            '/c/server/load.php',
            'c/server/load.php'
        ];

        for (const path of possiblePaths) {
            const fullUrl = this.baseUrl + path.replace(/^\.\//, '');
            try {
                const response = await axios.get(fullUrl, {
                    params: {
                        type: 'stb',
                        action: 'handshake',
                        JsHttpRequest: '1-xml'
                    },
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3',
                        'Cookie': `mac=${this.mac}; stb_lang=en; timezone=GMT`
                    },
                    timeout: 5000,
                    validateStatus: (status) => status < 500
                });

                if (response.status === 200) {
                    console.log(`   ✅ Found working API at: ${path}`);
                    this.apiPath = path;
                    
                    // Try to get channels
                    await this.testApiEndpoint(this.apiPath, 'get_ordered_list');
                    await this.testApiEndpoint(this.apiPath, 'get_all_channels');
                    
                    // Try create_link with a sample channel ID
                    await this.testApiEndpoint(this.apiPath, 'create_link', { cmd: 'ffmpeg http://test/stream/1' });
                    
                    return true;
                }
            } catch (error) {
                // Continue trying
            }
        }
        return false;
    }

    async scan() {
        console.log(`\n🔍 Scanning portal at: ${this.baseUrl}`);
        
        // First, try to find API path in JavaScript files
        const filesToCheck = [
            'player.js', 'global.js', 'tv.js', 'vclub.js', 
            'JsHttpRequest.js', 'init.js', 'main.js', 'config.js',
            'settings.js', 'api.js'
        ];

        for (const file of filesToCheck) {
            const content = await this.fetchFile(this.baseUrl + file);
            if (content) {
                await this.findApiPath(content, file);
            }
        }

        // If not found in JS files, try common paths
        if (!this.apiPath) {
            await this.tryAllPossiblePaths();
        }

        console.log(`\n📡 Final API Path: ${this.apiPath || 'Not found'}`);
        console.log(`🎯 Found ${this.actions.size} actions`);
        
        if (this.actions.size > 0) {
            console.log('Sample actions:', Array.from(this.actions).slice(0, 10));
        }

        // If we found the API path, test the most important actions
        if (this.apiPath) {
            console.log('\n🔄 Testing critical actions...');
            
            // Try handshake
            await this.testApiEndpoint(this.apiPath, 'handshake');
            
            // Try to get channels
            await this.testApiEndpoint(this.apiPath, 'get_ordered_list');
            await this.testApiEndpoint(this.apiPath, 'get_all_channels');
            
            // Try create_link
            await this.testApiEndpoint(this.apiPath, 'create_link', { 
                cmd: 'ffmpeg http://i511hq.xyz:80/5DSXY772RZRL3WV/sYv25VAJvx/1028299' 
            });
        }

        return {
            apiPath: this.apiPath,
            actions: Array.from(this.actions),
            streams: Array.from(this.streams)
        };
    }
}

async function parsePortalStreams(portalBaseUrl) {
    const parser = new PortalParser(portalBaseUrl);
    return await parser.scan();
}

module.exports = { parsePortalStreams };