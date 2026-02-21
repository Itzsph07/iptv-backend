const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const dns2 = require('dns2');

// Override Node.js DNS to use Google DNS directly
const dns = new dns2({
  dns: '8.8.8.8'
});

const originalLookup = require('dns').lookup;
require('dns').lookup = (hostname, options, callback) => {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  
  // Use custom DNS for MongoDB SRV lookups
  if (hostname.includes('mongodb.net')) {
    dns.resolve(hostname, 'ANY', (err, result) => {
      if (err) return callback(err);
      // Format response to match Node.js lookup
      callback(null, result.answers[0]?.address || '0.0.0.0', 4);
    });
  } else {
    originalLookup(hostname, options, callback);
  }
};
// Load .env from the src folder (where app.js is)
dotenv.config({ path: path.join(__dirname, '.env') });
// Add this right after your dotenv config
mongoose.set('strictQuery', false); // Suppress the warning

// Debug to confirm it's loading
console.log('🔍 Loading .env from:', path.join(__dirname, '.env'));
console.log('🔍 MONGODB_URI exists:', !!process.env.MONGODB_URI);
console.log('🔍 MONGODB_URI preview:', process.env.MONGODB_URI?.substring(0, 30) + '...');

const app = express();

// Test endpoint
app.get('/api/test', (req, res) => {
  res.json({ 
    message: 'API is working', 
    time: new Date().toISOString(),
    note: 'Your backend is running!'
  });
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Database connection with better error handling
console.log('📡 Attempting to connect to MongoDB...');

mongoose.connect(process.env.MONGODB_URI, {
  serverSelectionTimeoutMS: 30000,
  connectTimeoutMS: 30000,
  socketTimeoutMS: 45000
})
.then(() => {
  console.log('✅ MongoDB connected successfully!');
  console.log('📊 Database ready to use');
})
.catch(err => {
  console.error('❌ MongoDB connection error:');
  console.error('Error name:', err.name);
  console.error('Error message:', err.message);
  if (err.reason) {
    console.error('Error reason:', err.reason);
  }
});
// ========== PROXY STREAM ROUTE (NO AUTH REQUIRED) ==========
const axios = require('axios');

// Proxy stream with MAG headers - NO AUTH MIDDLEWARE
// ========== PROXY STREAM ROUTE ==========
app.get('/api/proxy/stream', async (req, res) => {
    try {
        const { url } = req.query;
        
        if (!url) {
            return res.status(400).json({ error: 'URL is required' });
        }

        const decodedUrl = decodeURIComponent(url);
        console.log('🔌 Proxying stream:', decodedUrl);

        // Parse the URL to get host
        let host;
        try {
            host = new URL(decodedUrl).host;
        } catch (e) {
            return res.status(400).json({ error: 'Invalid URL' });
        }

        // Use headers that work with the stream server
        const headers = {
            'User-Agent': 'Lavf53.32.100',
            'Icy-MetaData': '1',
            'Accept': '*/*',
            'Accept-Encoding': 'identity',
            'Connection': 'keep-alive',
            'Host': host
        };

        // Add Referer if it's the stream domain
        if (host.includes('mztk02.xyz')) {
            headers['Referer'] = `http://${host}/`;
        }

        console.log('📤 Request headers:', headers);

        const response = await axios({
            method: 'GET',
            url: decodedUrl,
            headers,
            responseType: 'stream',
            timeout: 30000,
            maxRedirects: 5,
            validateStatus: (status) => status < 500
        });

        console.log('📥 Response status:', response.status);

        // Set response headers
        const responseHeaders = {
            'Content-Type': response.headers['content-type'] || 'video/mp2t',
            'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': '*',
            'Icy-MetaData': '1'
        };

        res.set(responseHeaders);
        response.data.pipe(res);

    } catch (error) {
        console.error('❌ Proxy error:', error.message);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Streaming failed' });
        }
    }
});

// Test endpoint
app.get('/api/proxy/test', (req, res) => {
    res.json({ message: 'Proxy route is working' });
});

// Routes that require authentication
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/playlists', require('./routes/playlists'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/channels', require('./routes/channels'));

// ========== TOKEN REFRESH SYSTEM ==========
const tokenRefreshService = require('./services/tokenRefreshService');

// Admin token management routes
app.use('/api/admin/token', require('./routes/tokenRoutes'));

// Run token check every 6 hours
setInterval(async () => {
  console.log('⏰ Running scheduled token refresh...');
  try {
    await tokenRefreshService.refreshAllPlaylists();
  } catch (error) {
    console.error('Scheduled token refresh failed:', error);
  }
}, 6 * 60 * 60 * 1000); // 6 hours

// Run once on startup (after 10 seconds)
setTimeout(() => {
  tokenRefreshService.refreshAllPlaylists().catch(console.error);
}, 10000);

// Error handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    message: 'Something went wrong!',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// DEBUG ROUTE - Remove later
app.get('/api/debug/data', async (req, res) => {
    try {
        const Playlist = require('./models/Playlist');
        const Customer = require('./models/Customer');
        const User = require('./models/User');
        
        const playlists = await Playlist.find().populate('owner', 'username');
        const customers = await Customer.find().populate('playlists');
        const users = await User.find().select('-password');
        
        res.json({
            success: true,
            counts: {
                playlists: playlists.length,
                customers: customers.length,
                users: users.length
            },
            data: {
                playlists: playlists.map(p => ({ id: p._id, name: p.name, owner: p.owner?.username })),
                customers: customers.map(c => ({ id: c._id, name: c.name, playlists: c.playlists?.length })),
                users: users.map(u => ({ id: u._id, username: u.username, role: u.role }))
            }
        });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

module.exports = app;