const mongoose = require('mongoose');

const channelSchema = new mongoose.Schema({
    // MISSING FIELD - Add this!
    channelId: { 
        type: String, 
        required: true 
    },
    playlistId: { 
        type: String, 
        required: true 
    },
    name: String,
    originalName: String,
    logo: String,
    group: String,
    url: String,
    // For MAG Stalker
    cmd: String,
    tvGenreId: String,
    // For M3U
    tvgId: String,
    tvgName: String,
    tvgLogo: String,
    tvgShift: String,
    // For MAG Stalker additional fields
    isHd: Boolean,
    is4k: Boolean,
    useHttpTmpLink: Boolean,
    ageRestricted: Boolean,
    sourceType: {
        type: String,
        enum: ['m3u', 'mag', 'xtream'],
        default: 'm3u'
    },
    // Additional
    isVisible: { 
        type: Boolean, 
        default: true 
    },
    customName: String,
    customLogo: String,
    customOrder: Number,
    createdAt: { 
        type: Date, 
        default: Date.now 
    },
    updatedAt: { 
        type: Date, 
        default: Date.now 
    }
});

// Compound index to ensure unique channels per playlist
channelSchema.index({ playlistId: 1, channelId: 1 }, { unique: true });

// Update the updatedAt timestamp on save
channelSchema.pre('save', function(next) {
    this.updatedAt = Date.now();
    next();
});

module.exports = mongoose.model('Channel', channelSchema);