document.addEventListener('DOMContentLoaded', function() {
  // --- Dynamic API base and Socket base ---
  // Determine API base that works across networks
  const DEFAULT_API_BASE = (() => {
    try {
      const { protocol, hostname, port } = window.location;
      if (protocol === 'file:') return 'http://localhost:5000';
      // Always use port 5000 for backend API, regardless of frontend port
      if (port && port !== '5000') return `${protocol}//${hostname}:5000`;
      // If no port or already 5000
      return `${protocol}//${hostname}${port ? ':' + port : ''}`;
    } catch (_) {
      return 'http://localhost:5000';
    }
  })().replace(/\/$/, '');
  const API_BASE = (localStorage.getItem('API_BASE') || DEFAULT_API_BASE).replace(/\/$/, '');
  function api(path) { return `${API_BASE}${path}`; }
  function socketBase() { return API_BASE; }
  const userCache = new Map();
  const pendingUserLookups = new Set();
  const rtcConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };
  let peerConnection = null;
  let localStream = null;
  let remoteStream = null;
  let currentCallTarget = null;
  let currentCallType = 'audio';
  let incomingCallData = null;
  let micEnabled = true;
  let cameraEnabled = true;
  const RINGTONE_SRC = 'assets/ringtone.mp3';
  const NOTIFICATION_SRC = 'assets/notification.mp3';
  let ringtoneAudio = null;
  
  // Helper function to fix URLs that point to wrong port
  function fixUrlPort(url) {
    if (url && url.includes(':3000/uploads/')) {
      return url.replace(':3000/uploads/', ':5000/uploads/');
    }
    return url;
  }

  // Helper function to find user by code with better fallback
  function findUserByCode(userCode) {
    if (!userCode) {
      return { code: '', username: 'Unknown User', profilePicture: '' };
    }

    if (userCache.has(userCode)) {
      return userCache.get(userCode);
    }

    let user = contacts.find(c => c.code === userCode);
    if (user) {
      userCache.set(userCode, user);
      return user;
    }
    
    user = allUsers.find(u => u.code === userCode);
    if (user) {
      userCache.set(userCode, user);
      return user;
    }

    if (!pendingUserLookups.has(userCode)) {
      pendingUserLookups.add(userCode);
      fetch(api(`/users/${userCode}`))
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          pendingUserLookups.delete(userCode);
          if (data) {
            userCache.set(userCode, data);
            renderChatMessages();
          }
        })
        .catch(() => {
          pendingUserLookups.delete(userCode);
        });
    }
    
    return { code: userCode, username: 'Unknown User', profilePicture: '' };
  }

  // Helper function to get proper profile picture URL
  function getProfilePictureUrl(profilePicture, username, fallbackSeed = null) {
    if (profilePicture && profilePicture.length > 0) {
      // If it's already a full URL, check if it needs port correction
      if (profilePicture.startsWith('http://') || profilePicture.startsWith('https://')) {
        // Fix URLs that point to wrong port (3000 instead of 5000)
        if (profilePicture.includes(':3000/uploads/')) {
          return profilePicture.replace(':3000/uploads/', ':5000/uploads/');
        }
        return profilePicture;
      }
      // If it's a relative path, make it absolute
      if (profilePicture.startsWith('/uploads/')) {
        return `${API_BASE}${profilePicture}`;
      }
      // If it's just a filename, assume it's in uploads
      return `${API_BASE}/uploads/${profilePicture}`;
    }
    const seed = fallbackSeed || username || 'default';
    return `https://api.dicebear.com/7.x/thumbs/svg?seed=${encodeURIComponent(seed)}`;
  }
  // Prevent background scrolling when a modal is open
  function setModalOpen(isOpen) {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
  }

  // Prevent text selection and copying shortcuts
  document.addEventListener('keydown', function(e) {
    const tag = e.target.tagName;
    const isEditable = tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable;
    if (isEditable) return;

    const key = e.key.toLowerCase();
    const isDevShortcut =
      e.key === 'F12' ||
      (e.ctrlKey && e.shiftKey && (key === 'i' || key === 'j')) ||
      (e.ctrlKey && !e.shiftKey && key === 'u');

    if (isDevShortcut) {
      e.preventDefault();
      return false;
    }
  });

  // Additional protection against developer tools
  setInterval(function() {
    // Check if developer tools are open (basic detection)
    if (window.outerHeight - window.innerHeight > 200 || window.outerWidth - window.innerWidth > 200) {
      // Developer tools might be open, but we won't do anything drastic
      // Just log a warning
      console.clear();
      console.log('%cStop!', 'color: red; font-size: 50px; font-weight: bold;');
      console.log('%cThis is a browser feature intended for developers. If someone told you to copy-paste something here, it is a scam and will give them access to your account.', 'color: red; font-size: 16px;');
    }
  }, 1000);

  let notificationPermissionRequested = false;
  function requestNotificationPermission(force = false) {
    if (!force && notificationPermissionRequested) return;
    if (typeof Notification === 'undefined') return;

    if (Notification.permission === 'granted' || Notification.permission === 'denied') {
      notificationPermissionRequested = true;
      return;
    }

    try {
      Notification.requestPermission().then(permission => {
        if (permission !== 'default' || force) {
          notificationPermissionRequested = true;
        }
        if (permission === 'granted') {
          console.log('✅ Notification permission granted');
        }
      });
    } catch (_) {}
  }
  document.addEventListener('click', () => requestNotificationPermission(true), { once: true });

  // Disable console methods in production
  if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
    console.log = function() {};
    console.warn = function() {};
    console.error = function() {};
    console.info = function() {};
    console.debug = function() {};
  }
  // JS logic will go here
  const settingsBtn = document.getElementById('settings-btn');
  const settingsModal = document.getElementById('settings-modal');
  const closeSettings = document.getElementById('close-settings');
  const settingsContent = document.querySelector('.settings-content');
  const notification = document.getElementById('notification');
  const chatListContainer = document.getElementById('chat-list-container');
  const groupSettingsBtn = document.getElementById('group-settings-btn');
  const groupSettingsModal = document.getElementById('group-settings-modal');
  const closeGroupSettingsBtn = document.getElementById('close-group-settings');
  const groupSettingsName = document.getElementById('group-settings-name');
  const groupSettingsPic = document.getElementById('group-settings-pic');
  const groupSettingsPicInput = document.getElementById('group-settings-pic-input');
  const groupSettingsPicEdit = document.getElementById('group-settings-pic-edit');
  const groupSettingsPicControls = document.getElementById('group-settings-pic-controls');
  const groupSettingsPicImport = document.getElementById('group-settings-pic-import');
  const groupSettingsPicSave = document.getElementById('group-settings-pic-save');
  const groupSettingsPicCancel = document.getElementById('group-settings-pic-cancel');
  const groupJoinDisabledCheckbox = document.getElementById('group-join-disabled');
  const groupMembersList = document.getElementById('group-members-list');
  const saveGroupSettingsBtn = document.getElementById('save-group-settings-btn');
  const createGroupBtn = document.getElementById('create-group-btn');
  const createGroupModal = document.getElementById('create-group-modal');
  const closeCreateGroup = document.getElementById('close-create-group');
  const groupLogoCircle = document.getElementById('group-logo-circle');
  const groupLogoInput = document.getElementById('group-logo-input');
  const generateGroupCodeBtn = document.getElementById('generate-group-code');
  const groupCodeInput = document.getElementById('group-code');
  const joinChatBtn = document.getElementById('join-chat-btn');
  const joinGroupBtn = document.getElementById('join-group-btn');
  const joinChatModal = document.getElementById('join-chat-modal');
  const joinGroupModal = document.getElementById('join-group-modal');
  const closeJoinChat = document.getElementById('close-join-chat');
  const closeJoinGroup = document.getElementById('close-join-group');
  const joinCodeInput = document.getElementById('join-code');
  const joinGroupCodeInput = document.getElementById('join-group-code');
  const submitJoinCodeBtn = document.getElementById('submit-join-code');
  const submitJoinGroupCodeBtn = document.getElementById('submit-join-group-code');
  const adminPanel = document.getElementById('admin-panel');
  const blendOverlay = document.getElementById('blend-overlay');
  const adminBanCodeInput = document.getElementById('admin-ban-code');
  const adminBanGroupInput = document.getElementById('admin-ban-group');
  const adminBanBtn = document.getElementById('admin-ban-btn');
  const adminRemoveUserInput = document.getElementById('admin-remove-user-code');
  const adminRemoveUserBtn = document.getElementById('admin-remove-user-btn');
  const adminRemoveGroupInput = document.getElementById('admin-remove-group-code');
  const adminRemoveGroupBtn = document.getElementById('admin-remove-group-btn');
  const adminJoinGroupInput = document.getElementById('admin-join-group-code');
  const adminJoinGroupBtn = document.getElementById('admin-join-group-btn');
  const adminShowUsersBtn = document.getElementById('admin-show-users-btn');
  const adminFixProfilePicturesBtn = document.getElementById('admin-fix-profile-pictures-btn');
  const adminUsersList = document.getElementById('admin-users-list');
  const userInfoModal = document.getElementById('user-info-modal');
  const closeUserInfo = document.getElementById('close-user-info');
  const closeUserInfoBtn = document.getElementById('close-user-info-btn');
  const userInfoPic = document.getElementById('user-info-pic');
  const userInfoName = document.getElementById('user-info-name');
  const userInfoCode = document.getElementById('user-info-code');
  const sendFriendRequestBtn = document.getElementById('send-friend-request-btn');
  const audioCallBtn = document.getElementById('audio-call-btn');
  const videoCallBtn = document.getElementById('video-call-btn');
  const callModal = document.getElementById('call-modal');
  const callStatusText = document.getElementById('call-status-text');
  const incomingCallControls = document.getElementById('incoming-call-controls');
  const activeCallControls = document.getElementById('active-call-controls');
  const acceptCallBtn = document.getElementById('accept-call-btn');
  const declineCallBtn = document.getElementById('decline-call-btn');
  const endCallBtn = document.getElementById('end-call-btn');
  const toggleMicBtn = document.getElementById('toggle-mic-btn');
  const toggleCameraBtn = document.getElementById('toggle-camera-btn');
  const remoteVideo = document.getElementById('remote-video');
  const localVideo = document.getElementById('local-video');
  const callWrapper = callModal ? callModal.querySelector('.call-wrapper') : null;
  const callActionsRow = document.getElementById('call-actions-row');

  function showNotification(message) {
    const messageDiv = notification.querySelector('.notification-message');
    messageDiv.textContent = message;
    notification.classList.add('show');
    // Notification sound is only played for incoming messages, not general notifications
    setTimeout(() => {
      notification.classList.remove('show');
    }, 1400);
  }

  // --- Call / WebRTC helpers ---
  function updateCallStatus(text) {
    if (callStatusText) {
      callStatusText.textContent = text || '';
    }
  }

  function ensureRingtoneAudio() {
    if (!ringtoneAudio) {
      ringtoneAudio = new Audio(RINGTONE_SRC);
      ringtoneAudio.loop = true;
      ringtoneAudio.preload = 'auto';
    }
  }

  function startRingtone() {
    ensureRingtoneAudio();
    try {
      ringtoneAudio.currentTime = 0;
      ringtoneAudio.play().catch(() => {});
    } catch (_) {}
  }

  function stopRingtone() {
    if (ringtoneAudio) {
      try {
        ringtoneAudio.pause();
        ringtoneAudio.currentTime = 0;
      } catch (_) {}
    }
  }

  function playNotificationSound() {
    try {
      const audio = new Audio(NOTIFICATION_SRC);
      audio.play().catch(() => {});
    } catch (_) {}
  }

  function updateCallLayout() {
    if (callWrapper) {
      callWrapper.classList.toggle('audio-call', currentCallType !== 'video');
    }
  }

  function updateMediaButtons() {
    if (toggleMicBtn) {
      toggleMicBtn.innerHTML = micEnabled
        ? '<i class="fa-solid fa-microphone"></i>'
        : '<i class="fa-solid fa-microphone-slash"></i>';
    }
    if (toggleCameraBtn) {
      toggleCameraBtn.innerHTML = cameraEnabled
        ? '<i class="fa-solid fa-video"></i>'
        : '<i class="fa-solid fa-video-slash"></i>';
      toggleCameraBtn.classList.toggle('is-hidden', currentCallType !== 'video');
    }
  }

  function updateMuteIndicator(type, isMuted) {
    const indicator = document.getElementById(`${type}-mute-indicator`);
    if (indicator) {
      if (isMuted) {
        indicator.classList.remove('hidden');
      } else {
        indicator.classList.add('hidden');
      }
    }
  }

  function updateCameraOverlay(type, cameraOff) {
    const overlay = document.getElementById(`${type}-video-overlay`);
    const video = document.getElementById(`${type}-video`);
    if (overlay && video) {
      if (cameraOff) {
        overlay.classList.remove('hidden');
        // Set profile picture in overlay
        const picElement = document.getElementById(`${type}-profile-pic`);
        if (picElement) {
          if (type === 'local') {
            picElement.src = getProfilePictureUrl(currentUser.profilePicture, currentUser.username);
          } else if (currentCallTarget) {
            const remoteUser = findUserByCode(currentCallTarget);
            picElement.src = getProfilePictureUrl(remoteUser.profilePicture, remoteUser.username);
          }
        }
      } else {
        overlay.classList.add('hidden');
      }
    }
  }

  function showCallModal({ status = '', showIncoming = false, showActive = false } = {}) {
    if (!callModal) return;
    updateCallStatus(status);
    if (incomingCallControls) {
      incomingCallControls.classList.toggle('hidden', !showIncoming);
    }
    if (activeCallControls) {
      activeCallControls.classList.toggle('hidden', !showActive);
    }
    if (toggleMicBtn) {
      toggleMicBtn.disabled = !showActive;
    }
    if (toggleCameraBtn) {
      toggleCameraBtn.disabled = !showActive || currentCallType !== 'video';
    }
    if (endCallBtn) {
      endCallBtn.disabled = !showActive;
    }
    callModal.classList.remove('hidden');
    updateCallLayout();
    updateMediaButtons();
    setModalOpen(true);
  }

  function hideCallModal() {
    if (!callModal) return;
    callModal.classList.add('hidden');
    updateCallStatus('');
    setModalOpen(false);
  }

  function cleanupCall() {
    const hadSession = !!peerConnection || !!localStream || !!incomingCallData;
    stopRingtone();
    if (peerConnection) {
      try { peerConnection.close(); } catch (_) {}
      peerConnection.onicecandidate = null;
      peerConnection.ontrack = null;
      peerConnection.onconnectionstatechange = null;
    }
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
    }
    if (remoteStream) {
      remoteStream.getTracks().forEach(track => track.stop());
    }
    peerConnection = null;
    localStream = null;
    remoteStream = null;
    incomingCallData = null;
    currentCallTarget = null;
    micEnabled = true;
    cameraEnabled = true;
    if (remoteVideo) remoteVideo.srcObject = null;
    if (localVideo) localVideo.srcObject = null;
    if (toggleMicBtn) toggleMicBtn.disabled = true;
    if (toggleCameraBtn) toggleCameraBtn.disabled = true;
    if (endCallBtn) endCallBtn.disabled = true;
    // Reset indicators and overlays
    updateMuteIndicator('local', false);
    updateMuteIndicator('remote', false);
    updateCameraOverlay('local', false);
    updateCameraOverlay('remote', false);
    hideCallModal();
    updateMediaButtons();
    updateCallLayout();
    return hadSession;
  }

  function endCall(reason = 'ended') {
    if (socket && socket.connected && currentCallTarget) {
      socket.emit('end-call', {
        targetCode: currentCallTarget,
        senderCode: currentUser.code,
        reason
      });
    }
    const wasInCall = cleanupCall();
    if (wasInCall) {
      showNotification('Call ended.');
    }
  }

  async function prepareLocalStream(callType) {
    const constraints = {
      audio: true,
      video: callType === 'video'
    };
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      localStream = stream;
      micEnabled = true;
      cameraEnabled = callType === 'video';
      if (localVideo) {
        localVideo.srcObject = stream;
      }
      updateMediaButtons();
      return stream;
    } catch (err) {
      showNotification('Unable to access camera or microphone: ' + err.message);
      throw err;
    }
  }

  function createPeerConnection(partnerCode) {
    const pc = new RTCPeerConnection(rtcConfig);
    remoteStream = new MediaStream();
    if (remoteVideo) {
      remoteVideo.srcObject = remoteStream;
    }
    pc.onicecandidate = (event) => {
      if (event.candidate && socket && socket.connected) {
        socket.emit('ice-candidate', {
          targetCode: partnerCode,
          candidate: event.candidate,
          senderCode: currentUser.code
        });
      }
    };
    pc.ontrack = (event) => {
      if (!remoteStream) {
        remoteStream = new MediaStream();
        if (remoteVideo) {
          remoteVideo.srcObject = remoteStream;
        }
      }
      if (event.streams && event.streams[0]) {
        event.streams[0].getTracks().forEach(track => {
          if (!remoteStream.getTracks().includes(track)) {
            remoteStream.addTrack(track);
            // Monitor track state changes for mute/camera indicators
            track.onended = () => {
              if (track.kind === 'audio') {
                updateMuteIndicator('remote', true);
              } else if (track.kind === 'video') {
                updateCameraOverlay('remote', true);
              }
            };
            track.onmute = () => {
              if (track.kind === 'audio') {
                updateMuteIndicator('remote', true);
              } else if (track.kind === 'video') {
                updateCameraOverlay('remote', true);
              }
            };
            track.onunmute = () => {
              if (track.kind === 'audio') {
                updateMuteIndicator('remote', false);
              } else if (track.kind === 'video') {
                updateCameraOverlay('remote', false);
              }
            };
            // Check initial state
            if (track.kind === 'audio') {
              updateMuteIndicator('remote', !track.enabled || track.muted);
            } else if (track.kind === 'video') {
              updateCameraOverlay('remote', !track.enabled || track.muted);
            }
          }
        });
      } else if (event.track) {
        remoteStream.addTrack(event.track);
        const track = event.track;
        // Monitor track state changes
        track.onended = () => {
          if (track.kind === 'audio') {
            updateMuteIndicator('remote', true);
          } else if (track.kind === 'video') {
            updateCameraOverlay('remote', true);
          }
        };
        track.onmute = () => {
          if (track.kind === 'audio') {
            updateMuteIndicator('remote', true);
          } else if (track.kind === 'video') {
            updateCameraOverlay('remote', true);
          }
        };
        track.onunmute = () => {
          if (track.kind === 'audio') {
            updateMuteIndicator('remote', false);
          } else if (track.kind === 'video') {
            updateCameraOverlay('remote', false);
          }
        };
        // Check initial state
        if (track.kind === 'audio') {
          updateMuteIndicator('remote', !track.enabled || track.muted);
        } else if (track.kind === 'video') {
          updateCameraOverlay('remote', !track.enabled || track.muted);
        }
      }
    };
    pc.onconnectionstatechange = () => {
      if (!pc) return;
      const state = pc.connectionState;
      if (state === 'connected') {
        updateCallStatus('Call connected');
      }
      if (state === 'failed' || state === 'disconnected') {
        const hadSession = cleanupCall();
        if (hadSession) {
          showNotification('Call disconnected.');
        }
      }
    };
    return pc;
  }

  async function initiateCall(callType) {
    if (isGroupChat || !currentChatCode) {
      showNotification('Calls are available only in direct chats.');
      return;
    }
    if (!socket || !socket.connected) {
      showNotification('Cannot start call: connection lost.');
      return;
    }
    if (peerConnection) {
      showNotification('You are already in a call.');
      return;
    }
    currentCallTarget = currentChatCode;
    currentCallType = callType === 'video' ? 'video' : 'audio';
    try {
      await prepareLocalStream(currentCallType);
    } catch (_) {
      currentCallTarget = null;
      return;
    }
    peerConnection = createPeerConnection(currentCallTarget);
    if (localStream) {
      localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
    }
    try {
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      updateCallLayout();
      showCallModal({
        status: currentCallType === 'video' ? 'Calling... (video)' : 'Calling... (audio)',
        showIncoming: false,
        showActive: true
      });
      startRingtone();
      socket.emit('call-user', {
        targetCode: currentCallTarget,
        callerCode: currentUser.code,
        offer: peerConnection.localDescription,
        callType: currentCallType
      });
    } catch (err) {
      showNotification('Failed to start call: ' + err.message);
      cleanupCall();
    }
  }

  async function acceptIncomingCall() {
    if (!incomingCallData || !socket || !socket.connected) return;
    currentCallTarget = incomingCallData.callerCode;
    currentCallType = incomingCallData.callType === 'video' ? 'video' : 'audio';
    try {
      await prepareLocalStream(currentCallType);
    } catch (_) {
      socket.emit('reject-call', {
        callerCode: incomingCallData.callerCode,
        responderCode: currentUser.code
      });
      incomingCallData = null;
      cleanupCall();
      return;
    }
    peerConnection = createPeerConnection(currentCallTarget);
    if (localStream) {
      localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
    }
    try {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(incomingCallData.offer));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      stopRingtone();
      socket.emit('answer-call', {
        callerCode: currentCallTarget,
        responderCode: currentUser.code,
        answer: peerConnection.localDescription
      });
      // Open chat with the caller when call is answered
      if (currentCallTarget && !contacts.find(c => c.code === currentCallTarget)) {
        // If not a contact, add them temporarily or fetch their info
        try {
          const userRes = await fetch(api(`/users/${currentCallTarget}`));
          if (userRes.ok) {
            const user = await userRes.json();
            if (!contacts.find(c => c.code === user.code)) {
              contacts.push(user);
            }
          }
        } catch (e) {
          console.log('Could not fetch caller info:', e);
        }
      }
      openChatInterface(currentCallTarget);
      showCallModal({
        status: 'Connecting...',
        showIncoming: false,
        showActive: true
      });
      incomingCallData = null;
    } catch (err) {
      showNotification('Failed to answer call: ' + err.message);
      socket.emit('reject-call', {
        callerCode: currentCallTarget,
        responderCode: currentUser.code
      });
      cleanupCall();
    }
  }

  function declineIncomingCall() {
    if (incomingCallData && socket && socket.connected) {
      socket.emit('reject-call', {
        callerCode: incomingCallData.callerCode,
        responderCode: currentUser.code
      });
    }
    stopRingtone();
    incomingCallData = null;
    cleanupCall();
    showNotification('Call declined.');
  }

  function toggleMicrophone() {
    if (!localStream) return;
    micEnabled = !micEnabled;
    localStream.getAudioTracks().forEach(track => {
      track.enabled = micEnabled;
    });
    updateMediaButtons();
    updateMuteIndicator('local', !micEnabled);
  }

  function toggleCamera() {
    if (!localStream || currentCallType !== 'video') return;
    cameraEnabled = !cameraEnabled;
    localStream.getVideoTracks().forEach(track => {
      track.enabled = cameraEnabled;
    });
    updateMediaButtons();
    updateCameraOverlay('local', !cameraEnabled);
  }

  function handleIncomingCall(data) {
    if (!socket || !socket.connected) return;
    if (peerConnection || localStream || incomingCallData) {
      socket.emit('call-busy', {
        callerCode: data.callerCode,
        responderCode: currentUser.code
      });
      return;
    }
    incomingCallData = {
      callerCode: data.callerCode,
      callType: data.callType === 'video' ? 'video' : 'audio',
      offer: data.offer
    };
    currentCallType = incomingCallData.callType;
    const caller = findUserByCode(data.callerCode);
    showCallModal({
      status: `${caller.username || 'Unknown User'} is calling (${currentCallType})`,
      showIncoming: true,
      showActive: false
    });
    updateCallLayout();
    startRingtone();
  }

  // Chrome notification function
  function showChromeNotification(title, message, icon = null) {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      const notification = new Notification(title, {
        body: message,
        icon: icon || 'assets/4DChat.png',
        badge: 'assets/4DChat.png',
        tag: '4digits-chat',
        requireInteraction: false,
        silent: false
      });
      
      // Auto-close after 5 seconds
      setTimeout(() => {
        notification.close();
      }, 5000);
      
      // Focus window when notification is clicked
      notification.onclick = () => {
        window.focus();
        notification.close();
      };
    }
  }

  // Check if page is visible (to avoid notifications when user is actively using the app)
  function isPageVisible() {
    return !document.hidden;
  }

  // Update chat order when messages are sent/received
  function updateChatOrder(chatId, isGroup = false) {
    // Remove existing entry if it exists
    chatOrder = chatOrder.filter(item => item.id !== chatId);
    // Add to top
    chatOrder.unshift({ id: chatId, isGroup, timestamp: Date.now() });
    // Keep only last 50 entries to prevent localStorage from getting too large
    chatOrder = chatOrder.slice(0, 50);
    // Save to localStorage
    localStorage.setItem('chatOrder', JSON.stringify(chatOrder));
  }

  // Add message to current chat in real-time
  function addMessageToChat(message, isGroup = false) {
    if (!currentChat) return;
    
    const messagesContainer = document.getElementById('messages-container');
    if (!messagesContainer) return;
    
    // Create message element
    const messageElement = createMessageElement(message, isGroup);
    messagesContainer.appendChild(messageElement);
    
    // Scroll to bottom
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  // Update existing message in chat
  function updateMessageInChat(message) {
    const messageElement = document.querySelector(`[data-message-id="${message._id}"]`);
    if (messageElement) {
      const contentElement = messageElement.querySelector('.bubble-content');
      if (contentElement) {
        contentElement.textContent = message.content;
      }
    }
  }

  // Create a single message element for real-time updates
  function createMessageElement(msg, isGroup = false) {
    const isSelf = msg.senderCode === currentUser.code;
    
    // Create message row
    const row = document.createElement('div');
    row.style = 'display:flex;align-items:flex-end;gap:6px;';
    if (isSelf) {
      row.style.justifyContent = 'flex-end';
    }

    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble ' + (isSelf ? 'self' : 'other');
    bubble.setAttribute('data-message-id', msg._id);

    // Handle deleted messages
    let displayContent = msg.content;
    let showMenu = true;
    
    if (msg.deleted) {
      if (isSelf) {
        displayContent = 'You deleted this message';
      } else {
        const sender = findUserByCode(msg.senderCode);
        const senderName = sender.username;
        displayContent = `${senderName} deleted their message`;
      }
      showMenu = false;
    }

    // Handle different message types
    let contentHtml = '';
    if (msg.type === 'image') {
      contentHtml = `
        <div class="media-message">
          <img src="${msg.content}" alt="Image" onclick="openMediaViewer('${msg.content}', 'image')">
          ${msg.caption ? `<div class="media-caption">${msg.caption}</div>` : ''}
        </div>
      `;
    } else if (msg.type === 'video') {
      contentHtml = `
        <div class="media-message">
          <video controls onclick="openMediaViewer('${msg.content}', 'video')">
            <source src="${msg.content}" type="video/mp4">
            Your browser does not support the video tag.
          </video>
          ${msg.caption ? `<div class="media-caption">${msg.caption}</div>` : ''}
        </div>
      `;
    } else if (msg.type === 'audio') {
      contentHtml = `
        <div class="media-message">
          <audio controls>
            <source src="${msg.content}" type="audio/mpeg">
            Your browser does not support the audio tag.
          </audio>
          ${msg.caption ? `<div class="media-caption">${msg.caption}</div>` : ''}
        </div>
      `;
    } else if (['document', 'archive', 'other'].includes(msg.type)) {
      contentHtml = `
        <div class="media-message">
          <div class="file-message" onclick="downloadFile('${msg.content}', '${msg.fileName}')">
            <i class="fa-solid ${getFileIcon(msg.type)} file-icon-${msg.type}"></i>
            <div class="file-info">
              <div class="file-name">${msg.fileName || 'File'}</div>
              <div class="file-type">${msg.type.toUpperCase()} file</div>
            </div>
            <i class="fa-solid fa-download"></i>
          </div>
          ${msg.caption ? `<div class="media-caption">${msg.caption}</div>` : ''}
        </div>
      `;
    } else {
      contentHtml = `<div class="bubble-content">${displayContent}</div>`;
    }

    // Add reply preview if this message is a reply
    if (msg.replyTo) {
      const repliedMessage = chatMessages.find(m => m._id === msg.replyTo);
      if (repliedMessage) {
        const replySenderName = repliedMessage.senderCode === currentUser.code ? 'You' : 
          findUserByCode(repliedMessage.senderCode).username;
        
        let replyPreview = '';
        if (repliedMessage.type === 'text') {
          replyPreview = repliedMessage.content;
        } else if (repliedMessage.type === 'image') {
          replyPreview = '📷 Image';
        } else if (repliedMessage.type === 'video') {
          replyPreview = '🎥 Video';
        } else if (repliedMessage.type === 'audio') {
          replyPreview = '🎵 Audio';
        } else if (['document', 'archive', 'other'].includes(repliedMessage.type)) {
          replyPreview = `📄 ${repliedMessage.fileName || 'File'}`;
        }
        
        contentHtml = `
          <div class="reply-preview">
            <div class="reply-sender">${replySenderName}</div>
            <div class="reply-content">${replyPreview}</div>
          </div>
          ${contentHtml}
        `;
      }
    }

    bubble.innerHTML = contentHtml;

    // Add timestamp
    const timeDiv = document.createElement('div');
    timeDiv.className = 'message-time';
    timeDiv.textContent = formatTime(msg.timestamp);
    bubble.appendChild(timeDiv);

    // Add context menu for non-deleted messages
    if (showMenu) {
      bubble.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showMessageContextMenu(e, msg);
      });
    }

    // In group chats, show avatar and username
    if (isGroup && !isSelf) {
      const sender = findUserByCode(msg.senderCode);
      const senderUsername = sender.username;
      const fallbackSeed = sender.username !== 'Unknown User' ? sender.username : msg.senderCode;
      const avatarSrc = getProfilePictureUrl(sender.profilePicture, sender.username, fallbackSeed);

      // Create username label with clickable profile picture
      const usernameLabel = document.createElement('div');
      usernameLabel.style = 'font-size:0.78rem;color:#6b7280;margin:0 6px 4px 6px;display:flex;align-items:center;gap:6px;';
      
      // Add clickable profile picture
      const profilePic = document.createElement('img');
      profilePic.src = avatarSrc;
      profilePic.alt = senderUsername;
      profilePic.style = 'width:16px;height:16px;border-radius:50%;cursor:pointer;';
      profilePic.onclick = () => showUserInfo(sender);
      
      usernameLabel.appendChild(profilePic);
      usernameLabel.appendChild(document.createTextNode(senderUsername));

      // Content column (username above, bubble below)
      const contentCol = document.createElement('div');
      contentCol.style = 'display:flex;flex-direction:column;align-items:flex-start;max-width:80%';
      contentCol.appendChild(usernameLabel);
      contentCol.appendChild(bubble);
      
      row.appendChild(contentCol);
    } else {
      row.appendChild(bubble);
    }

    return row;
  }

  // Sort chats by order
  function sortChatsByOrder(chats) {
    return chats.sort((a, b) => {
      const aOrder = chatOrder.find(item => item.id === a.code);
      const bOrder = chatOrder.find(item => item.id === b.code);
      
      if (aOrder && bOrder) {
        return aOrder.timestamp - bOrder.timestamp;
      } else if (aOrder) {
        return -1; // a comes first
      } else if (bOrder) {
        return 1; // b comes first
      } else {
        return 0; // maintain original order
      }
    });
  }

  // User info modal functionality
  let selectedUserForInfo = null;

  function showUserInfo(user) {
    selectedUserForInfo = user;
    userInfoPic.src = getProfilePictureUrl(user.profilePicture, user.username, user.code);
    userInfoName.textContent = user.username || 'Unknown User';
    userInfoCode.textContent = `Code: ${user.code}`;
    
    // Check if already a contact
    const isContact = contacts.some(c => c.code === user.code);
    if (isContact) {
      sendFriendRequestBtn.textContent = 'Already a Contact';
      sendFriendRequestBtn.disabled = true;
      sendFriendRequestBtn.style.background = '#6b7280';
    } else {
      sendFriendRequestBtn.textContent = 'Send Friend Request';
      sendFriendRequestBtn.disabled = false;
      sendFriendRequestBtn.style.background = '#10b981';
    }
    
    userInfoModal.classList.remove('hidden');
  }

  // Close user info modal
  if (closeUserInfo) {
    closeUserInfo.addEventListener('click', () => {
      userInfoModal.classList.add('hidden');
      selectedUserForInfo = null;
    });
  }

  if (closeUserInfoBtn) {
    closeUserInfoBtn.addEventListener('click', () => {
      userInfoModal.classList.add('hidden');
      selectedUserForInfo = null;
    });
  }

  // Send friend request from user info modal
  if (sendFriendRequestBtn) {
    sendFriendRequestBtn.addEventListener('click', async () => {
      if (!selectedUserForInfo) return;
      
      try {
        const res = await fetch(api(`/users/${currentUser.code}/send-request`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contactCode: selectedUserForInfo.code })
        });
        
        if (res.ok) {
          showNotification('Friend request sent!');
          userInfoModal.classList.add('hidden');
          selectedUserForInfo = null;
        } else {
          const error = await res.json();
          showNotification('Failed to send request: ' + error.error);
        }
      } catch (err) {
        showNotification('Failed to send request: ' + err.message);
      }
    });
  }

  if (audioCallBtn) {
    audioCallBtn.addEventListener('click', () => initiateCall('audio'));
  }
  if (videoCallBtn) {
    videoCallBtn.addEventListener('click', () => initiateCall('video'));
  }
  if (acceptCallBtn) {
    acceptCallBtn.addEventListener('click', acceptIncomingCall);
  }
  if (declineCallBtn) {
    declineCallBtn.addEventListener('click', declineIncomingCall);
  }
  if (endCallBtn) {
    endCallBtn.addEventListener('click', () => endCall('ended'));
  }
  if (toggleMicBtn) {
    toggleMicBtn.addEventListener('click', toggleMicrophone);
  }
  if (toggleCameraBtn) {
    toggleCameraBtn.addEventListener('click', toggleCamera);
  }

  if (toggleMicBtn) toggleMicBtn.disabled = true;
  if (toggleCameraBtn) toggleCameraBtn.disabled = true;
  if (endCallBtn) endCallBtn.disabled = true;

  if (settingsBtn && settingsContent && settingsModal) {
  settingsBtn.addEventListener('click', () => {
    // Reset animation
    settingsContent.style.animation = 'none';
    void settingsContent.offsetWidth; // trigger reflow
    settingsContent.style.animation = '';
    settingsModal.classList.remove('hidden');
  });
  }

  if (closeSettings && settingsModal) {
  closeSettings.addEventListener('click', () => {
    settingsModal.classList.add('hidden');
  });
  }

  // Show create group modal - will be set up after functions are defined
  // createGroupBtn.addEventListener('click', () => {
  //   openGroupCreationModal();
  // });

  // Hide create group modal
  if (closeCreateGroup && createGroupModal) {
  closeCreateGroup.addEventListener('click', () => {
    createGroupModal.classList.add('hidden');
  });
  }

  // --- Global Blend Overlay Toggle on ESC or Right Click ---
  function toggleBlendOverlay() {
    if (!blendOverlay) return;
    const isHidden = blendOverlay.classList.contains('hidden');
    if (isHidden) {
      blendOverlay.classList.remove('hidden');
    } else {
      blendOverlay.classList.add('hidden');
    }
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && e.shiftKey) {
      e.preventDefault();
      toggleBlendOverlay();
    }
  });

  // Username edit/save/cancel logic
  const usernameInput = document.getElementById('username');
  const editBtn = document.getElementById('edit-username-btn');
  
  if (usernameInput && editBtn) {
  const usernameRow = usernameInput.parentNode;
  let originalUsername = usernameInput.value;

  function createButton(id, text, extraClass = '') {
    const btn = document.createElement('button');
    btn.id = id;
    btn.className = 'settings-btn' + (extraClass ? ' ' + extraClass : '');
    btn.textContent = text;
    return btn;
  }

  editBtn.addEventListener('click', () => {
    usernameInput.readOnly = false;
    usernameInput.focus();
    editBtn.style.display = 'none';

    // Create Save and Cancel buttons
    const saveBtn = createButton('save-username-btn', 'Save');
    const cancelBtn = createButton('cancel-username-btn', 'Cancel');
    usernameRow.appendChild(saveBtn);
    usernameRow.appendChild(cancelBtn);

    saveBtn.addEventListener('click', () => {
      originalUsername = usernameInput.value;
      usernameInput.readOnly = true;
      saveBtn.remove();
      cancelBtn.remove();
      editBtn.style.display = '';
      showNotification('Username updated!');
    });

    cancelBtn.addEventListener('click', () => {
      usernameInput.value = originalUsername;
      usernameInput.readOnly = true;
      saveBtn.remove();
      cancelBtn.remove();
      editBtn.style.display = '';
    });
  });
  } // Close the if statement for username logic

  // Profile picture edit logic
  const editPicBtn = document.getElementById('edit-pic-btn');
  const profilePicInput = document.getElementById('profile-pic-input');
  const profilePicPreview = document.getElementById('profile-pic-preview');
  const picEditControls = document.getElementById('pic-edit-controls');
  const importPicBtn = document.getElementById('import-pic-btn');
  const savePicBtn = document.getElementById('save-pic-btn');
  const removePicBtn = document.getElementById('remove-pic-btn');
  const cancelPicBtn = document.getElementById('cancel-pic-btn');
  const defaultProfilePic = "https://api.dicebear.com/7.x/thumbs/svg?seed=user843";
  let originalProfilePic = null;
  let tempProfilePic = null;

  if (editPicBtn && profilePicInput && profilePicPreview && picEditControls && importPicBtn && savePicBtn && removePicBtn && cancelPicBtn) {
    // Enter edit mode
    editPicBtn.addEventListener('click', () => {
      originalProfilePic = profilePicPreview.src;
      editPicBtn.style.display = 'none';
      picEditControls.style.display = 'flex';
    });

    // Import image
    importPicBtn.addEventListener('click', () => {
      profilePicInput.click();
    });

    // Handle file selection
    profilePicInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file && file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = function(evt) {
          tempProfilePic = evt.target.result;
          profilePicPreview.src = tempProfilePic;
        };
        reader.readAsDataURL(file);
      }
    });

    // Save the new profile picture
    savePicBtn.addEventListener('click', async () => {
      if (tempProfilePic) {
        try {
          // Convert base64 to file for upload
          const response = await fetch(tempProfilePic);
          const blob = await response.blob();
          
          // Create FormData for file upload
          const formData = new FormData();
          formData.append('profilePicture', blob, 'profile-picture.jpg');
          
          // Upload to backend
          const uploadRes = await fetch(api(`/users/${currentUser.code}/upload-profile-picture`), {
            method: 'POST',
            body: formData
          });
          
          if (!uploadRes.ok) {
            const error = await uploadRes.json();
            throw new Error(error.error || 'Failed to upload profile picture');
          }
          
          const result = await uploadRes.json();
          
          // Update localStorage with new user data
          localStorage.setItem('userProfile', JSON.stringify(result.user));
          
          // Update current user
          currentUser = result.user;
          
          // Update last used timestamp
          await fetch(api(`/users/${currentUser.code}/update-last-used`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          });
          
          originalProfilePic = result.profilePicture;
          tempProfilePic = null;
          showNotification('Profile picture saved successfully!');
        } catch (err) {
          showNotification('Failed to save profile picture: ' + err.message);
          return;
        }
      }
      // Exit edit mode
      editPicBtn.style.display = '';
      picEditControls.style.display = 'none';
    });

    // Cancel and restore original
    cancelPicBtn.addEventListener('click', () => {
      profilePicPreview.src = originalProfilePic;
      tempProfilePic = null;
      profilePicInput.value = '';
      // Exit edit mode
      editPicBtn.style.display = '';
      picEditControls.style.display = 'none';
    });

    // Remove profile picture (reset to default)
    removePicBtn.addEventListener('click', async () => {
      try {
        const deleteRes = await fetch(api(`/users/${currentUser.code}/profile-picture`), {
          method: 'DELETE'
        });
        
        if (!deleteRes.ok) {
          const error = await deleteRes.json();
          throw new Error(error.error || 'Failed to remove profile picture');
        }
        
        const result = await deleteRes.json();
        
        // Update localStorage with new user data
        localStorage.setItem('userProfile', JSON.stringify(result.user));
        
        // Update current user
        currentUser = result.user;
        
        // Update last used timestamp
        await fetch(api(`/users/${currentUser.code}/update-last-used`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        
        // Update preview to default
        profilePicPreview.src = defaultProfilePic;
        originalProfilePic = defaultProfilePic;
        tempProfilePic = null;
        profilePicInput.value = '';
        
        showNotification('Profile picture removed!');
        
        // Exit edit mode
        editPicBtn.style.display = '';
        picEditControls.style.display = 'none';
      } catch (err) {
        showNotification('Failed to remove profile picture: ' + err.message);
      }
    });
  }

  if (groupLogoCircle && groupLogoInput) {
    groupLogoCircle.addEventListener('click', () => {
      groupLogoInput.click();
    });
    groupLogoInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file && file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = function(evt) {
          groupLogoCircle.style.backgroundImage = `url('${evt.target.result}')`;
          groupLogoCircle.style.backgroundSize = 'cover';
          groupLogoCircle.style.backgroundPosition = 'center';
          const icon = groupLogoCircle.querySelector('i');
          if (icon) icon.style.display = 'none';
        };
        reader.readAsDataURL(file);
      }
    });
  }

  // --- Device-locked user profile logic ---
  async function getOrCreateUserProfile() {
    let userProfile = null;
    try {
      // First, try to get existing profile from localStorage
      userProfile = localStorage.getItem('userProfile');
      if (userProfile) {
        userProfile = JSON.parse(userProfile);
        if (userProfile && userProfile.code && userProfile.code.length === 4) {
          // Update last used timestamp for this profile
          try {
            await fetch(api(`/users/${userProfile.code}/update-last-used`), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' }
            });
          } catch (err) {
            console.log('Could not update last used timestamp:', err);
          }
          return userProfile;
        } else {
          // Corrupted or missing code, clear and try to restore from database
          localStorage.removeItem('userProfile');
        }
      }
      
      // Removed automatic fallback to special admin profile (code "0000").
      // New visitors should NOT be assigned code "0000" implicitly.
      // If an admin workflow is required, it should be triggered explicitly elsewhere.
      
      // If no device profile, don't fall back to most recent user
      // This prevents multiple users from getting the same profile
      // Each device should create its own user profile
      
      // Try restoring by deviceId to survive IP/base URL changes
      const deviceId2 = localStorage.getItem('deviceId') || generateDeviceId();
      localStorage.setItem('deviceId', deviceId2);
      try {
        const byDeviceRes = await fetch(api(`/users/by-device/${encodeURIComponent(deviceId2)}`));
        if (byDeviceRes.ok) {
          const byDeviceUser = await byDeviceRes.json();
          localStorage.setItem('userProfile', JSON.stringify(byDeviceUser));
          // Update last used timestamp
          await fetch(api(`/users/${byDeviceUser.code}/update-last-used`), { method: 'POST', headers: { 'Content-Type': 'application/json' } });
          return byDeviceUser;
        }
      } catch (err) {
        console.log('Could not restore by deviceId:', err);
      }

      // If still nothing, create a new one
      const randomNum = Math.floor(100 + Math.random() * 900);
      const username = 'user' + randomNum;
      let res, user;
      try {
        res = await fetch(api('/users'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, profilePicture: '', deviceId: deviceId2 })
        });
        if (!res.ok) {
          let errMsg = 'Could not create user. Backend unreachable?';
          try { const data = await res.json(); errMsg = data.error || errMsg; } catch {}
          throw new Error(errMsg);
        }
        user = await res.json();
      } catch (err) {
        throw new Error('Network or backend error: ' + (err.message || err));
      }
      if (!user.code || user.code.length !== 4) throw new Error('User code not assigned. Raw user: ' + JSON.stringify(user));
      localStorage.setItem('userProfile', JSON.stringify(user));
      return user;
    } catch (err) {
      let debugMsg = 'User creation failed: ' + (err.message || err);
      // Show current localStorage.userProfile for debugging
      debugMsg += '\nlocalStorage.userProfile: ' + localStorage.getItem('userProfile');
      showNotification(debugMsg);
      // Show a retry and a clear button if not already present
      if (!document.getElementById('retry-user-btn')) {
        const btn = document.createElement('button');
        btn.id = 'retry-user-btn';
        btn.textContent = 'Retry User Creation';
        btn.className = 'settings-btn';
        btn.style = 'margin: 16px auto; display: block;';
        btn.onclick = () => { btn.remove(); window.location.reload(); };
        document.body.appendChild(btn);
      }
      if (!document.getElementById('clear-user-btn')) {
        const btn2 = document.createElement('button');
        btn2.id = 'clear-user-btn';
        btn2.textContent = 'Clear Profile and Retry';
        btn2.className = 'settings-btn';
        btn2.style = 'margin: 8px auto 32px auto; display: block; background:#ff5252;';
        btn2.onclick = () => { localStorage.removeItem('userProfile'); btn2.remove(); window.location.reload(); };
        document.body.appendChild(btn2);
      }
      throw err;
    }
  }

  // Generate unique device ID
  function generateDeviceId() {
    return 'device_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  let currentUser = null;
  let recoveryAttempts = parseInt(localStorage.getItem('userRecoveryAttempts') || '0', 10);

  // --- Socket.IO Real-time Updates ---
  let socket = null;
  function setupSocketIO(userCode) {
    if (!window.io) return;
    socket = io(socketBase());
    socket.on('connect', () => {
      console.log('🔌 Connected to server with user code:', userCode);
      socket.emit('register', userCode);
    });
    
    socket.on('disconnect', () => {
      console.log('🔌 Disconnected from server');
    });
    
    socket.on('connect_error', (error) => {
      console.error('🔌 Connection error:', error);
    });
    socket.on('requests-updated', () => {
      console.log('📨 Friend requests updated - refreshing contacts');
      fetchContactsAndGroups();
    });
    socket.on('pending-updated', () => {
      console.log('📤 Pending requests updated - refreshing contacts');
      fetchContactsAndGroups();
    });
    socket.on('contacts-updated', () => {
      console.log('👥 Contacts updated - refreshing contacts');
      fetchContactsAndGroups();
    });
    
    // Handle admin real-time updates
    socket.on('user-deleted', (data) => {
      console.log('🗑️ User deleted:', data.deletedUserCode);
      showNotification(`User ${data.deletedUserCode} has been removed`);
      fetchContactsAndGroups();
    });
    
    socket.on('group-deleted', (data) => {
      console.log('🗑️ Group deleted:', data.groupCode);
      showNotification(`Group "${data.groupName}" has been removed`);
      fetchContactsAndGroups();
      // Close group settings if it was the deleted group
      if (currentGroupCode === data.groupCode) {
        closeGroupSettings();
      }
    });
    
    socket.on('group-updated', (data) => {
      console.log('👥 Group updated:', data);
      if (data.action === 'member-kicked') {
        showNotification(`Member ${data.targetCode} has been kicked from the group`);
      }
      fetchContactsAndGroups();
      // Refresh group settings if it's the current group
      if (currentGroupCode === data.groupCode) {
        loadGroupSettings();
      }
    });
    
    socket.on('group-kicked', (data) => {
      console.log('👥 You were kicked from group:', data.groupCode);
      showNotification(`You have been kicked from "${data.groupName}"`);
      fetchContactsAndGroups();
      // Close group settings if it was the group you were kicked from
      if (currentGroupCode === data.groupCode) {
        closeGroupSettings();
      }
    });
    
    // Handle new messages with notifications
    socket.on('new-message', (message) => {
      console.log('💬 New message received:', message);
      
      // Check if this is a duplicate message
      const existingMessage = chatMessages.find(m => m._id === message._id);
      
      if (!existingMessage) {
        // Add message to current chat if it's the active chat
        if (currentChatCode && (
          (message.senderCode === currentUser.code && message.receiverCode === currentChatCode) ||
          (message.senderCode === currentChatCode && message.receiverCode === currentUser.code)
        )) {
          addChatMessage(message);
        }
        
        if (message.senderCode !== currentUser.code) {
          // Show Chrome notification if page is not visible
          const shouldNotify = !isPageVisible() || message.senderCode !== currentChatCode;
          if (shouldNotify) {
            const sender = findUserByCode(message.senderCode);
            const senderName = sender.username;
            showChromeNotification(
              `New message from ${senderName}`,
              message.content.length > 50 ? message.content.substring(0, 50) + '...' : message.content,
              sender.profilePicture || null
            );
            // Play notification sound only for incoming messages
            playNotificationSound();
          }
          
          // Browser notification if tab not focused
          if (typeof document !== 'undefined' && document.hidden && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            try {
              const sender = findUserByCode(message.senderCode);
              const title = sender.username + ` (${message.senderCode})`;
              const body = message.type === 'text' ? message.content : (message.type === 'image' ? '📷 Image' : message.type === 'video' ? '🎥 Video' : '📎 File');
              const icon = getProfilePictureUrl(sender.profilePicture, sender.username, message.senderCode);
              const n = new Notification(title, { body, icon });
              setTimeout(() => n.close(), 5000);
              // Play notification sound for browser notifications too
              playNotificationSound();
            } catch (_) {}
          }
          
          // If we're not in the chat with this sender, increment unread count
          if (message.senderCode !== currentChatCode && !message.self) {
            incrementUnreadCount(message.senderCode);
          }
          
          // Update chat order
          updateChatOrder(message.senderCode, false);
          
          // Refresh contacts to update ordering
          fetchContactsAndGroups();
        }
      }
    });
    
    // Handle new group messages with notifications
    socket.on('new-group-message', (message) => {
      console.log('💬 New group message received:', message);
      
      // Check if this is a duplicate message
      const existingMessage = chatMessages.find(m => m._id === message._id);
      
      if (!existingMessage) {
        // Add message to current chat if it's the active group
        if (currentGroupCode && message.groupCode === currentGroupCode) {
          addChatMessage(message);
        }
        
        if (message.senderCode !== currentUser.code) {
          // Show Chrome notification if page is not visible
          const shouldNotifyGroup = !isPageVisible() || message.groupCode !== currentGroupCode;
          if (shouldNotifyGroup) {
            const sender = findUserByCode(message.senderCode);
            const senderName = sender.username;
            showChromeNotification(
              `New message in group`,
              `${senderName}: ${message.content.length > 50 ? message.content.substring(0, 50) + '...' : message.content}`,
              sender.profilePicture || null
            );
          }
          
          // Update chat order
          updateChatOrder(message.groupCode, true);
          
          // Refresh contacts to update ordering
          fetchContactsAndGroups();
        }
      }
    });
    
    // Handle user status changes
    socket.on('user-status-changed', (data) => {
      console.log('👤 User status changed:', data);
      // Update online status in contacts
      const contact = contacts.find(c => c.code === data.userCode);
      if (contact) {
        contact.isOnline = data.isOnline;
        contact.lastSeen = data.lastSeen;
        // Re-render contacts to update online indicators
        fetchContactsAndGroups();
      }
    });
    
    // Handle message updates
    socket.on('message-updated', (message) => {
      console.log('✏️ Message updated:', message);
      // Update the message in the chat if it's currently displayed
      if (currentChat && (currentChat.code === message.senderCode || currentChat.code === message.receiverCode)) {
        updateMessageInChat(message);
      }
    });

    socket.on('incoming-call', (data) => {
      handleIncomingCall(data);
    });

    socket.on('call-accepted', async (data) => {
      if (!peerConnection) return;
      if (currentCallTarget && data.responderCode && data.responderCode !== currentCallTarget) return;
      try {
        stopRingtone();
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
        updateCallStatus('Call connected');
      } catch (err) {
        console.error('Failed to handle call acceptance:', err);
        cleanupCall();
        showNotification('Call failed to connect.');
      }
    });

    socket.on('call-rejected', (data) => {
      if (currentCallTarget && data.responderCode && data.responderCode !== currentCallTarget) return;
      const wasInCall = cleanupCall();
      if (wasInCall || currentCallTarget) {
        showNotification('Call declined.');
      }
    });

    socket.on('call-busy', (data) => {
      if (currentCallTarget && data.responderCode && data.responderCode !== currentCallTarget) return;
      const wasInCall = cleanupCall();
      if (wasInCall || currentCallTarget) {
        showNotification('User is busy on another call.');
      }
    });

    socket.on('call-unavailable', (data) => {
      if (currentCallTarget && data.targetCode && data.targetCode !== currentCallTarget) return;
      const wasInCall = cleanupCall();
      if (wasInCall || currentCallTarget) {
        showNotification('User is unavailable for calls.');
      }
    });

    socket.on('call-ended', (data) => {
      const wasInCall = cleanupCall();
      if (wasInCall) {
        if (data && data.reason === 'rejected') {
          showNotification('Call declined.');
        } else if (data && data.reason === 'busy') {
          showNotification('User is busy on another call.');
        } else if (data && data.reason === 'unavailable') {
          showNotification('User is unavailable for calls.');
        } else {
          showNotification('Call ended.');
        }
      }
    });

    socket.on('ice-candidate', async (data) => {
      if (!peerConnection || !data || !data.candidate) return;
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (err) {
        console.error('Failed to add ICE candidate:', err);
      }
    });
  }

  // Call setupSocketIO after user is initialized
  async function initUser() {
    try {
      currentUser = await getOrCreateUserProfile();
      if (!currentUser || !currentUser.code || currentUser.code.length !== 4) {
        localStorage.removeItem('userProfile');
        recoveryAttempts++;
        localStorage.setItem('userRecoveryAttempts', recoveryAttempts);
        if (recoveryAttempts < 3) {
          showNotification('User code missing. Retrying... (' + recoveryAttempts + '/3)');
          setTimeout(() => window.location.reload(), 1200);
        } else {
          showNotification('Failed to create user after 3 attempts. Please check your connection and click Retry.');
          if (!document.getElementById('final-retry-btn')) {
            const btn = document.createElement('button');
            btn.id = 'final-retry-btn';
            btn.textContent = 'Final Retry';
            btn.className = 'settings-btn';
            btn.style = 'margin: 32px auto; display: block; background:#ff5252;';
            btn.onclick = () => {
              localStorage.removeItem('userProfile');
              localStorage.setItem('userRecoveryAttempts', '0');
              btn.remove();
              window.location.reload();
            };
            document.body.appendChild(btn);
          }
        }
        return;
      }
      localStorage.setItem('userRecoveryAttempts', '0'); // Reset on success
      fetchContactsAndGroups();
      // --- Register for real-time updates ---
      setupSocketIO(currentUser.code);
      // Show admin panel for codes 0000 or 9999
      if (adminPanel && currentUser && (currentUser.code === '0000' || currentUser.code === '9999')) {
        adminPanel.classList.remove('hidden');
      }
      // Request notification permission once
      requestNotificationPermission();
    } catch (err) {
      // Already handled in getOrCreateUserProfile
    }
  }
  // --- Admin panel actions ---
  if (adminBanBtn) {
    adminBanBtn.addEventListener('click', async () => {
      const userCode = (adminBanCodeInput.value || '').trim();
      const groupCode = (adminBanGroupInput.value || '').trim();
      if (userCode.length !== 4 || groupCode.length !== 4) {
        showNotification('Enter valid 4-digit user and group codes');
        return;
      }
      try {
        const res = await fetch(api(`/admin/groups/${groupCode}/ban`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requesterCode: currentUser.code, targetCode: userCode })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to ban user');
        showNotification('User banned from group');
      } catch (e) {
        showNotification('Ban failed: ' + e.message);
      }
    });
  }

  if (adminRemoveUserBtn) {
    adminRemoveUserBtn.addEventListener('click', async () => {
      const code = (adminRemoveUserInput.value || '').trim();
      if (code.length !== 4) { showNotification('Enter a valid 4-digit user code'); return; }
      try {
        const res = await fetch(api(`/admin/users/${code}?requesterCode=${encodeURIComponent(currentUser.code)}`), { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to remove user');
        showNotification('User removed');
      } catch (e) {
        showNotification('Remove failed: ' + e.message);
      }
    });
  }

  if (adminRemoveGroupBtn) {
    adminRemoveGroupBtn.addEventListener('click', async () => {
      const groupCode = (adminRemoveGroupInput.value || '').trim();
      if (groupCode.length !== 4) { showNotification('Enter a valid 4-digit group code'); return; }
      try {
        const res = await fetch(api(`/admin/groups/${groupCode}?requesterCode=${encodeURIComponent(currentUser.code)}`), { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to remove group');
        showNotification('Group removed');
      } catch (e) {
        showNotification('Remove group failed: ' + e.message);
      }
    });
  }

  if (adminJoinGroupBtn) {
    adminJoinGroupBtn.addEventListener('click', async () => {
      const groupCode = (adminJoinGroupInput.value || '').trim();
      if (groupCode.length !== 4) { showNotification('Enter a valid 4-digit group code'); return; }
      try {
        const res = await fetch(api(`/users/${currentUser.code}/join-group`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ groupCode })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to join group');
        showNotification('Joined group');
        fetchContactsAndGroups();
      } catch (e) {
        showNotification('Join group failed: ' + e.message);
      }
    });
  }

  if (adminShowUsersBtn && adminUsersList) {
    adminShowUsersBtn.addEventListener('click', async () => {
      try {
        const res = await fetch(api(`/admin/users?requesterCode=${encodeURIComponent(currentUser.code)}`));
        const users = await res.json();
        if (!res.ok) throw new Error(users.error || 'Failed to fetch users');
        adminUsersList.style.display = 'block';
        adminUsersList.innerHTML = users.map(u => `<div style="padding:6px 8px;border-bottom:1px solid #174ea6;display:flex;align-items:center;gap:8px;">
          <img src="${getProfilePictureUrl(u.profilePicture, u.username, u.code)}" alt="pfp" style="width:22px;height:22px;border-radius:50%;object-fit:cover;" onerror="this.onerror=null;this.src='https://api.dicebear.com/7.x/thumbs/svg?seed=${encodeURIComponent(u.username||u.code)}'" />
          <span style="color:#e3ecfa;font-weight:600;">${u.username||'Unknown'}</span>
          <span style="color:#7baee6;margin-left:auto;">${u.code}</span>
        </div>`).join('');
      } catch (e) {
        showNotification('Fetch users failed: ' + e.message);
      }
    });
  }

  if (adminFixProfilePicturesBtn) {
    adminFixProfilePicturesBtn.addEventListener('click', async () => {
      try {
        showNotification('Fixing profile picture URLs...');
        const res = await fetch(api(`/admin/fix-profile-pictures?requesterCode=${encodeURIComponent(currentUser.code)}`), {
          method: 'POST'
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || 'Failed to fix profile pictures');
        showNotification(`✅ ${result.message}`);
        // Refresh the user list if it's currently displayed
        if (adminUsersList && adminUsersList.style.display === 'block') {
          adminShowUsersBtn.click();
        }
      } catch (e) {
        showNotification('Fix profile pictures failed: ' + e.message);
      }
    });
  }

  // Add socket connection status check
  function checkSocketStatus() {
    if (socket) {
      console.log('Socket status:', socket.connected ? 'Connected' : 'Disconnected');
      console.log('Socket ID:', socket.id);
      return socket.connected;
    } else {
      console.log('Socket not initialized');
      return false;
    }
  }

  // Add socket status to admin panel
  if (adminShowUsersBtn) {
    adminShowUsersBtn.addEventListener('click', () => {
      const isConnected = checkSocketStatus();
      console.log('Socket connected:', isConnected);
    });
  }

  // --- Fetch and display contacts and groups ---
  let contacts = []; // Global contacts array
  let allUsers = []; // Global users array for better user lookup
  let chatOrder = JSON.parse(localStorage.getItem('chatOrder') || '[]'); // Persistent chat ordering
  
  async function fetchContactsAndGroups() {
    if (!currentUser) return;
    const includeAdminLookup = currentUser && (currentUser.code === '0000' || currentUser.code === '9999');
    const fetchList = [
      fetch(api(`/users/${currentUser.code}/contacts`)),
      fetch(api(`/users/${currentUser.code}/groups`)),
      fetch(api(`/users/${currentUser.code}/pending`)),
      fetch(api(`/users/${currentUser.code}/requests`))
    ];

    if (includeAdminLookup) {
      fetchList.push(fetch(api(`/admin/users?requesterCode=${encodeURIComponent(currentUser.code)}`)));
    }

    let fetchedContacts = [];
    let fetchedGroups = [];
    let fetchedPending = [];
    let fetchedRequests = [];

    try {
      const responses = await Promise.all(fetchList);
      const [contactsRes, groupsRes, pendingRes, requestsRes, adminRes] = responses;

      fetchedContacts = contactsRes && contactsRes.ok ? await contactsRes.json() : [];
      fetchedGroups = groupsRes && groupsRes.ok ? await groupsRes.json() : [];
      fetchedPending = pendingRes && pendingRes.ok ? await pendingRes.json() : [];
      fetchedRequests = requestsRes && requestsRes.ok ? await requestsRes.json() : [];

      if (includeAdminLookup && adminRes && adminRes.ok) {
        try {
          allUsers = await adminRes.json();
          allUsers.forEach(user => {
            userCache.set(user.code, user);
          });
        } catch (err) {
          console.log('Could not parse admin users:', err);
        }
      }
    } catch (err) {
      console.error('Failed to load conversations:', err);
      fetchedContacts = [];
      fetchedGroups = [];
      fetchedPending = [];
      fetchedRequests = [];
    }

    contacts = Array.isArray(fetchedContacts) ? fetchedContacts : [];
    contacts.forEach(contact => {
      contact.unreadCount = contact.unreadCount || 0;
      userCache.set(contact.code, contact);
    });

    const groups = Array.isArray(fetchedGroups) ? fetchedGroups : [];
    const pending = Array.isArray(fetchedPending) ? fetchedPending : [];
    const requests = Array.isArray(fetchedRequests) ? fetchedRequests : [];

    console.log('Fetched groups:', groups); // Debug log
    // Store for mobile modal (if needed)
    window._lastFetchedRequests = requests;
    window._lastFetchedPending = pending;
    // Sort groups and contacts by chat order
    const sortedGroups = sortChatsByOrder(groups);
    const sortedContacts = sortChatsByOrder(contacts);
    
    // Render in chat list (merged groups and contacts together)
    let html = '<div class="chat-list-section"><ul>';
      for (const group of sortedGroups) {
      const groupIcon = group.icon || ('https://api.dicebear.com/7.x/thumbs/svg?seed=' + group.name);
      html += `<li class="chat-list-item" data-type="group" data-code="${group.code}" style="display:flex;align-items:center;">
        <div class="contact-pic-container" style="margin-right:12px;">
          <img src="${groupIcon}" alt="Group Icon" class="contact-profile-pic" style="width:38px;height:38px;border-radius:50%;object-fit:cover;box-shadow:0 2px 8px #2563eb22;">
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-start;gap:2px;">
          <div style="display:flex;align-items:center;gap:6px;">
            <span>${group.name}</span>
          </div>
          <span class="contact-code">${group.code}</span>
        </div>
        <div style="flex:1 1 auto;"></div>
        <button class="group-chat-btn" data-code="${group.code}" style="padding:4px 8px;background:#2563eb;border:none;border-radius:4px;color:#fff;font-size:1.1rem;cursor:pointer;display:flex;align-items:center;justify-content:center;min-width:32px;min-height:32px;margin-right:8px;"><i class='fa-solid fa-comment'></i></button>
        <button class="remove-group-btn" data-code="${group.code}" style="padding:4px 8px;background:#ff5252;border:none;border-radius:4px;color:#fff;font-size:1.1rem;cursor:pointer;display:flex;align-items:center;justify-content:center;min-width:32px;min-height:32px;"><i class='fa-solid fa-xmark'></i></button>
      </li>`;
    }
      for (const contact of sortedContacts) {
      const onlineStatusClass = contact.isOnline ? 'online' : '';
      const unreadCount = contact.unreadCount || 0;
      const unreadBadge = unreadCount > 0 ? `<span class="unread-badge">${unreadCount > 99 ? '99+' : unreadCount}</span>` : '';
        html += `<li class="chat-list-item" data-type="contact" data-code="${contact.code}" style="display:flex;align-items:center;">
        <div class="contact-pic-container" style="margin-right:12px;">
          <img src="${getProfilePictureUrl(contact.profilePicture, contact.username)}" alt="Profile" class="contact-profile-pic" style="width:38px;height:38px;border-radius:50%;object-fit:cover;box-shadow:0 2px 8px #2563eb22;">
          ${unreadBadge}
        </div>
          <div style="display:flex;flex-direction:column;align-items:flex-start;gap:2px;">
          <div style="display:flex;align-items:center;gap:6px;">
            <span>${contact.username}</span>
            <span class="contact-online-indicator ${onlineStatusClass}"></span>
          </div>
            <span class="contact-code">${contact.code}</span>
          </div>
          <div style="flex:1 1 auto;"></div>
          <button class="chat-btn" data-code="${contact.code}" style="padding:4px 8px;background:#2563eb;border:none;border-radius:4px;color:#fff;font-size:1.1rem;cursor:pointer;display:flex;align-items:center;justify-content:center;min-width:32px;min-height:32px;margin-right:8px;"><i class='fa-solid fa-comment'></i></button>
          <button class="remove-contact-btn" data-code="${contact.code}" style="padding:4px 8px;background:#ff5252;border:none;border-radius:4px;color:#fff;font-size:1.1rem;cursor:pointer;display:flex;align-items:center;justify-content:center;min-width:32px;min-height:32px;"><i class='fa-solid fa-xmark'></i></button>
        </li>`;
      }
      html += '</ul></div>';
    if (!html) {
      html = '<div style="text-align:center;color:#888;">No contacts or groups yet.</div>';
    }
    chatListContainer.innerHTML = html;

    // Add event listeners to group buttons
    const groupChatButtons = chatListContainer.querySelectorAll('.group-chat-btn');
    groupChatButtons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const code = e.currentTarget.dataset.code;
        openGroupChat(code);
        e.stopPropagation();
      });
    });
    const removeGroupButtons = chatListContainer.querySelectorAll('.remove-group-btn');
    removeGroupButtons.forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const code = e.currentTarget.dataset.code;
        const confirmed = await showConfirmModal('Are you sure you want to leave this group?');
        if (confirmed) {
          removeGroup(code);
        }
        e.stopPropagation();
      });
    });
    
      // Add event listeners to remove buttons
  const removeButtons = chatListContainer.querySelectorAll('.remove-contact-btn');
  removeButtons.forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const contactCode = e.currentTarget.dataset.code;
      const confirmed = await showConfirmModal('Are you sure you want to remove this contact?');
      if (confirmed) {
        await removeContact(contactCode);
      }
    });
  });

  // Add event listeners to chat buttons
  const chatButtons = chatListContainer.querySelectorAll('.chat-btn');
  chatButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      const contactCode = e.currentTarget.dataset.code;
      openChatInterface(contactCode);
    });
  });

    // Toggle scrollable class if more than 2 contacts
    if (contacts.length > 2) {
      chatListContainer.classList.add('scrollable');
    } else {
      chatListContainer.classList.remove('scrollable');
    }

    // Render pending and requests in side-info-box
    const pendingList = document.getElementById('pending-list');
    pendingList.innerHTML = '';
    for (const user of pending) {
      addToPendingList(user);
    }
    const requestsList = document.getElementById('requests-list');
    requestsList.innerHTML = '';
    for (const user of requests) {
      addToRequestsList(user, user.code);
    }
  }

  // --- Settings: Fetch and update user data ---
  async function loadUserSettings() {
    if (!currentUser) return;
    const res = await fetch(api(`/users/${currentUser.code}`));
    const user = await res.json();
    document.getElementById('username').value = user.username;
    document.getElementById('profile-pic-preview').src = getProfilePictureUrl(user.profilePicture, user.username);
    // Set the real code in the existing .settings-code box
    const codeBox = document.querySelector('.settings-code');
    if (codeBox) {
      codeBox.textContent = user.code;
    }
  }

  // Load user data when settings is opened
  settingsBtn.addEventListener('click', () => {
    loadUserSettings();
    // Reset animation
    settingsContent.style.animation = 'none';
    void settingsContent.offsetWidth; // trigger reflow
    settingsContent.style.animation = '';
    settingsModal.classList.remove('hidden');
  });

  // Save username/profile picture to backend
  function saveUserSettings() {
    if (!currentUser) return;
    const username = document.getElementById('username').value;
    const profilePicture = document.getElementById('profile-pic-preview').src;
    fetch(api(`/users/${currentUser.code}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, profilePicture })
    })
    .then(res => res.json())
    .then(data => {
      showNotification('Settings updated!');
      // Update localStorage
      localStorage.setItem('userProfile', JSON.stringify(data));
      // Update last used timestamp
      fetch(api(`/users/${currentUser.code}/update-last-used`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      // Optionally reload chat list with new username
      fetchContactsAndGroups();
    });
  }

  // Add save logic to username save button
  document.addEventListener('click', function(e) {
    if (e.target && e.target.id === 'save-username-btn') {
      saveUserSettings();
    }
  });

  // --- Set/Change Password Logic ---
  const setPasswordBtn = document.getElementById('set-password-btn');
  const newPasswordInput = document.getElementById('new-password-input');
  const passwordStatus = document.getElementById('password-status');
  if (setPasswordBtn && newPasswordInput) {
    setPasswordBtn.addEventListener('click', async () => {
      const password = newPasswordInput.value.trim();
      if (password.length < 4) {
        passwordStatus.textContent = 'Password must be at least 4 characters.';
        passwordStatus.style.color = '#e53935';
        return;
      }
      setPasswordBtn.disabled = true;
      passwordStatus.textContent = 'Setting password...';
      passwordStatus.style.color = '#1e40af';
      try {
        const res = await fetch(api(`/users/${currentUser.code}/set-password`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to set password');
        passwordStatus.textContent = '';
        showNotification('Password set successfully!');
        newPasswordInput.value = '';
      } catch (err) {
        passwordStatus.textContent = err.message || 'Failed to set password.';
        passwordStatus.style.color = '#e53935';
      }
      setPasswordBtn.disabled = false;
    });
  }

  // --- Restore Profile logic (with password modal) ---
  let _pendingUserRestoreCode = null;
  document.addEventListener('click', async function(e) {
    if (e.target && e.target.id === 'restore-profile-btn') {
      // Show the beautiful restore alert
      const restoreAlert = document.getElementById('restore-profile-modal');
      const restoreInput = document.getElementById('restore-code-input');
      restoreAlert.classList.remove('hidden');
      restoreAlert.classList.add('show');
      restoreInput.value = '';
      restoreInput.focus();
      setModalOpen(true);
    }
    
    // Handle confirm restore button
    if (e.target && e.target.id === 'confirm-restore-btn') {
      const code = document.getElementById('restore-code-input').value;
      if (!code || code.length !== 4 || !/^[0-9]{4}$/.test(code)) {
        showNotification('Please enter a valid 4-digit code.');
        return;
      }
      // Special handling for admin profile (0000)
      if (code === '0000') {
        // Show admin password modal
        const adminPasswordModal = document.getElementById('admin-password-modal');
        const adminPasswordInput = document.getElementById('admin-password-input');
        adminPasswordModal.classList.remove('hidden');
        adminPasswordModal.classList.add('show');
        adminPasswordInput.value = '';
        adminPasswordInput.focus();
        // Store intent to restore admin after password
        window._pendingAdminRestore = true;
        document.getElementById('restore-profile-modal').classList.remove('show');
        document.getElementById('restore-profile-modal').classList.add('hidden');
        setModalOpen(false); // Hide restore modal
        return;
      }
      
      // Check if user has a password set
      try {
        const res = await fetch(api(`/users/${code}`));
        if (!res.ok) throw new Error('User not found');
        const user = await res.json();
        if (user.password && user.password.length > 0) {
          // Show user password modal
          _pendingUserRestoreCode = code;
          const userPasswordModal = document.getElementById('user-password-modal');
          const userPasswordInput = document.getElementById('user-password-input');
          userPasswordModal.classList.remove('hidden');
          userPasswordModal.classList.add('show');
          userPasswordInput.value = '';
          userPasswordInput.focus();
          document.getElementById('restore-profile-modal').classList.remove('show');
          document.getElementById('restore-profile-modal').classList.add('hidden');
          return;
        }
        // If no password, restore as before
        localStorage.setItem('userProfile', JSON.stringify(user));
        await fetch(api(`/users/${code}/update-last-used`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        showNotification('Profile restored! Reloading...');
        document.getElementById('restore-profile-modal').classList.remove('show');
        document.getElementById('restore-profile-modal').classList.add('hidden');
        setTimeout(() => window.location.reload(), 900);
      } catch (err) {
        showNotification('Restore failed: ' + (err.message || err));
      }
    }
    
    // Handle cancel restore button
    if (e.target && e.target.id === 'cancel-restore-btn') {
      document.getElementById('restore-profile-modal').classList.remove('show');
      document.getElementById('restore-profile-modal').classList.add('hidden');
      setModalOpen(false); // Hide restore modal
    }
    
    // Handle close restore modal button
    if (e.target && e.target.id === 'close-restore-modal') {
      document.getElementById('restore-profile-modal').classList.remove('show');
      document.getElementById('restore-profile-modal').classList.add('hidden');
      setModalOpen(false); // Hide restore modal
    }
    
    // Cleanup old profiles logic
    if (e.target && e.target.id === 'cleanup-profiles-btn') {
      try {
        const res = await fetch(api('/users/cleanup-old'), {
          method: 'DELETE'
        });
        const data = await res.json();
        showNotification(`Cleaned up ${data.deletedCount} old unused profiles!`);
      } catch (err) {
        showNotification('Could not cleanup old profiles.');
      }
    }
    // Admin password modal logic
    if (e.target && e.target.id === 'confirm-admin-password-btn') {
      const password = document.getElementById('admin-password-input').value;
      if (!password) {
        showNotification('Please enter the admin password.');
        return;
      }
      if (window._pendingAdminRestore) {
        console.log('Attempting admin restore with password:', password);
        fetch(api('/users/0000/device-check'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password })
        })
        .then(async res => {
          const text = await res.text();
          let user = null;
          try { user = JSON.parse(text); } catch (e) { user = null; }
          console.log('Admin restore response:', res.status, text);
          if (!res.ok) throw new Error(user && user.error ? user.error : 'Incorrect password or admin profile not found');
          localStorage.setItem('userProfile', JSON.stringify(user));
          // Update last used timestamp
          await fetch(api(`/users/${user.code}/update-last-used`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          });
          showNotification('Admin profile restored! Reloading...');
          document.getElementById('admin-password-modal').classList.remove('show');
          document.getElementById('admin-password-modal').classList.add('hidden');
          setTimeout(() => window.location.reload(), 900);
        })
        .catch(err => {
          showNotification('Admin restore failed: ' + (err.message || err));
        });
        window._pendingAdminRestore = false;
      }
    }
    if (e.target && (e.target.id === 'cancel-admin-password-btn' || e.target.id === 'close-admin-password-modal')) {
      document.getElementById('admin-password-modal').classList.remove('show');
      document.getElementById('admin-password-modal').classList.add('hidden');
      setModalOpen(false); // Hide admin password modal
      window._pendingAdminRestore = false;
    }
    // User password modal logic
    if (e.target && e.target.id === 'confirm-user-password-btn') {
      const password = document.getElementById('user-password-input').value;
      if (!password) {
        showNotification('Please enter your password.');
        return;
      }
      if (_pendingUserRestoreCode) {
        fetch(api(`/users/${_pendingUserRestoreCode}/restore`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password })
        })
        .then(async res => {
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Incorrect password');
          localStorage.setItem('userProfile', JSON.stringify(data));
          await fetch(api(`/users/${_pendingUserRestoreCode}/update-last-used`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          });
          showNotification('Profile restored! Reloading...');
          document.getElementById('user-password-modal').classList.remove('show');
          document.getElementById('user-password-modal').classList.add('hidden');
          setTimeout(() => window.location.reload(), 900);
        })
        .catch(err => {
          showNotification('Restore failed: ' + (err.message || err));
        });
        _pendingUserRestoreCode = null;
      }
    }
    if (e.target && (e.target.id === 'cancel-user-password-btn' || e.target.id === 'close-user-password-modal')) {
      document.getElementById('user-password-modal').classList.remove('show');
      document.getElementById('user-password-modal').classList.add('hidden');
      _pendingUserRestoreCode = null;
    }
  });

  // Show join chat modal
  joinChatBtn.addEventListener('click', () => {
    joinChatModal.classList.remove('hidden');
    const modalContent = joinChatModal.querySelector('.settings-content');
    modalContent.style.animation = 'none';
    void modalContent.offsetWidth;
    modalContent.style.animation = '';
    joinCodeInput.value = '';
    joinCodeInput.focus();
    setModalOpen(true);
  });

  // Show join GROUP chat modal
  joinGroupBtn.addEventListener('click', () => {
    if (!joinGroupModal) return;
    joinGroupModal.classList.remove('hidden');
    const modalContent = joinGroupModal.querySelector('.settings-content');
    modalContent.style.animation = 'none';
    void modalContent.offsetWidth;
    modalContent.style.animation = '';
    joinGroupCodeInput.value = '';
    joinGroupCodeInput.focus();
    setModalOpen(true);
  });

  // Hide join chat modal
  closeJoinChat.addEventListener('click', () => {
    joinChatModal.classList.add('hidden');
    setModalOpen(false);
  });

  // Hide join GROUP chat modal
  closeJoinGroup.addEventListener('click', () => {
    if (!joinGroupModal) return;
    joinGroupModal.classList.add('hidden');
    setModalOpen(false);
  });

  // Only allow 4 digits in input
  joinCodeInput.addEventListener('input', (e) => {
    joinCodeInput.value = joinCodeInput.value.replace(/\D/g, '').slice(0, 4);
  });

  // Only allow 4 digits in group input
  joinGroupCodeInput.addEventListener('input', (e) => {
    joinGroupCodeInput.value = joinGroupCodeInput.value.replace(/\D/g, '').slice(0, 4);
  });

  // Handle join code submission
  submitJoinCodeBtn.addEventListener('click', async () => {
    const code = joinCodeInput.value;
    if (!/^\d{4}$/.test(code)) {
      showNotification('Please enter a valid 4-digit code.');
      return;
    }
    if (!currentUser || code === currentUser.code) {
      showNotification('Invalid user code.');
      return;
    }
    // Check if user exists and send request
    try {
      const res = await fetch(api(`/users/${currentUser.code}/send-request`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactCode: code })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');
      showNotification('Request sent!');
      joinChatModal.classList.add('hidden');
      setModalOpen(false); // Hide join chat modal
      fetchContactsAndGroups();
    } catch (err) {
      showNotification(err.message || 'Invalid user code.');
    }
  });

  // Handle join GROUP code submission
  submitJoinGroupCodeBtn.addEventListener('click', async () => {
    const code = joinGroupCodeInput.value;
    if (!/^\d{4}$/.test(code)) {
      showNotification('Please enter a valid 4-digit group code.');
      return;
    }
    if (!currentUser) {
      showNotification('Profile not ready yet.');
      return;
    }
    try {
      const res = await fetch(api(`/users/${currentUser.code}/join-group`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupCode: code })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Join failed');
      showNotification('Joined group!');
      joinGroupModal.classList.add('hidden');
      setModalOpen(false);
      fetchContactsAndGroups();
    } catch (err) {
      showNotification(err.message || 'Failed to join group.');
    }
  });

  // Add user to pending list
  function addToPendingList(user) {
    const pendingList = document.getElementById('pending-list');
    const pendingItem = document.createElement('div');
    pendingItem.className = 'pending-item';
    const profilePic = getProfilePictureUrl(user.profilePicture, user.username);
    pendingItem.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;padding:6px 0;">
        <img src="${profilePic}" alt="Profile" class="pending-profile-pic" style="width:24px;height:24px;border-radius:50%;object-fit:cover;background:#fff;">
        <span style="font-size:0.9rem;">${user.username}</span>
        <button class="cancel-pending-btn" style="margin-left:auto;padding:4px 8px;background:#ff5252;border:none;border-radius:4px;color:#fff;font-size:0.8rem;cursor:pointer;">Cancel</button>
      </div>
    `;
    pendingList.appendChild(pendingItem);

    // Cancel button logic
    const cancelBtn = pendingItem.querySelector('.cancel-pending-btn');
    cancelBtn.addEventListener('click', async () => {
      try {
        const res = await fetch(api(`/users/${currentUser.code}/cancel-pending`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contactCode: user.code })
        });
        if (!res.ok) {
          const err = await res.json();
          showNotification(err.error || 'Could not cancel pending request.');
          return;
        }
        showNotification('Pending request cancelled!');
        pendingItem.remove();
        fetchContactsAndGroups();
      } catch (err) {
        showNotification('Could not cancel pending request.');
      }
    });
  }

  // Add user to requests list
  function addToRequestsList(user, targetCode) {
    const requestsList = document.getElementById('requests-list');
    const requestItem = document.createElement('div');
    requestItem.className = 'request-item';
    const profilePic = getProfilePictureUrl(user.profilePicture, user.username);
    requestItem.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;padding:6px 0;">
        <img src="${profilePic}" alt="Profile" class="request-profile-pic" style="width:24px;height:24px;border-radius:50%;object-fit:cover;background:#fff;">
        <span style="font-size:0.9rem;">${user.username}</span>
        <button class="accept-btn" style="margin-left:auto;padding:4px 8px;background:#5aff63;border:none;border-radius:4px;color:#fff;font-size:0.8rem;cursor:pointer;">Accept</button>
        <button class="decline-btn" style="margin-left:4px;padding:4px 8px;background:#ff5252;border:none;border-radius:4px;color:#fff;font-size:0.8rem;cursor:pointer;">Decline</button>
      </div>
    `;
    requestsList.appendChild(requestItem);
    
    // Add accept/decline functionality
    const acceptBtn = requestItem.querySelector('.accept-btn');
    const declineBtn = requestItem.querySelector('.decline-btn');
    
    acceptBtn.addEventListener('click', async () => {
      await acceptRequest(user);
      requestItem.remove();
      fetchContactsAndGroups();
    });
    
    declineBtn.addEventListener('click', async () => {
      await declineRequest(user);
      requestItem.remove();
      showNotification('Request declined');
      fetchContactsAndGroups();
    });
  }

  // Accept a contact request
  async function acceptRequest(user) {
    try {
      const res = await fetch(api(`/users/${currentUser.code}/accept-request`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requesterCode: user.code })
      });
      if (!res.ok) {
        const err = await res.json();
        showNotification(err.error || 'Could not add contact.');
        return;
      }
      showNotification('Contact added!');
      fetchContactsAndGroups();
    } catch (err) {
      showNotification('Could not add contact.');
    }
  }
  // Decline a contact request
  async function declineRequest(user) {
    try {
      const res = await fetch(api(`/users/${currentUser.code}/decline-request`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requesterCode: user.code })
      });
      if (!res.ok) {
        const err = await res.json();
        showNotification(err.error || 'Could not decline request.');
        return;
      }
    } catch (err) {
      showNotification('Could not decline request.');
    }
  }

  // Remove a contact from the user's contacts list
  async function removeContact(contactCode) {
    try {
      const res = await fetch(api(`/users/${currentUser.code}/remove-contact`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactCode })
      });
      if (!res.ok) {
        const err = await res.json();
        showNotification(err.error || 'Could not remove contact.');
        return;
      }
      showNotification('Contact removed!');
      fetchContactsAndGroups();
    } catch (err) {
      showNotification('Could not remove contact.');
    }
  }

  // --- Custom Confirm Modal for Contact Removal ---
  const confirmModal = document.createElement('div');
  confirmModal.id = 'confirm-modal';
  confirmModal.className = 'modal hidden';
  confirmModal.innerHTML = `
    <div class="settings-content" style="min-width:260px;max-width:90vw;text-align:center;">
      <h3 id="confirm-message" style="margin-bottom:18px;">Are you sure?</h3>
      <div style="display:flex;justify-content:center;gap:18px;">
        <button id="confirm-yes-btn" class="settings-btn" style="background:#ff5252;">Yes</button>
        <button id="confirm-no-btn" class="settings-btn" style="background:#b6c6e3;color:#222;">No</button>
      </div>
    </div>
  `;
  document.body.appendChild(confirmModal);

  let confirmResolve = null;
  function showConfirmModal(message) {
    confirmModal.classList.remove('hidden');
    const msgEl = document.getElementById('confirm-message');
    if (msgEl && message) msgEl.textContent = message;
    return new Promise((resolve) => {
      confirmResolve = resolve;
    });
  }
  function hideConfirmModal() {
    confirmModal.classList.add('hidden');
    confirmResolve = null;
  }
  confirmModal.addEventListener('click', (e) => {
    if (e.target.id === 'confirm-yes-btn') {
      if (confirmResolve) confirmResolve(true);
      hideConfirmModal();
    } else if (e.target.id === 'confirm-no-btn') {
      if (confirmResolve) confirmResolve(false);
      hideConfirmModal();
    }
  });

  // Password row logic
  // Use the already declared passwordStatus
  const passwordInput = document.getElementById('new-password-input');
  const passwordVisibilityBtn = document.getElementById('password-visibility-btn');
  const passwordEditBtn = document.getElementById('password-edit-btn');
  let passwordEditMode = false;
  let passwordVisible = false;

  if (passwordInput && passwordVisibilityBtn && passwordEditBtn) {
    // Toggle password visibility
    passwordVisibilityBtn.addEventListener('click', () => {
      passwordVisible = !passwordVisible;
      passwordInput.type = passwordVisible ? 'text' : 'password';
      const icon = passwordVisibilityBtn.querySelector('i');
      icon.className = passwordVisible ? 'fa-solid fa-eye' : 'fa-solid fa-eye-slash';
    });

    // Toggle edit/save mode
    passwordEditBtn.addEventListener('click', async () => {
      if (!passwordEditMode) {
        // Enter edit mode
        passwordEditMode = true;
        passwordInput.readOnly = false;
        passwordInput.focus();
        const icon = passwordEditBtn.querySelector('i');
        icon.className = 'fa-solid fa-check';
      } else {
        // Save password
        const password = passwordInput.value.trim();
        if (password.length < 4) {
          passwordStatus.textContent = 'Password must be at least 4 characters.';
          passwordStatus.style.color = '#e53935';
          return;
        }
        passwordEditBtn.disabled = true;
        passwordStatus.textContent = 'Setting password...';
        passwordStatus.style.color = '#1e40af';
        try {
          const res = await fetch(api(`/users/${currentUser.code}/set-password`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Failed to set password');
          passwordStatus.textContent = '';
          showNotification('Password set successfully!');
          passwordInput.value = '';
          // Exit edit mode
          passwordEditMode = false;
          passwordInput.readOnly = true;
          const icon = passwordEditBtn.querySelector('i');
          icon.className = 'fa-solid fa-pen-to-square';
        } catch (err) {
          passwordStatus.textContent = err.message || 'Failed to set password.';
          passwordStatus.style.color = '#e53935';
        }
        passwordEditBtn.disabled = false;
      }
    });

    // Optional: Enter key saves in edit mode
    passwordInput.addEventListener('keydown', function(e) {
      if (passwordEditMode && e.key === 'Enter') {
        passwordEditBtn.click();
      }
    });
  }

  // --- Chat Messaging Logic ---
  let currentChatCode = null; // for 1-1 chats (contact code)
  let currentGroupCode = null; // for group chats (group code)
  let isGroupChat = false;
  let chatMessages = [];

  function formatDateLabel(date) {
    const now = new Date();
    const msgDate = new Date(date);
    const diff = (now - msgDate) / (1000 * 60 * 60 * 24);
    if (now.toDateString() === msgDate.toDateString()) return 'Today';
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (yesterday.toDateString() === msgDate.toDateString()) return 'Yesterday';
    return msgDate.toLocaleDateString();
  }

  function formatTime(date) {
    const d = new Date(date);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  async function loadChatMessages(contactCode) {
    try {
    const res = await fetch(api(`/messages/${currentUser.code}/${contactCode}`));
      if (!res.ok) {
        throw new Error('Failed to fetch messages');
      }
    chatMessages = await res.json();
    renderChatMessages();
    } catch (err) {
      console.log('Failed to fetch messages:', err);
      chatMessages = [];
      renderChatMessages();
      showNotification('Failed to load messages');
    }
  }

  async function loadGroupMessages(groupCode) {
    try {
      const res = await fetch(api(`/group-messages/${groupCode}`));
      if (!res.ok) {
        throw new Error('Failed to fetch group messages');
      }
      chatMessages = await res.json();
      renderChatMessages();
    } catch (err) {
      console.log('Failed to fetch group messages:', err);
      chatMessages = [];
      renderChatMessages();
      showNotification('Failed to load group messages');
    }
  }

  function renderChatMessages() {
    const container = document.getElementById('chat-messages-container');
    container.innerHTML = '';
    let lastDateLabel = '';
    chatMessages.forEach((msg, idx) => {
      const isSelf = msg.senderCode === currentUser.code;
      const dateLabel = formatDateLabel(msg.timestamp);
      if (dateLabel !== lastDateLabel) {
        const dateDiv = document.createElement('div');
        dateDiv.className = 'chat-date-label';
        dateDiv.textContent = dateLabel;
        container.appendChild(dateDiv);
        lastDateLabel = dateLabel;
      }
      // Wrap each message in a row to support avatar on the right in group chats
      const row = document.createElement('div');
      row.style = 'display:flex;align-items:flex-end;gap:6px;';
      // Align self messages to the right
      if (isSelf) {
        row.style.justifyContent = 'flex-end';
      }

      const bubble = document.createElement('div');
      bubble.className = 'chat-bubble ' + (isSelf ? 'self' : 'other');
      bubble.setAttribute('data-message-id', msg._id);
      // Handle deleted messages
      let displayContent = msg.content;
      let showMenu = true;
      
      if (msg.deleted) {
        if (isSelf) {
          displayContent = 'You deleted this message';
        } else {
          // Find the sender's username
          const sender = findUserByCode(msg.senderCode);
          const senderName = sender.username;
          displayContent = `${senderName} deleted their message`;
        }
        showMenu = false; // Don't show menu for deleted messages
      }
      
                   // Handle different message types
             let contentHtml = '';
             if (msg.type === 'image') {
               const fixedUrl = fixUrlPort(msg.content);
               contentHtml = `
                 <div class="media-message">
                   <img src="${fixedUrl}" alt="Image" onclick="openMediaViewer('${fixedUrl}', 'image')">
                   ${msg.caption ? `<div class="media-caption">${msg.caption}</div>` : ''}
                 </div>
               `;
             } else if (msg.type === 'video') {
               const fixedUrl = fixUrlPort(msg.content);
               contentHtml = `
                 <div class="media-message">
                   <video controls onclick="openMediaViewer('${fixedUrl}', 'video')">
                     <source src="${fixedUrl}" type="video/mp4">
                     Your browser does not support the video tag.
                   </video>
                   ${msg.caption ? `<div class="media-caption">${msg.caption}</div>` : ''}
                 </div>
               `;
             } else if (msg.type === 'audio') {
               const fixedUrl = fixUrlPort(msg.content);
               contentHtml = `
                 <div class="media-message">
                   <audio controls>
                     <source src="${fixedUrl}" type="audio/mpeg">
                     Your browser does not support the audio tag.
                   </audio>
                   ${msg.caption ? `<div class="media-caption">${msg.caption}</div>` : ''}
                 </div>
               `;
             } else if (['document', 'archive', 'other'].includes(msg.type)) {
               const fixedUrl = fixUrlPort(msg.content);
               contentHtml = `
                 <div class="media-message">
                   <div class="file-message" onclick="downloadFile('${fixedUrl}', '${msg.fileName}')">
                     <i class="fa-solid ${getFileIcon(msg.type)} file-icon-${msg.type}"></i>
                     <div class="file-info">
                       <div class="file-name">${msg.fileName || 'File'}</div>
                       <div class="file-type">${msg.type.toUpperCase()} file</div>
                     </div>
                     <i class="fa-solid fa-download"></i>
                   </div>
                   ${msg.caption ? `<div class="media-caption">${msg.caption}</div>` : ''}
                 </div>
               `;
             } else {
               contentHtml = `<div class="bubble-content">${displayContent}</div>`;
             }
             
             // Add reply preview if this message is a reply
             if (msg.replyTo) {
               const repliedMessage = chatMessages.find(m => m._id === msg.replyTo);
               if (repliedMessage) {
                 const replySenderName = repliedMessage.senderCode === currentUser.code ? 'You' : 
                   findUserByCode(repliedMessage.senderCode).username;
                 
                 let replyPreview = '';
                 if (repliedMessage.type === 'text') {
                   replyPreview = repliedMessage.content;
                 } else if (repliedMessage.type === 'image') {
                   replyPreview = '📷 Image';
                 } else if (repliedMessage.type === 'video') {
                   replyPreview = '🎥 Video';
                 } else if (repliedMessage.type === 'audio') {
                   replyPreview = '🎵 Audio';
                 } else {
                   replyPreview = `📎 ${repliedMessage.fileName || 'File'}`;
                 }
                 
                 const replyHtml = `
                   <div class="reply-preview" onclick="scrollToMessage('${repliedMessage._id}')" style="cursor: pointer;">
                     <div class="reply-preview-sender">${replySenderName}</div>
                     <div class="reply-preview-content">${replyPreview}</div>
                   </div>
                 `;
                 
                 // Insert reply preview before the main content
                 if (msg.type === 'text') {
                   contentHtml = `<div class="bubble-content">${replyHtml}${displayContent}</div>`;
                 } else {
                   // For media messages, insert reply preview at the beginning
                   contentHtml = contentHtml.replace('<div class="media-message">', `<div class="media-message">${replyHtml}`);
                 }
               }
             }
             
             // Determine menu options based on message type
             let menuOptions = '';
             if (msg.type === 'text') {
               // Text messages: Copy option
               menuOptions = `
                 <button class="menu-item" onclick="copyMessage(${idx})">
                   <i class="fa-solid fa-copy"></i> Copy
                 </button>
                 <button class="menu-item" onclick="replyToMessage(${idx})">
                   <i class="fa-solid fa-reply"></i> Reply
                 </button>
                 ${isSelf ? `<button class="menu-item" onclick="editMessage(${idx})">
                   <i class="fa-solid fa-edit"></i> Edit
                 </button>
                 <button class="menu-item delete-btn" onclick="deleteMessage(${idx})">
                   <i class="fa-solid fa-trash"></i> Delete
                 </button>` : ''}
               `;
             } else {
               // All other message types (images, videos, audio, documents, etc.): Download option
               const fixedUrl = fixUrlPort(msg.content);
               menuOptions = `
                 <button class="menu-item" onclick="downloadFile('${fixedUrl}', '${msg.fileName}')">
                   <i class="fa-solid fa-download"></i> Download
                 </button>
                 <button class="menu-item" onclick="replyToMessage(${idx})">
                   <i class="fa-solid fa-reply"></i> Reply
                 </button>
                 ${isSelf ? `<button class="menu-item" onclick="editMessage(${idx})">
                   <i class="fa-solid fa-edit"></i> Edit
                 </button>
                 <button class="menu-item delete-btn" onclick="deleteMessage(${idx})">
                   <i class="fa-solid fa-trash"></i> Delete
                 </button>` : ''}
               `;
             }
             
             bubble.innerHTML = `
               ${contentHtml}
               <span class="bubble-time">${formatTime(msg.timestamp)}</span>
               ${showMenu ? `<div class="bubble-menu">
                 <button class="bubble-menu-btn" onclick="showBubbleMenu(${idx})">
                   <i class="fa-solid fa-ellipsis-vertical"></i>
                 </button>
                 <div class="bubble-menu-dropdown" id="bubble-menu-${idx}">
                   ${menuOptions}
                 </div>
               </div>` : ''}
             `;
        // In group chats, show avatar on the LEFT of the bubble and username above the bubble
        if (isGroupChat) {
          const sender = msg.senderCode === currentUser.code
            ? { username: currentUser.username, profilePicture: (document.getElementById('profile-pic-preview') ? document.getElementById('profile-pic-preview').src : currentUser.profilePicture) }
            : findUserByCode(msg.senderCode);
          
          // Better fallback for sender info
          const senderUsername = sender.username;
          const fallbackSeed = senderUsername !== 'Unknown User' ? senderUsername : msg.senderCode;
          const avatarSrc = getProfilePictureUrl(sender.profilePicture, sender.username, fallbackSeed);

          // Create username label with clickable profile picture
          const usernameLabel = document.createElement('div');
          usernameLabel.style = 'font-size:0.78rem;color:#6b7280;margin:0 6px 4px 6px;display:flex;align-items:center;gap:6px;';
          
          // Add clickable profile picture
          const profilePic = document.createElement('img');
          profilePic.src = avatarSrc;
          profilePic.style = 'width:20px;height:20px;border-radius:50%;cursor:pointer;border:1px solid #e5e7eb;';
          profilePic.title = 'Click to view user info';
          profilePic.addEventListener('click', () => {
            if (sender && !isSelf) {
              showUserInfo(sender);
            }
          });
          
          const usernameText = document.createElement('span');
          usernameText.textContent = senderUsername;
          
          usernameLabel.appendChild(profilePic);
          usernameLabel.appendChild(usernameText);

        // Content column (username above, bubble below)
        const contentCol = document.createElement('div');
        contentCol.style = 'display:flex;flex-direction:column;align-items:' + (isSelf ? 'flex-end' : 'flex-start') + ';max-width:80%';
        contentCol.appendChild(usernameLabel);
        contentCol.appendChild(bubble);

        if (isSelf) {
          // For self messages in groups, keep right alignment and do not show avatar on left
          row.appendChild(contentCol);
        } else {
          // Other users: avatar on the left
          const avatar = document.createElement('img');
          avatar.src = avatarSrc;
          avatar.alt = 'Sender';
          avatar.style = 'width:28px;height:28px;border-radius:50%;object-fit:cover;box-shadow:0 2px 8px #2563eb22;';
          avatar.onerror = function() {
            this.onerror = null;
            this.src = `https://api.dicebear.com/7.x/thumbs/svg?seed=${encodeURIComponent(fallbackSeed)}`;
          };
          row.appendChild(avatar);
          row.appendChild(contentCol);
        }
        container.appendChild(row);
      } else {
        // 1-1 chat - keep previous behavior
      container.appendChild(bubble);
      }
    });
    container.scrollTop = container.scrollHeight;
  }

  // Copy message to clipboard
  window.copyMessage = function(messageIndex) {
    const message = chatMessages[messageIndex];
    let contentToCopy = fixUrlPort(message.content);
    
    navigator.clipboard.writeText(contentToCopy).then(() => {
      showNotification('Message copied to clipboard!');
    }).catch(() => {
      showNotification('Failed to copy message');
    });
    hideAllBubbleMenus();
  };

  // Delete message
  window.deleteMessage = async function(messageIndex) {
    const message = chatMessages[messageIndex];
    
    // Show confirmation dialog
    const confirmed = confirm('Are you sure you want to delete this message?');
    if (!confirmed) {
      hideAllBubbleMenus();
      return;
    }
    
    try {
      const res = await fetch(api(`/messages/${message._id}`), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deletedBy: currentUser.code })
      });
      
      if (!res.ok) {
        throw new Error('Failed to delete message');
      }
      
      const deletedMessage = await res.json();
      
      // Update local message
      chatMessages[messageIndex] = deletedMessage;
      renderChatMessages();
      showNotification('Message deleted!');
    } catch (err) {
      console.log('Failed to delete message:', err);
      showNotification('Failed to delete message');
    }
    
    hideAllBubbleMenus();
  };

  // Reply to message
  window.replyToMessage = function(messageIndex) {
    const message = chatMessages[messageIndex];
    
    // Remove any existing reply indicator
    const existingIndicator = document.getElementById('reply-indicator');
    if (existingIndicator) {
      existingIndicator.remove();
    }
    
    // Show reply indicator above the input
    const replyIndicator = document.createElement('div');
    replyIndicator.id = 'reply-indicator';
    replyIndicator.className = 'reply-indicator';
    
    const senderName = message.senderCode === currentUser.code ? 'You' : 
      findUserByCode(message.senderCode).username;
    
    let replyContent = '';
    if (message.type === 'text') {
      replyContent = message.content;
    } else if (message.type === 'image') {
      replyContent = '📷 Image';
    } else if (message.type === 'video') {
      replyContent = '🎥 Video';
    } else if (message.type === 'audio') {
      replyContent = '🎵 Audio';
    } else {
      replyContent = `📎 ${message.fileName || 'File'}`;
    }
    
    replyIndicator.innerHTML = `
      <div class="reply-content">
        <div class="reply-sender">${senderName}</div>
        <div class="reply-text">${replyContent}</div>
      </div>
      <button class="cancel-reply-btn" onclick="cancelReply()">
        <i class="fa-solid fa-times"></i>
      </button>
    `;
    
    // Insert reply indicator before the chat input
    const chatInputContainer = document.querySelector('.chat-input-container');
    chatInputContainer.parentNode.insertBefore(replyIndicator, chatInputContainer);
    
    // Focus on the input
    msgInput.focus();
    
    // Store the reply target
    window.replyingTo = messageIndex;
    
    hideAllBubbleMenus();
  };
  
  // Cancel reply
  window.cancelReply = function() {
    const replyIndicator = document.getElementById('reply-indicator');
    if (replyIndicator) {
      replyIndicator.remove();
    }
    window.replyingTo = undefined;
  };
  
  // Scroll to replied message
  window.scrollToMessage = function(messageId) {
    // Find the message element by its ID
    const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
    
    if (messageElement) {
      // Scroll to the message with smooth animation
      messageElement.scrollIntoView({ 
        behavior: 'smooth', 
        block: 'center' 
      });
      
      // Add a highlight effect
      messageElement.style.boxShadow = '0 0 20px #2563eb';
      messageElement.style.transition = 'box-shadow 0.3s ease';
      
      // Remove the highlight after 2 seconds
      setTimeout(() => {
        messageElement.style.boxShadow = '';
      }, 2000);
      
      showNotification('Scrolled to replied message!');
    } else {
      showNotification('Message not found');
    }
  };
  
  // Edit message
  window.editMessage = function(messageIndex) {
    const message = chatMessages[messageIndex];
    
    // Put the message text in the input box
    const msgInput = document.getElementById('chat-message-input');
    msgInput.value = message.content;
    msgInput.focus();
    msgInput.select();
    
    // Store the message index being edited and set editing flag
    window.editingMessageIndex = messageIndex;
    isEditing = true;
    
    // Change send button to update button
    sendMsgBtn.innerHTML = '<i class="fa-solid fa-check"></i>';
    sendMsgBtn.style.background = '#5aff63';
    
    showNotification('Edit mode: Press Enter or click the check button to save');
    hideAllBubbleMenus();
  };

  // Show bubble menu
  window.showBubbleMenu = function(messageIndex) {
    hideAllBubbleMenus();
    const menu = document.getElementById(`bubble-menu-${messageIndex}`);
    if (menu) {
      menu.classList.add('show');
    }
  };

  // Hide all bubble menus
  function hideAllBubbleMenus() {
    document.querySelectorAll('.bubble-menu-dropdown').forEach(menu => {
      menu.classList.remove('show');
    });
  }

  // Close menus when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.bubble-menu')) {
      hideAllBubbleMenus();
    }
  });

  function addChatMessage(msg) {
    chatMessages.push(msg);
    renderChatMessages();
  }

  // --- Socket.IO: Listen for new messages ---
  function setupChatSocket() {
    // This function is no longer needed as message handling is done in setupSocketIO
    // Keeping it for compatibility but removing duplicate event listeners
    console.log('setupChatSocket called - message handling is now centralized');
  }

  // --- Send message logic ---
  const sendMsgBtn = document.getElementById('send-message-btn');
  const msgInput = document.getElementById('chat-message-input');
  let originalSendFunction = null;
  let isEditing = false;

  async function sendMessage() {
    const content = msgInput.value.trim();
    if (!content && !selectedFile) {
      showNotification('💬 Please enter a message or select a file', 'warning');
      return;
    }
    
    if (!isGroupChat && !currentChatCode) return;
    
    if (isEditing && window.editingMessageIndex !== undefined) {
      // Update existing message in database
      const messageToEdit = chatMessages[window.editingMessageIndex];
      
      try {
        const res = await fetch(api(`/messages/${messageToEdit._id}`), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content })
        });
        
        if (!res.ok) {
          throw new Error('Failed to update message');
        }
        
        const updatedMessage = await res.json();
        
        // Update local message
        chatMessages[window.editingMessageIndex] = updatedMessage;
        renderChatMessages();
        showNotification('Message updated!');
      } catch (err) {
        console.log('Failed to update message:', err);
        showNotification('Failed to update message');
      }
      
      // Reset to normal send mode
      window.editingMessageIndex = undefined;
      isEditing = false;
      sendMsgBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i>';
      sendMsgBtn.style.background = '';
    } else {
      // Normal send behavior
      if (socket && socket.connected) {
        console.log('Socket is connected, sending message...');
        if (selectedFile && selectedFileBase64) {
          // Send media message
          console.log('Sending media message:', {
            senderCode: currentUser.code,
            receiverCode: isGroupChat ? null : currentChatCode,
            type: getFileType(selectedFile),
            fileName: selectedFile.name,
            caption: content || null
          });
          
          showNotification('📤 Sending file...', 'info');
          
          if (isGroupChat) {
            socket.emit('send-group-message', {
              senderCode: currentUser.code,
              groupCode: currentGroupCode,
              content: selectedFileBase64,
              type: getFileType(selectedFile),
              fileName: selectedFile.name,
              caption: content || null,
              replyTo: window.replyingTo !== undefined ? chatMessages[window.replyingTo]._id : null
            });
        // Move group to top on file send
        bumpChatCardToTop('group', currentGroupCode);
          } else {
    socket.emit('send-message', {
      senderCode: currentUser.code,
      receiverCode: currentChatCode,
              content: selectedFileBase64,
              type: getFileType(selectedFile),
              fileName: selectedFile.name,
              caption: content || null,
              replyTo: window.replyingTo !== undefined ? chatMessages[window.replyingTo]._id : null
            });
        // Move contact to top on file send
        bumpChatCardToTop('contact', currentChatCode);
          }
          
          // Clear file selection
          selectedFile = null;
          selectedFileBase64 = null;
          
          // Clear reply indicator if replying
          if (window.replyingTo !== undefined) {
            cancelReply();
          }
        } else {
          // Send text message
          if (isGroupChat) {
            socket.emit('send-group-message', {
              senderCode: currentUser.code,
              groupCode: currentGroupCode,
      content,
      type: 'text',
              replyTo: window.replyingTo !== undefined ? chatMessages[window.replyingTo]._id : null
            });
        // Move group to top immediately on send
        bumpChatCardToTop('group', currentGroupCode);
          } else {
            socket.emit('send-message', {
              senderCode: currentUser.code,
              receiverCode: currentChatCode,
              content,
              type: 'text',
              replyTo: window.replyingTo !== undefined ? chatMessages[window.replyingTo]._id : null
            });
        // Move contact to top immediately on send
        bumpChatCardToTop('contact', currentChatCode);
          }
        }
      }
    }
    
    msgInput.value = '';
    
    // Clear reply indicator if replying
    if (window.replyingTo !== undefined) {
      cancelReply();
    }
  }

  sendMsgBtn.addEventListener('click', sendMessage);
  msgInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      sendMessage();
    } else if (e.key === 'Escape' && isEditing) {
      // Cancel editing
      window.editingMessageIndex = undefined;
      isEditing = false;
      msgInput.value = '';
      sendMsgBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i>';
      sendMsgBtn.style.background = '';
      showNotification('Edit cancelled');
    }
  });

  // --- File handling for all file types ---
  const fileInput = document.getElementById('file-input');
  const sendMediaBtn = document.getElementById('send-media-btn');
  
  if (sendMediaBtn && fileInput) {
    sendMediaBtn.addEventListener('click', () => {
      fileInput.click();
    });
    
    fileInput.addEventListener('change', handleFileSelect);
  } else {
    console.error('File input or send media button not found!');
  }
  
  // Global variables for media preview
  let selectedFile = null;
  let selectedFileBase64 = null;
  
  async function handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    console.log('File selected:', file.name, 'Type:', file.type, 'Size:', file.size);
    
    // Show uploading notification
    showNotification('📤 Uploading file...', 'info');
    
    // Check file size - 150MB limit for all files
    const maxSize = 150 * 1024 * 1024; // 150MB limit
    const maxSizeMB = '150MB';
    
    if (file.size > maxSize) {
      showNotification(`❌ File too large! Maximum size is ${maxSizeMB}`, 'error');
      fileInput.value = '';
      return;
    }
    
    // All file types are now supported (no type restrictions)
    
    selectedFile = file;
    
    try {
      // Convert file to base64 and send immediately
      selectedFileBase64 = await fileToDataURL(file);
      console.log('File converted to base64, sending message...');
      showNotification('✅ File uploaded successfully!', 'success');
      sendMessage();
      
      // Clear the file input so the same file can be selected again
      fileInput.value = '';
    } catch (err) {
      console.error('Error processing file:', err);
      showNotification('❌ Failed to upload file. Please try again.', 'error');
      fileInput.value = '';
    }
  }
  

  
  function getFileType(file) {
    if (file.type.startsWith('image/')) return 'image';
    if (file.type.startsWith('video/')) return 'video';
    if (file.type.startsWith('audio/')) return 'audio';
    if (file.type.includes('pdf') || file.type.includes('document') || file.type.includes('text') || 
        file.type.includes('word') || file.type.includes('excel') || file.type.includes('powerpoint') ||
        file.type.includes('presentation') || file.type.includes('spreadsheet')) return 'document';
    if (file.type.includes('zip') || file.type.includes('rar') || file.type.includes('tar') || 
        file.type.includes('7z') || file.type.includes('gzip') || file.type.includes('bzip2')) return 'archive';
    return 'other';
  }
  
  function getFileIcon(fileType) {
    const icons = {
      image: 'fa-image',
      video: 'fa-video',
      audio: 'fa-music',
      document: 'fa-file-lines',
      archive: 'fa-file-zipper',
      other: 'fa-file'
    };
    return icons[fileType] || 'fa-file';
  }
  
  function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
  
  
  

  
  async function fileToDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => resolve(reader.result);
      reader.onerror = error => reject(error);
    });
  }
  
  // --- Media viewer for full-screen viewing ---
  window.openMediaViewer = function(src, type) {
    const viewer = document.createElement('div');
    viewer.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: rgba(0, 0, 0, 0.9);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
      cursor: pointer;
    `;
    
    const media = type === 'image' ? 
      `<img src="${src}" style="max-width: 90vw; max-height: 90vh; object-fit: contain;">` :
      `<video controls style="max-width: 90vw; max-height: 90vh;">
         <source src="${src}" type="video/mp4">
         Your browser does not support the video tag.
       </video>`;
    
    viewer.innerHTML = media;
    
    viewer.addEventListener('click', () => {
      document.body.removeChild(viewer);
    });
    
    document.body.appendChild(viewer);
  };
  
  window.downloadFile = function(base64, fileName) {
    const link = document.createElement('a');
    link.href = base64;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };



  // --- Open chat interface: load messages and set currentChatCode ---
  function openChatInterface(contactCode) {
    // Find the contact data
    const contact = contacts.find(c => c.code === contactCode);
    if (!contact) return;
    
    // Mark messages as read for this contact
    markMessagesAsRead(contactCode);
    
    // Update chat interface with contact info
    document.getElementById('chat-user-name').textContent = contact.username;
    document.getElementById('chat-user-code').textContent = contact.code;
    document.getElementById('chat-user-pic').src = getProfilePictureUrl(contact.profilePicture, contact.username);

    // Hide group settings button for 1-on-1 chats
    if (groupSettingsBtn) {
      groupSettingsBtn.style.display = 'none';
    }

    if (audioCallBtn) {
      audioCallBtn.disabled = false;
      audioCallBtn.title = 'Start voice call';
    }
    if (videoCallBtn) {
      videoCallBtn.disabled = false;
      videoCallBtn.title = 'Start video call';
    }
    
    // Update last seen
    updateLastSeen(contact);
    
    // Show chat interface
    const chatInterface = document.getElementById('chat-interface');
    chatInterface.classList.remove('hidden');
    setModalOpen(true);
    isGroupChat = false;
    currentGroupCode = null;
    currentChatCode = contactCode;
    loadChatMessages(contactCode);
    setupChatSocket();
  }

  function closeChatInterface() {
    const chatInterface = document.getElementById('chat-interface');
    chatInterface.classList.add('hidden');
    setModalOpen(false);
    if (peerConnection) {
      endCall('ended');
    } else if (incomingCallData) {
      declineIncomingCall();
    } else {
      cleanupCall();
    }
    if (audioCallBtn) {
      audioCallBtn.disabled = true;
    }
    if (videoCallBtn) {
      videoCallBtn.disabled = true;
    }
    currentChatCode = null;
    currentGroupCode = null;
    isGroupChat = false;
    chatMessages = [];
    document.getElementById('chat-messages-container').innerHTML = '';
  }

  // Leave chat button event listener
  document.getElementById('leave-chat-btn').addEventListener('click', closeChatInterface);

  // Function to update last seen display and online status
  function updateLastSeen(contact) {
    const lastSeenElement = document.getElementById('chat-user-last-seen');
    const onlineIndicator = document.getElementById('online-status-indicator');
    
    if (contact.isOnline) {
      lastSeenElement.textContent = '🟢 online';
      lastSeenElement.style.color = '#10b981';
      onlineIndicator.classList.add('online');
    } else {
      onlineIndicator.classList.remove('online');
      if (contact.lastSeen) {
        const lastSeen = new Date(contact.lastSeen);
        const now = new Date();
        const diffMs = now - lastSeen;
        const diffMins = Math.floor(diffMs / (1000 * 60));
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
        
        if (diffMins < 1) {
          lastSeenElement.textContent = 'last seen just now';
        } else if (diffMins < 60) {
          lastSeenElement.textContent = `last seen ${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
        } else if (diffHours < 24) {
          lastSeenElement.textContent = `last seen ${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
        } else if (diffDays < 7) {
          lastSeenElement.textContent = `last seen ${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
        } else {
          lastSeenElement.textContent = `last seen ${lastSeen.toLocaleDateString()}`;
        }
        lastSeenElement.style.color = '#9ca3af';
      } else {
        lastSeenElement.textContent = '';
      }
    }
  }
  
  // Socket listener for user status changes
  if (socket) {
    socket.on('user-status-changed', (data) => {
      // Update the contact data
      const contactIndex = contacts.findIndex(c => c.code === data.userCode);
      if (contactIndex !== -1) {
        contacts[contactIndex].isOnline = data.isOnline;
        contacts[contactIndex].lastSeen = data.lastSeen;
        
        // Update chat header if this is the current chat
        if (data.userCode === currentChatCode) {
          updateLastSeen(contacts[contactIndex]);
        }
        
        // Update contact list display
        updateContactListDisplay();
      }
    });
  }
  
  // Socket listener for new messages - REMOVED (duplicate of setupSocketIO handler)
  
  // Function to increment unread count for a contact
  function incrementUnreadCount(contactCode) {
    const contactIndex = contacts.findIndex(c => c.code === contactCode);
    if (contactIndex !== -1) {
      contacts[contactIndex].unreadCount = (contacts[contactIndex].unreadCount || 0) + 1;
      bumpChatCardToTop('contact', contactCode);
      updateContactListDisplay();
    }
  }
  
  // Function to mark messages as read for a contact
  function markMessagesAsRead(contactCode) {
    const contactIndex = contacts.findIndex(c => c.code === contactCode);
    if (contactIndex !== -1) {
      contacts[contactIndex].unreadCount = 0;
      updateContactListDisplay();
    }
  }

  // Move a chat card (contact/group) to the top of the list
  function bumpChatCardToTop(type, code) {
    // Update chat order in localStorage
    updateChatOrder(code, type === 'group');
    
    // Re-render the chat list to apply the new order
    fetchContactsAndGroups();
  }
  
  // Function to update contact list display with online status and unread counts
  function updateContactListDisplay() {
    const contactItems = chatListContainer.querySelectorAll('.chat-list-item');
    contactItems.forEach((item, index) => {
      if (contacts[index]) {
        // Update online status
        const indicator = item.querySelector('.contact-online-indicator');
        if (indicator) {
          if (contacts[index].isOnline) {
            indicator.classList.add('online');
          } else {
            indicator.classList.remove('online');
          }
        }
        
        // Update unread badge
        const unreadBadge = item.querySelector('.unread-badge');
        if (unreadBadge) {
          const unreadCount = contacts[index].unreadCount || 0;
          if (unreadCount > 0) {
            unreadBadge.textContent = unreadCount > 99 ? '99+' : unreadCount;
            unreadBadge.style.display = 'block';
          } else {
            unreadBadge.style.display = 'none';
          }
        }
      }
    });
  }

  // Group creation variables
  let selectedGroupMembers = [];
  let groupIconFile = null;
  let createdGroupData = null;
  
  // Group creation functions
  function openGroupCreationModal() {
    document.getElementById('create-group-modal').classList.remove('hidden');
    resetGroupCreationForm();
    showGroupDetailsStep();
  }
  
  function closeGroupCreationModal() {
    document.getElementById('create-group-modal').classList.add('hidden');
    resetGroupCreationForm();
  }
  
  // Make functions globally accessible
  window.openGroupCreationModal = openGroupCreationModal;
  window.closeGroupCreationModal = closeGroupCreationModal;
  
  function resetGroupCreationForm() {
    selectedGroupMembers = [];
    groupIconFile = null;
    createdGroupData = null;
    document.getElementById('group-name').value = '';
    document.getElementById('group-icon-preview').src = 'https://api.dicebear.com/7.x/thumbs/svg?seed=group';
    document.getElementById('invitation-message').value = 'You have been invited to join this group';
    showGroupDetailsStep();
  }
  
  function showGroupDetailsStep() {
    document.getElementById('group-details-step').classList.remove('hidden');
    document.getElementById('members-step').classList.add('hidden');
    document.getElementById('group-success-step').classList.add('hidden');
  }
  
  function showMembersStep() {
    document.getElementById('group-details-step').classList.add('hidden');
    document.getElementById('members-step').classList.remove('hidden');
    document.getElementById('group-success-step').classList.add('hidden');
    renderContactsForGroup();
  }
  
  function showSuccessStep() {
    document.getElementById('group-details-step').classList.add('hidden');
    document.getElementById('members-step').classList.add('hidden');
    document.getElementById('group-success-step').classList.remove('hidden');
  }
  
  function nextToMembersStep() {
    const groupName = document.getElementById('group-name').value.trim();
    if (!groupName) {
      showNotification('Please enter a group name');
      return;
    }
    showMembersStep();
  }
  
  function backToDetailsStep() {
    showGroupDetailsStep();
  }
  
  function uploadGroupIcon() {
    document.getElementById('group-icon-input').click();
  }
  
  function resetGroupIcon() {
    document.getElementById('group-icon-preview').src = 'https://api.dicebear.com/7.x/thumbs/svg?seed=group';
    groupIconFile = null;
  }
  
  // Make functions globally accessible
  window.nextToMembersStep = nextToMembersStep;
  window.backToDetailsStep = backToDetailsStep;
  window.uploadGroupIcon = uploadGroupIcon;
  window.resetGroupIcon = resetGroupIcon;
  
  // Handle group icon file selection
  document.getElementById('group-icon-input').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (file) {
      if (file.size > 150 * 1024 * 1024) { // 150MB limit
        showNotification('File too large. Maximum size is 150MB.');
        return;
      }
      
      const reader = new FileReader();
      reader.onload = function(e) {
        document.getElementById('group-icon-preview').src = e.target.result;
        groupIconFile = file;
      };
      reader.readAsDataURL(file);
    }
  });
  
  function renderContactsForGroup() {
    const contactsContainer = document.getElementById('contacts-for-group');
    const selectedContainer = document.getElementById('selected-members');
    
    // Clear previous content
    contactsContainer.innerHTML = '';
    selectedContainer.innerHTML = '';
    
    if (contacts.length === 0) {
      contactsContainer.innerHTML = '<p style="color: #9ca3af; text-align: center; grid-column: 1 / -1;">No contacts available. Add some contacts first to create a group.</p>';
      return;
    }
    
    // Render contacts grid
    contacts.forEach(contact => {
      const contactItem = document.createElement('div');
      contactItem.className = 'contact-item';
      contactItem.onclick = () => toggleContactSelection(contact);
      
      contactItem.innerHTML = `
        <img src="${getProfilePictureUrl(contact.profilePicture, contact.username)}" alt="${contact.username}">
        <span>${contact.username}</span>
      `;
      
      contactsContainer.appendChild(contactItem);
    });
    
    // Render selected members
    updateSelectedMembersDisplay();
  }
  
  function toggleContactSelection(contact) {
    const index = selectedGroupMembers.findIndex(m => m.code === contact.code);
    if (index === -1) {
      selectedGroupMembers.push(contact);
    } else {
      selectedGroupMembers.splice(index, 1);
    }
    updateSelectedMembersDisplay();
  }
  
  function updateSelectedMembersDisplay() {
    const selectedContainer = document.getElementById('selected-members');
    
    if (selectedGroupMembers.length === 0) {
      selectedContainer.innerHTML = '<p style="color: #9ca3af; text-align: center;">No members selected. Click on contacts below to add them.</p>';
      return;
    }
    
    selectedContainer.innerHTML = selectedGroupMembers.map(member => `
      <div class="selected-member-tag">
        <img src="${getProfilePictureUrl(member.profilePicture, member.username)}" alt="${member.username}" style="width: 24px; height: 24px; border-radius: 50%; margin-right: 8px;">
        <span>${member.username}</span>
        <button onclick="removeMember('${member.code}')" style="background: none; border: none; color: #ef4444; cursor: pointer; margin-left: 8px;">×</button>
      </div>
    `).join('');
  }
  
  function removeMember(memberCode) {
    selectedGroupMembers = selectedGroupMembers.filter(m => m.code !== memberCode);
    updateSelectedMembersDisplay();
  }
  
  async function createGroup() {
    if (selectedGroupMembers.length === 0) {
      showNotification('Please select at least one member for the group');
      return;
    }
    
    const groupName = document.getElementById('group-name').value.trim();
    const invitationMessage = document.getElementById('invitation-message').value.trim();
    
    try {
      // Create group data
      const groupData = {
        name: groupName,
        icon: groupIconFile ? await fileToBase64(groupIconFile) : '',
        members: selectedGroupMembers.map(m => m.code),
        admins: [currentUser.code], // Creator is admin
        invitationMessage: invitationMessage
      };
      
      console.log('Creating group with data:', groupData); // Debug log
      
      // Send to server
      const response = await fetch(api('/groups'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(groupData)
      });
      
      if (!response.ok) {
        throw new Error('Failed to create group');
      }
      
      const createdGroup = await response.json();
      createdGroupData = createdGroup;
      
      console.log('Group created successfully:', createdGroup); // Debug log
      
      // Show success step
      document.getElementById('group-code-display').textContent = createdGroup.code;
      document.getElementById('created-group-name').textContent = createdGroup.name;
      document.getElementById('created-group-members').textContent = selectedGroupMembers.length + ' members';
      
      showSuccessStep();
      
      // Refresh groups list
      fetchContactsAndGroups();
      
      showNotification('Group created successfully!');
      
    } catch (error) {
      console.error('Error creating group:', error);
      showNotification('Failed to create group. Please try again.');
    }
  };
  
  function copyGroupCode() {
    if (createdGroupData) {
      navigator.clipboard.writeText(createdGroupData.code).then(() => {
        showNotification('Group code copied to clipboard!');
      }).catch(() => {
        showNotification('Failed to copy group code');
      });
    }
  }
  
  // Make functions globally accessible
  window.removeMember = removeMember;
  window.createGroup = createGroup;
  window.copyGroupCode = copyGroupCode;
  
  // Group chat functionality
  async function openGroupChat(groupCode) {
    try {
      const res = await fetch(api(`/groups/${groupCode}`));
      if (!res.ok) throw new Error('Group not found');
      const group = await res.json();
      // Update chat header
      document.getElementById('chat-user-name').textContent = group.name;
      document.getElementById('chat-user-code').textContent = group.code;
      document.getElementById('chat-user-pic').src = group.icon || `https://api.dicebear.com/7.x/thumbs/svg?seed=${group.name}`;
      // Hide online indicator specifics for group
      const lastSeenElement = document.getElementById('chat-user-last-seen');
      const onlineIndicator = document.getElementById('online-status-indicator');
      if (lastSeenElement) lastSeenElement.textContent = 'Group chat';
      if (onlineIndicator) onlineIndicator.classList.remove('online');
      if (audioCallBtn) {
        audioCallBtn.disabled = true;
        audioCallBtn.title = 'Calls are not available in group chats yet';
      }
      if (videoCallBtn) {
        videoCallBtn.disabled = true;
        videoCallBtn.title = 'Calls are not available in group chats yet';
      }
      // Show settings button only for admins/owner
      if (groupSettingsBtn) {
        const isAdmin = (group.admins || []).includes(currentUser.code);
        groupSettingsBtn.style.display = isAdmin ? '' : 'none';
        groupSettingsBtn.onclick = async (ev) => {
          ev.stopPropagation();
          try {
            // Fetch latest group state to avoid 'group not found' and stale data
            const fresh = await fetch(api(`/groups/${groupCode}`));
            if (!fresh.ok) throw new Error('Group not found');
            const freshGroup = await fresh.json();
            openGroupSettings(freshGroup);
          } catch (e) {
            showNotification('Group not found');
          }
        };
      }
      // Show chat UI
      const chatInterface = document.getElementById('chat-interface');
      chatInterface.classList.remove('hidden');
      setModalOpen(true);
      isGroupChat = true;
      currentGroupCode = groupCode;
      currentChatCode = null;
      await loadGroupMessages(groupCode);
      setupChatSocket();
    } catch (err) {
      showNotification('Failed to open group chat');
    }
  }
  // --- Group Settings UI Logic ---
  let _groupSettingsTempPic = null;
  const _userCache = new Map();
  async function fetchUserByCode(code) {
    if (_userCache.has(code)) return _userCache.get(code);
    try {
      const res = await fetch(api(`/users/${code}`));
      if (!res.ok) throw new Error('not found');
      const user = await res.json();
      _userCache.set(code, user);
      return user;
    } catch {
      const fallback = { code, username: 'user' + code, profilePicture: '' };
      _userCache.set(code, fallback);
      return fallback;
    }
  }

  async function renderGroupMembersForSettings(group) {
    if (!groupMembersList) return;
    groupMembersList.innerHTML = '';
    const allMembers = [ ...(group.admins || []), ...(group.members || []) ];
    const uniqueMembers = Array.from(new Set(allMembers));
    if (uniqueMembers.length === 0) {
      groupMembersList.innerHTML = '<div style="color:#9ca3af;">No members</div>';
      return;
    }
    for (const code of uniqueMembers) {
      const userFromContacts = contacts.find(c => c.code === code);
      const user = userFromContacts || await fetchUserByCode(code);
      const row = document.createElement('div');
      row.style = 'display:flex;align-items:center;gap:12px;padding:10px 12px;border-bottom:1px solid #e5e7eb;';
      const isAdmin = (group.admins || []).includes(code);
      const picSrc = user.profilePicture && user.profilePicture.length > 0 ? user.profilePicture : `https://api.dicebear.com/7.x/thumbs/svg?seed=${encodeURIComponent(user.username || code)}`;
      row.innerHTML = `
        <img src="${picSrc}" alt="Profile" onerror="this.onerror=null;this.src='https://api.dicebear.com/7.x/thumbs/svg?seed=${encodeURIComponent(user.username || code)}';" style="width:36px;height:36px;border-radius:50%;object-fit:cover;background:#fff;">
        <div style="display:flex;flex-direction:column;">
          <span style="font-size:1rem;font-weight:500;">${user.username || code} ${isAdmin ? '<span style=\"color:#2563eb;\">(admin)</span>' : ''}</span>
          <span style="font-size:0.85rem;color:#6b7280;">${code}</span>
        </div>
        <button class="kick-btn" data-code="${code}" style="margin-left:auto;padding:6px 10px;background:#ff5252;border:none;border-radius:6px;color:#fff;font-size:0.85rem;cursor:pointer;box-shadow:0 0 12px rgba(255,82,82,0.5);${isAdmin ? 'display:none;' : ''}">Kick</button>
      `;
      groupMembersList.appendChild(row);
    }
    // Kick handlers
    groupMembersList.querySelectorAll('.kick-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const code = e.currentTarget.dataset.code;
        try {
          const res = await fetch(api(`/groups/${currentGroupCode}/kick`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requesterCode: currentUser.code, targetCode: code })
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Failed to kick member');
          showNotification('Member kicked');
          // Refresh displayed group data
          const fresh = await fetch(api(`/groups/${currentGroupCode}`));
          const updatedGroup = fresh.ok ? await fresh.json() : data.group;
          renderGroupMembersForSettings(updatedGroup);
          fetchContactsAndGroups();
        } catch (err) {
          showNotification(err.message || 'Failed to kick member');
        }
      });
    });
  }

  function openGroupSettings(group) {
    if (!groupSettingsModal) return;
    groupSettingsName.value = group.name || '';
    groupSettingsPic.src = group.icon || `https://api.dicebear.com/7.x/thumbs/svg?seed=${group.name}`;
    groupJoinDisabledCheckbox.checked = !!group.joinDisabled;
    renderGroupMembersForSettings(group);
    groupSettingsModal.classList.remove('hidden');
    setModalOpen(true);

    // Picture edit flow
    groupSettingsPicEdit.onclick = () => {
      groupSettingsPicEdit.style.display = 'none';
      groupSettingsPicControls.style.display = 'flex';
    };
    groupSettingsPicImport.onclick = () => groupSettingsPicInput.click();
    groupSettingsPicInput.onchange = (e) => {
      const file = e.target.files[0];
      if (!file || !file.type.startsWith('image/')) return;
      const reader = new FileReader();
      reader.onload = (evt) => {
        _groupSettingsTempPic = evt.target.result; // full data URL
        groupSettingsPic.src = _groupSettingsTempPic;
      };
      reader.readAsDataURL(file);
    };
    groupSettingsPicCancel.onclick = () => {
      _groupSettingsTempPic = null;
      groupSettingsPicInput.value = '';
      groupSettingsPicControls.style.display = 'none';
      groupSettingsPicEdit.style.display = '';
    };
    groupSettingsPicSave.onclick = async () => {
      try {
        await saveGroupSettings({ icon: _groupSettingsTempPic });
        _groupSettingsTempPic = null;
        groupSettingsPicInput.value = '';
        groupSettingsPicControls.style.display = 'none';
        groupSettingsPicEdit.style.display = '';
      } catch (err) {
        showNotification(err.message || 'Failed to save icon');
      }
    };

    // Save button (name + join toggle)
    if (saveGroupSettingsBtn) {
      saveGroupSettingsBtn.onclick = async () => {
        try {
          const updated = await saveGroupSettings({ name: groupSettingsName.value.trim(), joinDisabled: groupJoinDisabledCheckbox.checked });
          // Re-render members based on latest server state
          await renderGroupMembersForSettings(updated);
          groupSettingsModal.classList.add('hidden');
          setModalOpen(false);
        } catch (err) {
          showNotification(err.message || 'Failed to save settings');
        }
      };
    }
  }

  async function saveGroupSettings(partial) {
    const payload = { requesterCode: currentUser.code, ...partial };
    if (!currentGroupCode) throw new Error('No group selected');
    const res = await fetch(api(`/groups/${currentGroupCode}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to update group');
    showNotification('Group settings saved');
    // Update header immediately
    document.getElementById('chat-user-name').textContent = data.name;
    document.getElementById('chat-user-pic').src = data.icon || `https://api.dicebear.com/7.x/thumbs/svg?seed=${data.name}`;
    // Refresh lists
    fetchContactsAndGroups();
    return data;
  }

  if (closeGroupSettingsBtn) {
    closeGroupSettingsBtn.addEventListener('click', () => {
      groupSettingsModal.classList.add('hidden');
      setModalOpen(false);
    });
  }
  
  // Make function globally accessible
  window.openGroupChat = openGroupChat;
  
  // Remove group from user's groups list (stubbed backend call to be implemented)
  async function removeGroup(groupCode) {
    try {
      // Attempt backend removal if endpoint exists; otherwise fall back to client refresh
      const res = await fetch(api(`/users/${currentUser.code}/groups/${groupCode}`), {
        method: 'DELETE'
      });
      if (!res.ok) {
        // If endpoint not implemented yet, just notify and refresh list for now
        showNotification('Group removed locally. Backend removal pending.');
      } else {
        showNotification('Group removed!');
      }
    } catch (err) {
      // Silent fallback
      showNotification('Could not remove group right now.');
    }
    // Refresh groups and contacts list
    fetchContactsAndGroups();
  }
  
  // Expose removeGroup globally for button handlers
  window.removeGroup = removeGroup;
  
  // Set up event listeners after all functions are defined
  if (createGroupBtn) {
    createGroupBtn.addEventListener('click', openGroupCreationModal);
  }
  
  // Helper function to convert file to Base64
  async function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        const base64 = reader.result.split(',')[1]; // Remove data:image/...;base64, prefix
        resolve(base64);
      };
      reader.onerror = error => reject(error);
    });
  }

  // Initialize user and fetch data
  initUser();
  
  // Add input validation for restore code
  const restoreCodeInput = document.getElementById('restore-code-input');
  if (restoreCodeInput) {
    restoreCodeInput.addEventListener('input', (e) => {
      restoreCodeInput.value = restoreCodeInput.value.replace(/\D/g, '').slice(0, 4);
    });
    
    restoreCodeInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        document.getElementById('confirm-restore-btn').click();
      }
    });
  }
  
  // Periodically clean up old unused profiles (every 24 hours)
  setInterval(async () => {
    try {
      await fetch(api('/users/cleanup-old'), {
        method: 'DELETE'
      });
    } catch (err) {
      console.log('Could not cleanup old profiles:', err);
    }
  }, 24 * 60 * 60 * 1000); // 24 hours
}); 