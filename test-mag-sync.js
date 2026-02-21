// backend/test-mag-sync.js
const MagStalkerService = require('./src/services/magStalkerService');

async function testMagSync() {
    const playlist = {
        sourceUrl: 'http://zara4k.online:80/c/',
        macAddress: '00:1A:79:09:5A:BB'
    };

    console.log('🔍 Testing MAG sync...');
    console.log('Portal:', playlist.sourceUrl);
    console.log('MAC:', playlist.macAddress);
    console.log('='.repeat(60));

    const service = new MagStalkerService(playlist.sourceUrl, playlist.macAddress);
    
    try {
        // This will use your existing magStalkerService
        const result = await service.syncAll();
        
        console.log('\n✅ Sync completed!');
        console.log(`Channels found: ${result.channels?.length || 0}`);
        
        if (result.channels && result.channels.length > 0) {
            console.log('\n📺 First channel:');
            console.log(result.channels[0]);
            
            // Save to file for inspection
            const fs = require('fs');
            fs.writeFileSync('mag-channels.json', JSON.stringify(result.channels, null, 2));
            console.log('\n💾 Channels saved to mag-channels.json');
        } else {
            console.log('\n❌ No channels received from MAG server');
            console.log('Account info:', result.accountInfo);
        }
    } catch (error) {
        console.error('❌ Sync failed:', error.message);
    }
}

testMagSync();