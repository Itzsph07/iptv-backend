const net = require('net');

const hosts = [
  'ac-rb9178l-shard-00-00.tfvtcrs.mongodb.net:27017',
  'ac-rb9178l-shard-00-01.tfvtcrs.mongodb.net:27017',
  'ac-rb9178l-shard-00-02.tfvtcrs.mongodb.net:27017'
];

async function testConnection(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection(port, host);
    socket.setTimeout(5000);
    
    socket.on('connect', () => {
      console.log(`✅ ${host}:${port} - Connected`);
      socket.destroy();
      resolve(true);
    });
    
    socket.on('timeout', () => {
      console.log(`⏱️ ${host}:${port} - Timeout`);
      socket.destroy();
      resolve(false);
    });
    
    socket.on('error', (err) => {
      console.log(`❌ ${host}:${port} - ${err.message}`);
      resolve(false);
    });
  });
}

async function testAll() {
  console.log('🔍 Testing connections to MongoDB replica set...\n');
  
  for (const host of hosts) {
    const [address, port] = host.split(':');
    await testConnection(address, parseInt(port));
  }
  
  console.log('\n✅ Test complete');
}

testAll();