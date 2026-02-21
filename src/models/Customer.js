const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema({
    name: String,
    email: String,
    phone: String,
    macAddress: { type: String, unique: true, sparse: true },
    status: { type: String, enum: ['active', 'inactive', 'expired'], default: 'active'},
    expiryDate: Date,
    playlists: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Playlist'}],
    createdAt: { type: Date, default: Date.now },
    notes: String
});

module.exports = mongoose.model('Customer', customerSchema);