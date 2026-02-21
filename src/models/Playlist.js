// backend/src/models/Playlist.js
const mongoose = require('mongoose');

const playlistSchema = new mongoose.Schema({
    name: { type: String, required: true },
    type: { 
        type: String, 
        enum: ['mag', 'stalker', 'xtream', 'm3u'],
        required: true 
    },
    sourceUrl: { type: String, required: true },
    
    // MAG Stalker fields
    macAddress: { type: String },
    
    // Xtream Codes fields
    xtreamUsername: { type: String },
    xtreamPassword: { type: String },
    
    // Common fields
    assignedCustomers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Customer' }],
    channelSettings: [{
        channelId: String,
        isVisible: { type: Boolean, default: true },
        customName: String,
        customLogo: String,
        customOrder: Number
    }],
    
    // Sync info
    lastSync: { type: Date },
    channelCount: { type: Number, default: 0 },
    status: { 
        type: String, 
        enum: ['active', 'inactive', 'error'],
        default: 'active'
    },
    error: { type: String },
    syncData: { type: mongoose.Schema.Types.Mixed },
    
    isActive: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Playlist', playlistSchema);