require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');

const User = require('./models/User');
const Group = require('./models/Group');
const generateUniqueCode = require('./utils/generateCode');
const Message = require('./models/Message');
const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ limit: '200mb', extended: true }));

// Create uploads directory if it doesn't exist
// On Vercel, use /tmp for temporary files (ephemeral storage)
// Note: Files in /tmp are deleted after function execution
// For production, consider using cloud storage (S3, Cloudinary, etc.)
const uploadsDir = process.env.VERCEL 
  ? path.join('/tmp', 'uploads')
  : path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Serve uploaded files statically
// On Vercel, files are served differently - consider using cloud storage URLs
app.use('/uploads', express.static(uploadsDir));

// Serve frontend files from the public directory
app.use(express.static(path.join(__dirname, '..', 'public')));

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    // Generate unique filename with timestamp
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'profile-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 150 * 1024 * 1024 // 150MB limit
  },
  fileFilter: function (req, file, cb) {
    // Allow any file type
    cb(null, true);
  }
});

// MongoDB connection
mongoose.connect(process.env.MONGO_URI);
const db = mongoose.connection;
db.on('error', console.error.bind(console, 'MongoDB connection error:'));
db.once('open', () => {
  console.log('Connected to MongoDB');
  // Initialize global group and admin
  (async () => {
    try {
      // Ensure admin user with code '0000' exists
      let adminUser = await User.findOne({ code: '0000' });
      if (!adminUser) {
        adminUser = new User({ username: 'admin', profilePicture: '', code: '0000' });
        await adminUser.save();
      }

      // Ensure the global group 'NIS Chat' exists
      let nisGroup = await Group.findOne({ name: 'NIS Chat' });
      if (!nisGroup) {
        const nisCode = await generateUniqueCode(Group);
        nisGroup = new Group({ name: 'NIS Chat', icon: '', code: nisCode, members: [], admins: ['0000'] });
        await nisGroup.save();
        console.log('Created global group NIS Chat with code:', nisCode);
      } else {
        // Ensure admin is listed
        if (!nisGroup.admins.includes('0000')) {
          nisGroup.admins.push('0000');
        }
      }

      // Ensure all existing users are in the group
      const allUsers = await User.find({}, 'code');
      const allCodes = allUsers.map(u => u.code).filter(Boolean);
      // Update group members (add missing)
      const currentMembers = new Set(nisGroup.members || []);
      for (const c of allCodes) {
        if (!currentMembers.has(c)) currentMembers.add(c);
      }
      nisGroup.members = Array.from(currentMembers);
      await nisGroup.save();

      // Ensure every user has group in their groups array
      await User.updateMany(
        { code: { $in: allCodes } },
        { $addToSet: { groups: nisGroup.code } }
      );

      // Cache global code for use in user creation
      global.GLOBAL_GROUP_CODE = nisGroup.code;
    } catch (e) {
      console.error('Initialization error (admin/global group):', e);
    }
  })();
});

// Store connected users by code
const connectedUsers = {};
const server = http.createServer(app);
// Socket.IO configuration - may not work on Vercel serverless
// For production, consider using a separate WebSocket service
const io = new Server(server, { 
  cors: { origin: '*' },
  transports: ['websocket', 'polling'] // Fallback to polling if websocket fails
});

io.on('connection', (socket) => {
  socket.on('register', async (code) => {
    connectedUsers[code] = socket.id;
    
    // Update user's online status
    try {
      await User.findOneAndUpdate(
        { code: code },
        { 
          isOnline: true,
          lastSeen: new Date()
        }
      );
      
      // Notify contacts that user is online
      const user = await User.findOne({ code: code });
      if (user && user.contacts.length > 0) {
        user.contacts.forEach(contactCode => {
          if (connectedUsers[contactCode]) {
            io.to(connectedUsers[contactCode]).emit('user-status-changed', {
              userCode: code,
              isOnline: true,
              lastSeen: new Date()
            });
          }
        });
      }
    } catch (err) {
      console.error('Error updating online status:', err);
    }
  });

  socket.on('call-user', ({ targetCode, offer, callerCode, callType }) => {
    if (!targetCode || !offer || !callerCode) return;
    const targetSocketId = connectedUsers[targetCode];
    if (!targetSocketId) {
      socket.emit('call-unavailable', { targetCode });
      return;
    }
    io.to(targetSocketId).emit('incoming-call', {
      callerCode,
      callType: callType === 'video' ? 'video' : 'audio',
      offer
    });
  });

  socket.on('answer-call', ({ callerCode, answer, responderCode }) => {
    if (!callerCode || !answer) return;
    const callerSocketId = connectedUsers[callerCode];
    if (!callerSocketId) return;
    io.to(callerSocketId).emit('call-accepted', {
      responderCode,
      answer
    });
  });

  socket.on('reject-call', ({ callerCode, responderCode }) => {
    if (!callerCode) return;
    const callerSocketId = connectedUsers[callerCode];
    if (!callerSocketId) return;
    io.to(callerSocketId).emit('call-rejected', { responderCode });
  });

  socket.on('call-busy', ({ callerCode, responderCode }) => {
    if (!callerCode) return;
    const callerSocketId = connectedUsers[callerCode];
    if (!callerSocketId) return;
    io.to(callerSocketId).emit('call-busy', { responderCode });
  });

  socket.on('end-call', ({ targetCode, senderCode, reason }) => {
    if (!targetCode) return;
    const targetSocketId = connectedUsers[targetCode];
    if (targetSocketId) {
      io.to(targetSocketId).emit('call-ended', { senderCode, reason: reason || 'ended' });
    }
    socket.emit('call-ended', { senderCode, reason: reason || 'ended' });
  });

  socket.on('ice-candidate', ({ targetCode, candidate, senderCode }) => {
    if (!targetCode || !candidate) return;
    const targetSocketId = connectedUsers[targetCode];
    if (!targetSocketId) return;
    io.to(targetSocketId).emit('ice-candidate', { candidate, senderCode });
  });

  // Real-time message event
  socket.on('send-message', async (data) => {
    // data: { senderCode, receiverCode, content, type, fileName, caption, replyTo }
    const { senderCode, receiverCode, content, type = 'text', fileName, caption, replyTo } = data;
    if (!senderCode || !receiverCode || !content) return;
    
    try {
      // Save message to DB
      const msg = new Message({
        senderCode,
        receiverCode,
        groupCode: null, // For 1-1 chat, groupCode is null
        content,
        type,
        fileName: fileName || null,
        caption: caption || null,
        replyTo: replyTo || null,
        timestamp: new Date(),
      });
      await msg.save();
      
      // Emit to sender and receiver if online
      if (connectedUsers[senderCode]) {
        io.to(connectedUsers[senderCode]).emit('new-message', { ...msg.toObject(), self: true });
      }
      if (connectedUsers[receiverCode]) {
        io.to(connectedUsers[receiverCode]).emit('new-message', { ...msg.toObject(), self: false });
      }
    } catch (err) {
      console.error('Error saving message:', err);
    }
  });

  // Real-time GROUP message event
  socket.on('send-group-message', async (data) => {
    // data: { senderCode, groupCode, content, type, fileName, caption, replyTo }
    const { senderCode, groupCode, content, type = 'text', fileName, caption, replyTo } = data;
    if (!senderCode || !groupCode || !content) return;
    try {
      const group = await Group.findOne({ code: groupCode });
      if (!group) return;
      // Save message to DB
      const msg = new Message({
        senderCode,
        receiverCode: null,
        groupCode: groupCode,
        content,
        type,
        fileName: fileName || null,
        caption: caption || null,
        replyTo: replyTo || null,
        timestamp: new Date(),
      });
      await msg.save();
      // Emit to all group members online
      const recipients = new Set([...(group.members || []), ...(group.admins || [])]);
      recipients.forEach(memberCode => {
        if (connectedUsers[memberCode]) {
          io.to(connectedUsers[memberCode]).emit('new-group-message', { ...msg.toObject(), self: memberCode === senderCode });
        }
      });
    } catch (err) {
      console.error('Error saving group message:', err);
    }
  });

  socket.on('disconnect', async () => {
    let disconnectedUserCode = null;
    
    for (const code in connectedUsers) {
      if (connectedUsers[code] === socket.id) {
        disconnectedUserCode = code;
        delete connectedUsers[code];
        break;
      }
    }
    
    // Update user's offline status
    if (disconnectedUserCode) {
      try {
        await User.findOneAndUpdate(
          { code: disconnectedUserCode },
          { 
            isOnline: false,
            lastSeen: new Date()
          }
        );
        
        // Notify contacts that user is offline
        const user = await User.findOne({ code: disconnectedUserCode });
        if (user && user.contacts.length > 0) {
          user.contacts.forEach(contactCode => {
            if (connectedUsers[contactCode]) {
              io.to(connectedUsers[contactCode]).emit('user-status-changed', {
                userCode: disconnectedUserCode,
                isOnline: false,
                lastSeen: new Date()
              });
            }
          });
        }
      } catch (err) {
        console.error('Error updating offline status:', err);
      }
    }
  });
});

// Root endpoint - serve the main HTML page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Create user
app.post('/users', async (req, res) => {
  try {
    const { username, profilePicture, deviceId, isDeviceLocked } = req.body;
    const code = await generateUniqueCode(User);

    const user = new User({ 
      username, 
      profilePicture, 
      code,
      deviceId: typeof deviceId === 'string' && deviceId.length > 0 ? deviceId : undefined,
      isDeviceLocked: typeof isDeviceLocked === 'boolean' ? isDeviceLocked : undefined
    });
    await user.save();
    // Respond first to avoid any failure blocking creation
    res.status(201).json(user);
    // Fire-and-forget: add user to global group 'NIS Chat' if initialized
    setImmediate(async () => {
      try {
        const nisGroup = await Group.findOne({ name: 'NIS Chat' });
        if (nisGroup) {
          let changed = false;
          if (!nisGroup.members.includes(code)) {
            nisGroup.members.push(code);
            changed = true;
          }
          if (changed) await nisGroup.save();
          // Update user doc to include group code if missing
          await User.updateOne({ code }, { $addToSet: { groups: nisGroup.code } });
        }
      } catch (e) {
        console.error('Failed to add user to global group:', e);
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get user by deviceId (for restoring same account across IP/base URL changes)
app.get('/users/by-device/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    if (!deviceId || deviceId.trim().length === 0) return res.status(400).json({ error: 'deviceId is required' });
    const user = await User.findOne({ deviceId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create group
app.post('/groups', async (req, res) => {
  try {
    const { name, icon, members, admins, invitationMessage } = req.body;
    const code = await generateUniqueCode(Group);
    const group = new Group({ name, icon, code, members, admins });
    await group.save();
    console.log('Created group:', group.toObject()); // Debug log

    // Add this group code to each member's groups array (including the creator)
    const allMembers = [...members, admins[0]]; // Include creator in members list
    console.log('Adding group code', code, 'to members:', allMembers); // Debug log
    
    if (Array.isArray(allMembers)) {
      const result = await User.updateMany(
        { code: { $in: allMembers } },
        { $addToSet: { groups: code } }
      );
      console.log('Updated users result:', result); // Debug log
    }

    // Send invitation messages to all members
    if (Array.isArray(members) && invitationMessage) {
      const creator = await User.findOne({ code: admins[0] });
      const creatorName = creator ? creator.username : 'Unknown';
      
      members.forEach(async (memberCode) => {
        if (memberCode !== admins[0]) { // Don't send invitation to creator
          const invitationMsg = new Message({
            senderCode: admins[0],
            receiverCode: memberCode,
            groupCode: null, // This is a direct invitation message
            content: `You have been invited to join "${name}" by ${creatorName}. Group code: ${code}`,
            type: 'text',
            timestamp: new Date(),
          });
          await invitationMsg.save();
          
          // Emit real-time invitation if user is online
          if (connectedUsers[memberCode]) {
            io.to(connectedUsers[memberCode]).emit('new-message', { ...invitationMsg.toObject(), self: false });
          }
        }
      });
    }

    res.status(201).json(group);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get user by code
app.get('/users/:code', async (req, res) => {
  try {
    const user = await User.findOne({ code: req.params.code });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update user by code
app.patch('/users/:code', async (req, res) => {
  try {
    const user = await User.findOneAndUpdate(
      { code: req.params.code },
      req.body,
      { new: true }
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get group by code
app.get('/groups/:code', async (req, res) => {
  console.log('HIT: /groups/:code', req.params.code);
  try {
    const group = await Group.findOne({ code: req.params.code });
    if (!group) return res.status(404).json({ error: 'Group not found' });
    res.json(group);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add contact by code
app.post('/users/:code/add-contact', async (req, res) => {
  try {
    const user = await User.findOne({ code: req.params.code });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { contactCode } = req.body;
    if (!contactCode) return res.status(400).json({ error: 'contactCode is required' });
    if (contactCode === user.code) return res.status(400).json({ error: 'Cannot add yourself as a contact' });

    const contact = await User.findOne({ code: contactCode });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    // Prevent duplicates
    if (user.contacts.includes(contactCode)) {
      return res.status(400).json({ error: 'Contact already added' });
    }

    user.contacts.push(contactCode);
    await user.save();
    res.json({ message: 'Contact added', user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove contact by code (two-way, real-time)
app.post('/users/:code/remove-contact', async (req, res) => {
  try {
    const user = await User.findOne({ code: req.params.code });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { contactCode } = req.body;
    if (!contactCode) return res.status(400).json({ error: 'contactCode is required' });

    // Remove the contact code from the user's contacts array
    user.contacts = user.contacts.filter(code => code !== contactCode);
    await user.save();

    // Remove this user from the contact's contacts array
    const contact = await User.findOne({ code: contactCode });
    if (contact) {
      contact.contacts = contact.contacts.filter(code => code !== user.code);
      await contact.save();
    }

    // Emit real-time update to both users
    if (connectedUsers[user.code]) {
      io.to(connectedUsers[user.code]).emit('contacts-updated');
    }
    if (connectedUsers[contactCode]) {
      io.to(connectedUsers[contactCode]).emit('contacts-updated');
    }

    res.json({ message: 'Contact removed!', user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get a user's contacts
app.get('/users/:code/contacts', async (req, res) => {
  try {
    const user = await User.findOne({ code: req.params.code });
    if (!user) return res.status(404).json({ error: 'User not found' });
    // Find all users whose code is in user.contacts
    const contacts = await User.find({ code: { $in: user.contacts } });
    res.json(contacts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get a user's groups
app.get('/users/:code/groups', async (req, res) => {
  try {
    const user = await User.findOne({ code: req.params.code });
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    console.log('User', req.params.code, 'has groups array:', user.groups); // Debug log
    
    // Find all groups whose code is in user.groups
    const groups = await Group.find({ code: { $in: user.groups } });
    console.log('Found groups for user:', groups); // Debug log
    
    res.json(groups);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Join a group by code
app.post('/users/:code/join-group', async (req, res) => {
  try {
    const { code } = req.params;
    const { groupCode } = req.body;
    if (!groupCode || typeof groupCode !== 'string' || groupCode.length !== 4) {
      return res.status(400).json({ error: 'Valid 4-digit groupCode is required' });
    }
    const user = await User.findOne({ code });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const group = await Group.findOne({ code: groupCode });
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (group.joinDisabled) return res.status(403).json({ error: 'Joining this group is disabled' });
    if (group.banned && group.banned.includes(code)) return res.status(403).json({ error: 'You are banned from this group' });

    // Add group to user's groups
    if (!user.groups.includes(groupCode)) {
      user.groups.push(groupCode);
      await user.save();
    }
    // Add user to group members
    if (!group.members.includes(code) && !group.admins.includes(code)) {
      group.members.push(code);
      await group.save();
    }

    return res.json({ message: 'Joined group', user, group });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update group settings (admin only)
app.patch('/groups/:groupCode', async (req, res) => {
  try {
    const { groupCode } = req.params;
    const { requesterCode, name, icon, joinDisabled } = req.body;
    const group = await Group.findOne({ code: groupCode });
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (!group.admins.includes(requesterCode)) return res.status(403).json({ error: 'Not authorized' });
    if (typeof name === 'string' && name.trim().length > 0) group.name = name.trim();
    if (typeof icon === 'string') group.icon = icon;
    if (typeof joinDisabled === 'boolean') group.joinDisabled = joinDisabled;
    await group.save();
    res.json(group);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Kick a member (admin only)
app.post('/groups/:groupCode/kick', async (req, res) => {
  try {
    const { groupCode } = req.params;
    const { requesterCode, targetCode } = req.body;
    const group = await Group.findOne({ code: groupCode });
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (!group.admins.includes(requesterCode)) return res.status(403).json({ error: 'Not authorized' });
    // Prevent kicking other admins (for now)
    if (group.admins.includes(targetCode)) return res.status(400).json({ error: 'Cannot kick an admin' });
    group.members = (group.members || []).filter(c => c !== targetCode);
    group.muted = (group.muted || []).filter(c => c !== targetCode);
    await group.save();
    // Remove group from user's groups
    await User.updateOne({ code: targetCode }, { $pull: { groups: groupCode } });
    
    // Emit real-time update to all group members
    const allMembers = [...(group.members || []), ...(group.admins || [])];
    allMembers.forEach(memberCode => {
      if (connectedUsers[memberCode]) {
        io.to(connectedUsers[memberCode]).emit('group-updated', { groupCode, action: 'member-kicked', targetCode });
      }
    });
    
    // Notify the kicked user
    if (connectedUsers[targetCode]) {
      io.to(connectedUsers[targetCode]).emit('group-kicked', { groupCode, groupName: group.name });
    }
    
    res.json({ message: 'Member kicked', group });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove user from a group (leave group)
app.delete('/users/:code/groups/:groupCode', async (req, res) => {
  try {
    const { code, groupCode } = req.params;
    const user = await User.findOne({ code });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const group = await Group.findOne({ code: groupCode });
    if (!group) return res.status(404).json({ error: 'Group not found' });

    // Remove group from user's groups list
    user.groups = (user.groups || []).filter(c => c !== groupCode);
    await user.save();

    // Remove user from group members/admins
    group.members = (group.members || []).filter(c => c !== code);
    group.admins = (group.admins || []).filter(c => c !== code);
    await group.save();

    res.json({ message: 'Left group', user, group });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send contact request
app.post('/users/:code/send-request', async (req, res) => {
  try {
    const user = await User.findOne({ code: req.params.code });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { contactCode } = req.body;
    if (!contactCode) return res.status(400).json({ error: 'contactCode is required' });
    if (contactCode === user.code) return res.status(400).json({ error: 'Cannot add yourself' });
    const contact = await User.findOne({ code: contactCode });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    if (user.contacts.includes(contactCode)) return res.status(400).json({ error: 'Already a contact' });
    if (user.pending.includes(contactCode)) return res.status(400).json({ error: 'Already pending' });
    user.pending.push(contactCode);
    contact.requests.push(user.code);
    await user.save();
    await contact.save();
    // Emit real-time update to contact (receiver)
    if (connectedUsers[contactCode]) {
      io.to(connectedUsers[contactCode]).emit('requests-updated');
    }
    if (connectedUsers[user.code]) {
      io.to(connectedUsers[user.code]).emit('pending-updated');
    }
    res.json({ message: 'Request sent' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get pending list
app.get('/users/:code/pending', async (req, res) => {
  try {
    const user = await User.findOne({ code: req.params.code });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const pendingUsers = await User.find({ code: { $in: user.pending } });
    res.json(pendingUsers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get requests list
app.get('/users/:code/requests', async (req, res) => {
  try {
    const user = await User.findOne({ code: req.params.code });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const requestUsers = await User.find({ code: { $in: user.requests } });
    res.json(requestUsers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Accept request
app.post('/users/:code/accept-request', async (req, res) => {
  try {
    const user = await User.findOne({ code: req.params.code });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { requesterCode } = req.body;
    if (!requesterCode) return res.status(400).json({ error: 'requesterCode is required' });
    const requester = await User.findOne({ code: requesterCode });
    if (!requester) return res.status(404).json({ error: 'Requester not found' });
    // Remove from requests/pending
    user.requests = user.requests.filter(c => c !== requesterCode);
    requester.pending = requester.pending.filter(c => c !== user.code);
    // Add to contacts
    if (!user.contacts.includes(requesterCode)) user.contacts.push(requesterCode);
    if (!requester.contacts.includes(user.code)) requester.contacts.push(user.code);
    await user.save();
    await requester.save();
    // Emit real-time update to both users
    if (connectedUsers[user.code]) {
      io.to(connectedUsers[user.code]).emit('requests-updated');
    }
    if (connectedUsers[requesterCode]) {
      io.to(connectedUsers[requesterCode]).emit('pending-updated');
    }
    res.json({ message: 'Request accepted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Decline request
app.post('/users/:code/decline-request', async (req, res) => {
  try {
    const user = await User.findOne({ code: req.params.code });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { requesterCode } = req.body;
    if (!requesterCode) return res.status(400).json({ error: 'requesterCode is required' });
    const requester = await User.findOne({ code: requesterCode });
    if (!requester) return res.status(404).json({ error: 'Requester not found' });
    // Remove from requests/pending
    user.requests = user.requests.filter(c => c !== requesterCode);
    requester.pending = requester.pending.filter(c => c !== user.code);
    await user.save();
    await requester.save();
    // Emit real-time update to both users
    if (connectedUsers[user.code]) {
      io.to(connectedUsers[user.code]).emit('requests-updated');
    }
    if (connectedUsers[requesterCode]) {
      io.to(connectedUsers[requesterCode]).emit('pending-updated');
    }
    res.json({ message: 'Request declined' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancel a pending request
app.post('/users/:code/cancel-pending', async (req, res) => {
  try {
    const user = await User.findOne({ code: req.params.code });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { contactCode } = req.body;
    if (!contactCode) return res.status(400).json({ error: 'contactCode is required' });
    const contact = await User.findOne({ code: contactCode });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    // Remove contactCode from user's pending
    user.pending = user.pending.filter(c => c !== contactCode);
    // Remove user's code from contact's requests
    contact.requests = contact.requests.filter(c => c !== user.code);
    await user.save();
    await contact.save();
    // Emit real-time update to both users
    if (connectedUsers[user.code]) {
      io.to(connectedUsers[user.code]).emit('pending-updated');
    }
    if (connectedUsers[contactCode]) {
      io.to(connectedUsers[contactCode]).emit('requests-updated');
    }
    res.json({ message: 'Pending request cancelled' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update last used timestamp
app.post('/users/:code/update-last-used', async (req, res) => {
  try {
    const user = await User.findOneAndUpdate(
      { code: req.params.code },
      { lastUsedAt: new Date() },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ message: 'Last used timestamp updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get most recently used profile (for automatic restoration)
app.get('/users/most-recent', async (req, res) => {
  try {
    const user = await User.findOne().sort({ lastUsedAt: -1 });
    if (!user) return res.status(404).json({ error: 'No users found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cleanup old unused profiles (older than 30 days)
app.delete('/users/cleanup-old', async (req, res) => {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const result = await User.deleteMany({
      lastUsedAt: { $lt: thirtyDaysAgo },
      contacts: { $size: 0 }, // Only delete profiles with no contacts
      groups: { $size: 0 }    // and no groups
    });
    
    res.json({ 
      message: `Cleaned up ${result.deletedCount} old unused profiles`,
      deletedCount: result.deletedCount 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload profile picture
app.post('/users/:code/upload-profile-picture', upload.single('profilePicture'), async (req, res) => {
  try {
    const user = await User.findOne({ code: req.params.code });
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Delete old profile picture if it exists and is not the default
    if (user.profilePicture && !user.profilePicture.includes('dicebear.com')) {
      const oldPicturePath = path.join(__dirname, 'uploads', path.basename(user.profilePicture));
      if (fs.existsSync(oldPicturePath)) {
        fs.unlinkSync(oldPicturePath);
      }
    }

    // Update user's profile picture with the new file URL
    // Detect the host automatically (works for both localhost and production)
    const host = req.get('host'); 
    const protocol = req.protocol;
    // For Vercel/production, use /api prefix for API routes
    const isProduction = !host.includes('localhost') && !host.includes('127.0.0.1');
    const apiPrefix = isProduction ? '/api' : '';
    const fileUrl = `${protocol}://${host}${apiPrefix}/uploads/${req.file.filename}`;
    user.profilePicture = fileUrl;
    await user.save();

    res.json({ 
      message: 'Profile picture uploaded successfully',
      profilePicture: fileUrl,
      user: user
    });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Error handling middleware for multer errors
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 150MB.' });
    }
    return res.status(400).json({ error: 'File upload error: ' + error.message });
  }
  if (error) {
    return res.status(500).json({ error: error.message });
  }
  next();
});

// Delete profile picture (reset to default)
app.delete('/users/:code/profile-picture', async (req, res) => {
  try {
    const user = await User.findOne({ code: req.params.code });
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Delete old profile picture file if it exists and is not the default
    if (user.profilePicture && !user.profilePicture.includes('dicebear.com')) {
      const oldPicturePath = path.join(__dirname, 'uploads', path.basename(user.profilePicture));
      if (fs.existsSync(oldPicturePath)) {
        fs.unlinkSync(oldPicturePath);
      }
    }

    // Reset to default profile picture
    user.profilePicture = '';
    await user.save();

    res.json({ 
      message: 'Profile picture reset to default',
      user: user
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fix profile picture URLs (admin endpoint to correct port issues)
app.post('/admin/fix-profile-pictures', async (req, res) => {
  try {
    const requesterCode = req.query.requesterCode;
    if (!isAdminCode(requesterCode)) return res.status(403).json({ error: 'Not authorized' });

    const users = await User.find({ profilePicture: { $exists: true, $ne: '' } });
    let fixedCount = 0;

    for (const user of users) {
      if (user.profilePicture && (user.profilePicture.includes(':3000') || user.profilePicture.includes(':5000'))) {
        const host = req.get('host');
        const protocol = req.protocol;
        const isProduction = !host.includes('localhost') && !host.includes('127.0.0.1');
        const apiPrefix = isProduction ? '/api' : '';
        // This regex removes the old port and replaces it with the current actual host
        user.profilePicture = user.profilePicture.replace(/:\d+\/uploads\//, `${apiPrefix}/uploads/`);
        // Ensure full URL
        if (!user.profilePicture.startsWith('http')) {
          user.profilePicture = `${protocol}://${host}${user.profilePicture}`;
        }
        await user.save();
        fixedCount++;
      }
    }

    res.json({ 
      message: `Fixed ${fixedCount} profile picture URLs`,
      fixedCount 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Set or change user password
app.post('/users/:code/set-password', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters.' });
    const user = await User.findOne({ code: req.params.code });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const hash = await bcrypt.hash(password, 10);
    user.password = hash;
    await user.save();
    res.json({ message: 'Password set successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Restore profile with password check
app.post('/users/:code/restore', async (req, res) => {
  try {
    const { password } = req.body;
    const user = await User.findOne({ code: req.params.code });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.password) {
      if (!password) return res.status(401).json({ error: 'Password required' });
      const match = await bcrypt.compare(password, user.password);
      if (!match) return res.status(401).json({ error: 'Incorrect password' });
    }
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Device-locked profile check (code "0000")
app.post('/users/0000/device-check', async (req, res) => {
  try {
    const { password } = req.body;
    // Always return the same admin profile (code '0000'), but check password if set
    let adminProfile = await User.findOne({ code: '0000' });
    if (!adminProfile) {
      // Create the admin profile if it doesn't exist
      adminProfile = new User({ 
        username: 'admin', 
        profilePicture: '', 
        code: '0000',
        isDeviceLocked: false
      });
      await adminProfile.save();
    }
    if (adminProfile.password && adminProfile.password.length > 0) {
      if (!password) return res.status(401).json({ error: 'Password required' });
      const bcrypt = require('bcrypt');
      const match = await bcrypt.compare(password, adminProfile.password);
      if (!match) return res.status(401).json({ error: 'Incorrect password' });
    }
    res.json(adminProfile);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/test-hello', (req, res) => {
  res.send('Hello test!');
});

// --- Admin APIs ---
function isAdminCode(code) {
  return code === '0000' || code === '9999';
}

// List all users (admin only)
app.get('/admin/users', async (req, res) => {
  try {
    const requesterCode = req.query.requesterCode;
    if (!isAdminCode(requesterCode)) return res.status(403).json({ error: 'Not authorized' });
    const users = await User.find({}, { username: 1, code: 1, profilePicture: 1, isOnline: 1 }).sort({ createdAt: 1 });
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a user (admin only)
app.delete('/admin/users/:code', async (req, res) => {
  try {
    const requesterCode = req.query.requesterCode;
    if (!isAdminCode(requesterCode)) return res.status(403).json({ error: 'Not authorized' });
    const { code } = req.params;
    if (isAdminCode(code)) return res.status(400).json({ error: 'Cannot delete admin accounts' });

    // Get user's contacts before deletion for real-time updates
    const userToDelete = await User.findOne({ code });
    if (!userToDelete) return res.status(404).json({ error: 'User not found' });

    // Remove user from other users' arrays
    await User.updateMany({}, {
      $pull: {
        contacts: code,
        pending: code,
        requests: code,
        groups: { $in: [] } // no-op safeguard
      }
    });

    // Remove user from all groups
    await Group.updateMany({}, {
      $pull: {
        members: code,
        admins: code,
        muted: code,
        banned: code
      }
    });

    // Delete messages sent or received by user
    await Message.deleteMany({ $or: [ { senderCode: code }, { receiverCode: code } ] });

    // Finally delete the user
    const result = await User.deleteOne({ code });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'User not found' });
    
    // Emit real-time updates to all connected users
    Object.keys(connectedUsers).forEach(userCode => {
      if (connectedUsers[userCode]) {
        io.to(connectedUsers[userCode]).emit('user-deleted', { deletedUserCode: code });
      }
    });
    
    res.json({ message: 'User removed', code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a group (admin only)
app.delete('/admin/groups/:groupCode', async (req, res) => {
  try {
    const requesterCode = req.query.requesterCode;
    if (!isAdminCode(requesterCode)) return res.status(403).json({ error: 'Not authorized' });
    const { groupCode } = req.params;
    const group = await Group.findOne({ code: groupCode });
    if (!group) return res.status(404).json({ error: 'Group not found' });

    // Get all group members for real-time updates
    const allMembers = [...(group.members || []), ...(group.admins || [])];

    // Remove group from users
    await User.updateMany({ groups: groupCode }, { $pull: { groups: groupCode } });
    // Delete group messages
    await Message.deleteMany({ groupCode });
    // Delete group
    await Group.deleteOne({ code: groupCode });
    
    // Emit real-time updates to all group members
    allMembers.forEach(memberCode => {
      if (connectedUsers[memberCode]) {
        io.to(connectedUsers[memberCode]).emit('group-deleted', { groupCode, groupName: group.name });
      }
    });
    
    res.json({ message: 'Group removed', groupCode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ban user from a group (admin only)
app.post('/admin/groups/:groupCode/ban', async (req, res) => {
  try {
    const requesterCode = req.body.requesterCode;
    const { groupCode } = req.params;
    const { targetCode } = req.body;
    if (!isAdminCode(requesterCode)) return res.status(403).json({ error: 'Not authorized' });
    if (!targetCode) return res.status(400).json({ error: 'targetCode is required' });
    const group = await Group.findOne({ code: groupCode });
    if (!group) return res.status(404).json({ error: 'Group not found' });
    // Update group: add to banned, remove from members/admins/muted
    group.banned = Array.from(new Set([...(group.banned || []), targetCode]));
    group.members = (group.members || []).filter(c => c !== targetCode);
    group.admins = (group.admins || []).filter(c => c !== targetCode);
    group.muted = (group.muted || []).filter(c => c !== targetCode);
    await group.save();
    // Remove group from user
    await User.updateOne({ code: targetCode }, { $pull: { groups: groupCode } });
    res.json({ message: 'User banned from group', group });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- REST API: Fetch message history between two users ---
app.get('/messages/:user1/:user2', async (req, res) => {
  try {
    const { user1, user2 } = req.params;
    // Find all messages between user1 and user2 (1-1 chat)
    const messages = await Message.find({
      groupCode: null,
      $or: [
        { senderCode: user1, receiverCode: user2 },
        { senderCode: user2, receiverCode: user1 },
      ],
    }).sort({ timestamp: 1 });
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- REST API: Fetch group message history ---
app.get('/group-messages/:groupCode', async (req, res) => {
  try {
    const { groupCode } = req.params;
    const messages = await Message.find({ groupCode }).sort({ timestamp: 1 });
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- REST API: Update/edit a message ---
app.patch('/messages/:messageId', async (req, res) => {
  try {
    const { messageId } = req.params;
    const { content } = req.body;
    
    if (!content || content.trim() === '') {
      return res.status(400).json({ error: 'Message content is required' });
    }
    
    const message = await Message.findById(messageId);
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }
    
    message.content = content.trim();
    await message.save();
    
    // Emit real-time update to both users
    if (connectedUsers[message.senderCode]) {
      io.to(connectedUsers[message.senderCode]).emit('message-updated', message);
    }
    if (connectedUsers[message.receiverCode]) {
      io.to(connectedUsers[message.receiverCode]).emit('message-updated', message);
    }
    
    res.json(message);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- REST API: Delete a message (mark as deleted) ---
app.delete('/messages/:messageId', async (req, res) => {
  try {
    const { messageId } = req.params;
    const { deletedBy } = req.body; // The user code who deleted the message
    
    const message = await Message.findById(messageId);
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }
    
    // Only allow the sender to delete their own message
    if (message.senderCode !== deletedBy) {
      return res.status(403).json({ error: 'You can only delete their own messages' });
    }
    
    // Mark message as deleted and update content
    message.deleted = true;
    message.content = 'This message was deleted';
    await message.save();
    
    // Emit real-time update to both users
    if (connectedUsers[message.senderCode]) {
      io.to(connectedUsers[message.senderCode]).emit('message-updated', message);
    }
    if (connectedUsers[message.receiverCode]) {
      io.to(connectedUsers[message.receiverCode]).emit('message-updated', message);
    }
    
    res.json(message);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Graceful shutdown handlers
process.on('SIGINT', async () => {
  console.log('\n🛑 Received SIGINT (Ctrl+C). Starting graceful shutdown...');
  
  try {
    // Close all user connections and update their offline status
    console.log('📤 Updating user offline status...');
    const userCodes = Object.keys(connectedUsers);
    for (const userCode of userCodes) {
      try {
        await User.findOneAndUpdate(
          { code: userCode },
          { 
            isOnline: false,
            lastSeen: new Date()
          }
        );
      } catch (err) {
        console.error(`Error updating offline status for user ${userCode}:`, err);
      }
    }
    
    // Close Socket.IO server
    console.log('🔌 Closing Socket.IO connections...');
    io.close(() => {
      console.log('✅ Socket.IO server closed');
    });
    
    // Close HTTP server
    console.log('🌐 Closing HTTP server...');
    server.close(() => {
      console.log('✅ HTTP server closed');
      
      // Close MongoDB connection
      console.log('🗄️ Closing MongoDB connection...');
      mongoose.connection.close(false, () => {
        console.log('✅ MongoDB connection closed');
        console.log('👋 Graceful shutdown completed. Goodbye!');
        process.exit(0);
      });
    });
    
  } catch (err) {
    console.error('❌ Error during graceful shutdown:', err);
    process.exit(1);
  }
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Received SIGTERM. Starting graceful shutdown...');
  // Same graceful shutdown process as SIGINT
  process.emit('SIGINT');
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Export for Vercel serverless functions
// Vercel will use this as the handler
module.exports = app;

// Only start the server if not in Vercel environment
// Vercel uses serverless functions, so we don't need to listen on a port
if (process.env.VERCEL !== '1') {
  // Start server with Socket.IO (for local development)
  const PORT = process.env.PORT || 5000;
  server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📱 Frontend should be available at the served URL`);
    console.log(`🛑 Press Ctrl+C to stop the server gracefully`);
  });
} else {
  // In Vercel, Socket.IO won't work with serverless functions
  // You'll need a separate service for real-time features
  console.log('⚠️  Running on Vercel - Socket.IO real-time features may not work');
  console.log('💡 Consider using a separate WebSocket service for production');
}