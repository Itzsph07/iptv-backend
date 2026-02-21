const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true, },
    role: { type: String, enum: ['admin', 'customer'], default: 'customer'},
    email: String,
    isActive: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
    lastLogin: Date,
    // For customer users
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer'}
});


module.exports = mongoose.model('User', userSchema);