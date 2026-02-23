const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config({ path: '../.env' });

async function updatePassword() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/iptv_manager');
    console.log('Connected to MongoDB');

    const User = mongoose.model('User', new mongoose.Schema({
      username: String,
      password: String,
      role: String,
      email: String,
      isActive: Boolean
    }));

    // New password
    const newPassword = 'sindirbos789'; // or whatever you want
    
    // Hash it
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    
    // Update the user
    const result = await User.updateOne(
      { username: 'mesashop' },
      { $set: { password: hashedPassword } }
    );

    if (result.modifiedCount > 0) {
      console.log('✅ Password updated successfully!');
      
      // Verify it works
      const user = await User.findOne({ username: 'mesashop' });
      const isValid = await bcrypt.compare(newPassword, user.password);
      console.log('Password verification:', isValid ? '✅ Works!' : '❌ Failed');
    } else {
      console.log('❌ User not found or password not changed');
    }

  } catch (error) {
    console.error('Error:', error);
  } finally {
    mongoose.disconnect();
    process.exit();
  }
}

updatePassword();