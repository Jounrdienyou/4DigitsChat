const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  senderCode: { type: String, required: true },
  receiverCode: { type: String, required: false, default: null },
  groupCode: { type: String, required: false, default: null },
  content: { type: String, required: true },
  type: { type: String, enum: ['text', 'image', 'video', 'audio', 'document', 'archive', 'other'], default: 'text' },
  fileName: { type: String, required: false, default: null },
  caption: { type: String, required: false, default: null },
  replyTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', required: false, default: null },
  timestamp: { type: Date, default: Date.now },
  deleted: { type: Boolean, default: false },
});

module.exports = mongoose.model('Message', messageSchema); 