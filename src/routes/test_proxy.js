// Run this on your server: node test_proxy.js
// It will tell you exactly what's broken

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

console.log('\n========================================');
console.log('  PROXY DIAGNOSTIC TOOL');
console.log('========================================\n');

// TEST 1: Find FFmpeg
console.log('TEST 1: Finding FFmpeg...');
const candidates = [
  'C:\\ProgramData\\chocolatey\\lib\\ffmpeg\\tools\\ffmpeg\\bin\\ffmpeg.exe',
  'C:\\ProgramData\\chocolatey\\lib\\ffmpeg\\tools\\ffmpeg.exe',
  'C:\\ffmpeg\\bin\\ffmpeg.exe',
  'ffmpeg',
];

let ffmpegPath = null;
for (const c of candidates) {
  if (c === 'ffmpeg') {
    try {
      execSync('ffmpeg -version', { stdio: 'pipe', timeout: 3000 });
      ffmpegPath = 'ffmpeg';
      console.log('  ✅ ffmpeg found in PATH');
      break;
    } catch (_) {}
  } else if (fs.existsSync(c)) {
    ffmpegPath = c;
    console.log('  ✅ FFmpeg found at:', c);
    break;
  }
}

if (!ffmpegPath) {
  console.log('  ❌ FFmpeg NOT FOUND anywhere!');
  console.log('  FIX: Run in cmd.exe as Administrator:');
  console.log('       choco install ffmpeg');
  process.exit(1);
}

// TEST 2: FFmpeg version
console.log('\nTEST 2: FFmpeg version...');
try {
  const ver = execSync(`"${ffmpegPath}" -version 2>&1`, { timeout: 5000 }).toString().split('\n')[0];
  console.log('  ✅', ver);
} catch (e) {
  console.log('  ❌ Cannot run FFmpeg:', e.message);
  process.exit(1);
}

// TEST 3: libx264 available
console.log('\nTEST 3: Checking libx264 encoder...');
try {
  const encoders = execSync(`"${ffmpegPath}" -encoders 2>&1`, { timeout: 5000 }).toString();
  if (encoders.includes('libx264')) {
    console.log('  ✅ libx264 available');
  } else {
    console.log('  ❌ libx264 NOT available in this FFmpeg build!');
    console.log('  FIX: Reinstall FFmpeg full build:');
    console.log('       choco install ffmpeg --params "/Full"');
  }
} catch (e) {
  console.log('  ❌ Cannot check encoders:', e.message);
}

// TEST 4: Test actual transcoding with a short pipe
console.log('\nTEST 4: Test libx264 transcoding pipeline...');
const testArgs = [
  '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=25',
  '-c:v', 'libx264', '-profile:v', 'baseline', '-level', '3.1',
  '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-f', 'mpegts',
  '-t', '2', 'pipe:1',
];

const proc = spawn(ffmpegPath, testArgs);
let outBytes = 0;
let errOutput = '';
proc.stdout.on('data', d => { outBytes += d.length; });
proc.stderr.on('data', d => { errOutput += d.toString(); });
proc.on('close', (code) => {
  if (outBytes > 1000) {
    console.log(`  ✅ Transcoding works! Output: ${outBytes} bytes`);
  } else {
    console.log(`  ❌ Transcoding FAILED (code ${code}, output ${outBytes} bytes)`);
    console.log('  FFmpeg output:', errOutput.split('\n').slice(-5).join('\n'));
  }

  // TEST 5: Check server is running
  console.log('\nTEST 5: Checking backend server...');
  const req = http.get('http://localhost:5000/api/proxy/stream?url=http%3A%2F%2Ftest.com%2Fstream&channelId=test&videoFormat=h264', (res) => {
    console.log(`  ✅ Server responding (status ${res.status || res.statusCode})`);
    console.log('\n========================================');
    console.log('  ALL TESTS DONE');
    console.log('  If all passed, restart server and test');
    console.log('========================================\n');
    res.destroy();
  });
  req.on('error', (e) => {
    console.log(`  ❌ Server NOT responding: ${e.message}`);
    console.log('  FIX: Start your server first (node app.js or pm2 start)');
    console.log('\n========================================');
    console.log('  DONE');
    console.log('========================================\n');
  });
  req.setTimeout(3000, () => req.destroy());
});