const axios = require('axios');
const parser = require('m3u8-parser');

class M3UService {
    constructor (url) {
        this.url = url;
    }

    async parseM3U() {
        try {
            const response = await axios.get(this.url, {
                timeout: 30000,
                responseType: 'text'
            });

            return this.parseM3UContent(response.data);
        } catch (error) {
            console.error('Failed to fetch M3U:', error.message);
            throw new Error('Failed to parse M3U playlist');
        }
    }

    parseM3UContent(content) {
        const lines = content.split('\n');
        const channels = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            if (line.startsWith('#EXTINF:')) {
                // Parse EXTINF line
                const extinf = line.substring(8);
                const params = this.parseExtinf(extinf);

                // Get the url (next non-empty line that doesnt start with #)
                let url = '';
                for (let j = i + 1; j < lines.length; j++) {
                    const nextLine = line[j].trim();
                    if (nextLine && !nextLine.startsWith('#')) {
                        url = nextLine;
                        i = j;
                        break;
                    }
                }
                channels.push({
                    ...params,
                    url
                });
            }
        }
        return this.transformChannels(channels);
    }

     parseExtInf(extinf) {
    // Extract tvg attributes and name
    const tvgIdMatch = extinf.match(/tvg-id="([^"]*)"/);
    const tvgNameMatch = extinf.match(/tvg-name="([^"]*)"/);
    const tvgLogoMatch = extinf.match(/tvg-logo="([^"]*)"/);
    const groupTitleMatch = extinf.match(/group-title="([^"]*)"/);
    const tvgShiftMatch = extinf.match(/tvg-shift="([^"]*)"/);

    // Extract duration and name
    const durationMatch = extinf.match(/^(-?\d+)/);
    const duration = durationMatch ? durationMatch[1] : '0';

    // Name is everything after the last comma
    const commaIndex = extinf.lastIndexOf(',');
    const name = commaIndex !== -1 ? extinf.substring(commaIndex + 1).trim() : 'Unknown';

    return {
      channelId: tvgIdMatch ? tvgIdMatch[1] : name,
      name,
      tvgId: tvgIdMatch ? tvgIdMatch[1] : '',
      tvgName: tvgNameMatch ? tvgNameMatch[1] : '',
      tvgLogo: tvgLogoMatch ? tvgLogoMatch[1] : '',
      tvgShift: tvgShiftMatch ? tvgShiftMatch[1] : '',
      group: groupTitleMatch ? groupTitleMatch[1] : 'Uncategorized',
      duration
    };
}

transformChannels(channels) {
    return channels.map((channel, index) => ({
        channelId: channel.channelId || `m3u_${index}`,
        name: channel.name,
        originalName: channel.name,
        url: channel.url,
        logo: channel.tvgLogo,
        group: channel.group,
        tvgId: channel.tvgId,
        tvgName: channel.tvgName,
        tvgShift: channel.tvgShift
    }));
}

async syncAll() {
    return await this.parseM3U();
}

}
module.exports = M3UService;