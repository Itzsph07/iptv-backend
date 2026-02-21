// backend/test-mag-fresh.js
const axios = require('axios');

async function testMagFresh() {
    const token = 'YOUR_AUTH_TOKEN'; // Get this from your login
    
    try {
        const response = await axios.post(
            'http://localhost:5000/api/channels/test-mag-fresh',
            {
                playlistId: '69949914c4c4ed7781de183d',
                channelId: '1028300'
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                }
            }
        );
        
        console.log('✅ Test result:');
        console.log(JSON.stringify(response.data, null, 2));
    } catch (error) {
        console.error('❌ Test failed:', error.response?.data || error.message);
    }
}

testMagFresh();