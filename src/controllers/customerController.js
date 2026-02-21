const Customer = require('../models/Customer');
const User = require('../models/User');
const Playlist = require('../models/Playlist');
const bcrypt = require('bcryptjs');

// Create customer
exports.createCustomer = async (req, res) => {
    try {
        console.log('📝 Creating customer:', req.body);
        const { name, email, phone, macAddress, expiryDate, username, password } = req.body;

        // Create customer
        const customer = new Customer({
            name,
            email,
            phone,
            macAddress,
            expiryDate,
            status: 'active'
        });

        const savedCustomer = await customer.save();
        console.log('✅ Customer saved:', savedCustomer._id);

        // Create user account for customer 
        if (username && password) {
            const hashedPassword = await bcrypt.hash(password, 10);

            const user = new User({
                username,
                password: hashedPassword,
                email,
                role: 'customer',
                customerId: savedCustomer._id,
                isActive: true
            });

            const savedUser = await user.save();
            console.log('✅ User saved:', savedUser._id);
        }

        res.status(201).json({
            success: true,
            customer: savedCustomer
        });
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

// Get all customers
exports.getCustomers = async (req, res) => {
    try {
        console.log('📋 Fetching all customers');
        
        const customers = await Customer.find()
            .populate('playlists', 'name type lastSync')
            .lean();

        console.log(`✅ Found ${customers.length} customers`);

        res.json({
            success: true,
            customers: customers || []
        });
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({
            success: false,
            message: error.message,
            customers: []
        });
    }
};

// UPDATE customer - ADD THIS FUNCTION
exports.updateCustomer = async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        
        console.log('📝 Updating customer:', id, updates);

        // Remove fields that shouldn't be updated directly
        delete updates._id;
        delete updates.createdAt;
        
        const customer = await Customer.findByIdAndUpdate(
            id,
            { $set: updates },
            { new: true, runValidators: true }
        );
        
        if (!customer) {
            return res.status(404).json({
                success: false,
                message: 'Customer not found'
            });
        }

        // If username/password is being updated, update the associated user
        if (updates.username || updates.password) {
            const userUpdate = {};
            if (updates.username) userUpdate.username = updates.username;
            if (updates.password) {
                const hashedPassword = await bcrypt.hash(updates.password, 10);
                userUpdate.password = hashedPassword;
            }
            
            await User.findOneAndUpdate(
                { customerId: id },
                { $set: userUpdate }
            );
        }
        
        console.log('✅ Customer updated successfully');
        
        res.json({
            success: true,
            customer
        });
    } catch (error) {
        console.error('❌ Error updating customer:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

// DELETE customer - ADD THIS FUNCTION
exports.deleteCustomer = async (req, res) => {
    try {
        const { id } = req.params;
        console.log('🗑️ Deleting customer:', id);

        // Check if customer exists
        const customer = await Customer.findById(id);
        
        if (!customer) {
            return res.status(404).json({
                success: false,
                message: 'Customer not found'
            });
        }

        // Delete associated user account
        await User.deleteMany({ customerId: id });

        // Remove customer from any playlists
        await Playlist.updateMany(
            { assignedCustomers: id },
            { $pull: { assignedCustomers: id } }
        );

        // Delete the customer
        await Customer.findByIdAndDelete(id);

        console.log('✅ Customer deleted successfully');

        res.json({
            success: true,
            message: 'Customer deleted successfully'
        });
    } catch (error) {
        console.error('❌ Error deleting customer:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

// Assign playlist to customer
exports.assignPlaylist = async (req, res) => {
    try {
        const { customerId, playlistId } = req.params;
        console.log('🔗 Assigning playlist', playlistId, 'to customer', customerId);

        const customer = await Customer.findById(customerId);
        const playlist = await Playlist.findById(playlistId);

        if (!customer || !playlist) {
            return res.status(404).json({
                success: false,
                message: 'Customer or playlist not found'
            });
        }

        if (!customer.playlists.includes(playlistId)) {
            customer.playlists.push(playlistId);
            await customer.save();
        }

        if (!playlist.assignedCustomers.includes(customerId)) {
            playlist.assignedCustomers.push(customerId);
            await playlist.save();
        }

        console.log('✅ Playlist assigned successfully');
        res.json({
            success: true,
            message: 'Playlist assigned successfully'
        });
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

// Remove playlist from customer
exports.removePlaylist = async (req, res) => {
    try {
        const { customerId, playlistId } = req.params;
        console.log('🔗 Removing playlist', playlistId, 'from customer', customerId);

        await Customer.findByIdAndUpdate(customerId, {
            $pull: { playlists: playlistId }
        });

        await Playlist.findByIdAndUpdate(playlistId, {
            $pull: { assignedCustomers: customerId }
        });

        console.log('✅ Playlist removed successfully');
        res.json({
            success: true,
            message: 'Playlist removed successfully'
        });
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};