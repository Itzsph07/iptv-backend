const fs = require('fs');
const path = require('path');

console.log('🔍 Current working directory:', process.cwd());
console.log('🔍 __dirname:', __dirname);

// Check possible locations
const possiblePaths = [
  path.join(process.cwd(), '.env'),
  path.join(__dirname, '.env'),
  path.join(__dirname, '../.env'),
  path.join(__dirname, '../../.env'),
];

possiblePaths.forEach(p => {
  console.log(`Checking: ${p} - ${fs.existsSync(p) ? '✅ EXISTS' : '❌ NOT FOUND'}`);
});

// If found, read first few chars
possiblePaths.forEach(p => {
  if (fs.existsSync(p)) {
    const content = fs.readFileSync(p, 'utf8');
    console.log(`\n📄 Content of ${p}:`);
    console.log(content.substring(0, 100) + '...');
  }
});