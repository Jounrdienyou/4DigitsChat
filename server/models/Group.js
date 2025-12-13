const mongoose = require('mongoose');

const groupSchema = new mongoose.Schema({
  name: { type: String, required: true },
  icon: { type: String, default: '' },
  code: { type: String, required: true, unique: true }, // 4-digit code as string
  members: [{ type: String }], // array of user codes
  admins: [{ type: String }], // array of user codes
  messages: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Message' }],
  joinDisabled: { type: Boolean, default: false },
  muted: [{ type: String }], // user codes muted in this group
  banned: [{ type: String }], // user codes banned from this group
}, { timestamps: true });

module.exports = mongoose.model('Group', groupSchema); 