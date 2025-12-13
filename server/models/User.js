const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username: { type: String, required: true },
  profilePicture: { type: String, default: '' },
  password: { type: String, default: '' }, // hashed password for user
  code: { type: String, required: true, unique: true }, // 4-digit code as string
  groups: [{ type: String }], // array of group codes
  contacts: [{ type: String }], // array of user codes
  pending: [{ type: String }], // codes of users this user has sent requests to
  requests: [{ type: String }], // codes of users who have sent requests to this user
  lastUsedAt: { type: Date, default: Date.now }, // Track when profile was last accessed
  lastSeen: { type: Date, default: Date.now }, // Track when user was last online
  isOnline: { type: Boolean, default: false }, // Track if user is currently online
  deviceId: { type: String }, // For device-locked profiles
  isDeviceLocked: { type: Boolean, default: false }, // Flag for device-locked profiles
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema); 