const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const auth = require('../middleware/auth');

router.post('/register', authController.register);
router.post('/login', authController.login);
router.get('/verify', auth, authController.verifyToken);
router.post('/change-password', auth, authController.changePassword);

module.exports = router;