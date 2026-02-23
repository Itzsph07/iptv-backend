// checkUser.js
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config({ path: '../.env' });

async function checkUser() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/iptv_manager');
    console.log('Connected to MongoDB');

    // Use the SAME schema as your login endpoint
    const User = mongoose.model('User', new mongoose.Schema({
      username: String,
      password: String,
      role: String,
      email: String,
      isActive: Boolean,
      createdAt: Date
    }));

    // Find the user
    const user = await User.findOne({ username: 'mesashop' });
    
    if (!user) {
      console.log('❌ User not found in database!');
      process.exit(1);
    }


console.log('Full user object:', {
  id: user._id,
  username: user.username,
  role: user.role,  // What is this value?
  isActive: user.isActive,
  email: user.email
});
    // Test password comparison
    const testPassword = 'sindirbos789';
    const isValid = await bcrypt.compare(testPassword, user.password);
    console.log('Password validation:', isValid ? '✅ Correct' : '❌ Incorrect');

  } catch (error) {
    console.error('Error:', error);
  } finally {
    mongoose.disconnect();
    process.exit();
  }
}

checkUser();