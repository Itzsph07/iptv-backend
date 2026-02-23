const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config({ path: '../.env' });

// Admin credentials
const adminUser = {
  username: 'mesashop',
  password: 'sindirbos789',
  email: 'admin@mesashop.com',
  role: 'admin'
};

async function createAdmin() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/iptv_manager');
    console.log('Connected to MongoDB');

    // Get the User model (if you have one defined)
    const User = mongoose.model('User', new mongoose.Schema({
      username: String,
      password: String,
      role: String,
      email: String,
      isActive: { type: Boolean, default: true },
      createdAt: { type: Date, default: Date.now }
    }));

    // Check if user already exists
    const existing = await User.findOne({ username: adminUser.username });
    if (existing) {
      console.log('Admin user already exists!');
      process.exit(0);
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(adminUser.password, 10);

    // Create admin
    const admin = new User({
      ...adminUser,
      password: hashedPassword,
      isActive: true,
      createdAt: new Date()
    });

    await admin.save();
    console.log('✅ Admin user created successfully!');
    console.log('Username: mesashop');
    console.log('Password: sindirbos789');
    
  } catch (error) {
    console.error('Error creating admin:', error);
  } finally {
    mongoose.disconnect();
    process.exit();
  }
}

createAdmin();