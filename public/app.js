/**
 * ============================================================================
 * Two Four - Ultra-Low Power Mobile Walkie-Talkie Client
 * Optimized for Battery, Heat & Minimal CPU/GPU Usage
 * ============================================================================
 */

(() => {
    // --- LocalStorage Keys ---
    const STORAGE_KEYS = {
        USER_PIN: 'vox_user_pin',
        FRIEND_PIN: 'vox_friend_pin',
        CONN_EXPIRY: 'vox_conn_expiry',
        CONN_DURATION: 'vox_conn_duration'
    };

    const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;

    // --- State Variables ---
    let myPin = '';
    let currentRoom = '';
    let mediaRecorder = null;
    let audioStream = null;
    let audioChunks = [];
    let selectedMimeType = '';
    let isRecording = false;
    let isPlayingAudio = false;
    let recordingStartTime = 0;
    let audioContext = null;
    let analyserNode = null;
    let visualizerAnimationId = null;
    let timerIntervalId = null;

    // --- DOM Elements ---
    const connectionStatus = document.getElementById('connection-status');
    const connectionStatusText = document.getElementById('connection-status-text');
    const myPinDisplay = document.getElementById('my-pin-display');
    const copyPinBtn = document.getElementById('copy-pin-btn');
    const copyBtnText = document.getElementById('copy-btn-text');

    const friendPinInput = document.getElementById('friend-pin-input');
    const durationSelect = document.getElementById('connection-duration');
    const connectForm = document.getElementById('connect-form');

    const activeSessionBar = document.getElementById('active-session-bar');
    const sessionTimerText = document.getElementById('session-timer-text');
    const disconnectBtn = document.getElementById('disconnect-btn');

    const activeChannelDisplay = document.getElementById('active-channel-display');
    const peerCountDisplay = document.getElementById('peer-count-display');
    const statusMessage = document.getElementById('status-message');

    const pttBtn = document.getElementById('ptt-btn');
    const pttActionText = document.getElementById('ptt-action-text');

    const canvas = document.getElementById('visualizer-canvas');
    const canvasCtx = canvas ? canvas.getContext('2d') : null;

    const audioUnlockBanner = document.getElementById('audio-unlock-banner');
    const audioUnlockBtn = document.getElementById('audio-unlock-btn');

    // --- Helpers ---
    function formatPin(pin) {
        if (!pin || pin.length !== 7) return pin;
        return `${pin.slice(0, 3)} ${pin.slice(3)}`;
    }

    function formatRemainingTime(ms) {
        if (ms <= 0) return '00:00:00';
        const totalSecs = Math.floor(ms / 1000);
        const hrs = Math.floor(totalSecs / 3600);
        const mins = Math.floor((totalSecs % 3600) / 60);
        const secs = totalSecs % 60;
        return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    // --- 1. Persistent User PIN ---
    function getOrCreateUserPin() {
        let pin = localStorage.getItem(STORAGE_KEYS.USER_PIN);
        if (!pin || !/^\d{7}$/.test(pin)) {
            pin = Math.floor(1000000 + Math.random() * 9000000).toString();
            localStorage.setItem(STORAGE_KEYS.USER_PIN, pin);
            console.log('[Two Four] New persistent PIN generated:', pin);
        }
        return pin;
    }

    // --- 2. Connection Timeout Check ---
    function checkConnectionExpiry() {
        const savedFriendPin = localStorage.getItem(STORAGE_KEYS.FRIEND_PIN);
        const expiryStr = localStorage.getItem(STORAGE_KEYS.CONN_EXPIRY);

        if (savedFriendPin && expiryStr) {
            const expiryTimestamp = parseInt(expiryStr, 10);
            if (Date.now() >= expiryTimestamp) {
                console.log('[Two Four] 8-hour session expired. Returning to host PIN.');
                disconnectFromFriend(true);
                return true;
            }
        }
        return false;
    }

    function updateSessionTimerUI() {
        const savedFriendPin = localStorage.getItem(STORAGE_KEYS.FRIEND_PIN);
        if (!savedFriendPin) {
            activeSessionBar.style.display = 'none';
            return;
        }

        activeSessionBar.style.display = 'flex';

        const expiryStr = localStorage.getItem(STORAGE_KEYS.CONN_EXPIRY);
        if (expiryStr) {
            const expiryTimestamp = parseInt(expiryStr, 10);
            const remaining = expiryTimestamp - Date.now();

            if (remaining <= 0) {
                checkConnectionExpiry();
                return;
            }
            sessionTimerText.textContent = `${formatRemainingTime(remaining)}`;
        } else {
            sessionTimerText.textContent = 'Forever';
        }
    }

    function startTimerLoop() {
        if (timerIntervalId) clearInterval(timerIntervalId);
        timerIntervalId = setInterval(updateSessionTimerUI, 1000);
        updateSessionTimerUI();
    }

    // --- MIME Type Detection ---
    function detectMimeType() {
        const types = [
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/ogg;codecs=opus',
            'audio/mp4',
            'audio/aac'
        ];
        if (!window.MediaRecorder) return '';
        for (const type of types) {
            if (MediaRecorder.isTypeSupported(type)) {
                return type;
            }
        }
        return '';
    }

    function getTargetRoom() {
        checkConnectionExpiry();
        const savedFriendPin = localStorage.getItem(STORAGE_KEYS.FRIEND_PIN);
        if (savedFriendPin && /^\d{7}$/.test(savedFriendPin)) {
            return savedFriendPin;
        }
        return myPin;
    }

    function initAppState() {
        myPin = getOrCreateUserPin();
        myPinDisplay.textContent = formatPin(myPin);

        currentRoom = getTargetRoom();
        updateActiveChannelUI(currentRoom);
        startTimerLoop();
        drawIdleVisualizer();
    }

    function updateActiveChannelUI(roomPin) {
        activeChannelDisplay.textContent = `CH: ${formatPin(roomPin)}`;
        updateSessionTimerUI();
    }

    function setStatus(mode, message) {
        statusMessage.textContent = message;

        pttBtn.classList.remove('is-transmitting', 'is-receiving');

        if (mode === 'TRANSMITTING') {
            pttBtn.classList.add('is-transmitting');
            pttActionText.textContent = 'TALKING...';
            startVisualizer();
        } else if (mode === 'RECEIVING') {
            pttBtn.classList.add('is-receiving');
            pttActionText.textContent = 'RECEIVING';
            startVisualizer();
        } else {
            pttActionText.textContent = 'HOLD TO TALK';
            stopVisualizer();
        }
    }

    // --- Battery Optimization: Socket.io Pure WebSocket Transport ---
    const socket = io({
        transports: ['websocket'], // Prevent battery-draining HTTP long-polling fallback
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        timeout: 20000
    });

    socket.on('connect', () => {
        console.log('[Two Four] WebSocket connected. ID:', socket.id);
        connectionStatus.classList.add('online');
        connectionStatus.classList.remove('offline');
        connectionStatusText.textContent = 'ONLINE';

        currentRoom = getTargetRoom();
        socket.emit('join-room', { pin: currentRoom });
    });

    socket.on('reconnect', () => {
        console.log('[Two Four] WebSocket reconnected');
        currentRoom = getTargetRoom();
        socket.emit('join-room', { pin: currentRoom });
    });

    socket.on('disconnect', () => {
        connectionStatus.classList.remove('online');
        connectionStatus.classList.add('offline');
        connectionStatusText.textContent = 'OFFLINE';
        setStatus('OFFLINE', 'DISCONNECTED');
    });

    socket.on('room-joined', ({ pin, roomSize }) => {
        currentRoom = pin;
        updateActiveChannelUI(pin);
        updatePeerCount(roomSize);
        setStatus('STANDBY', 'READY');
    });

    socket.on('peer-joined', ({ roomSize }) => {
        updatePeerCount(roomSize);
        flashStatus('PEER CONNECTED');
    });

    socket.on('peer-left', ({ roomSize }) => {
        updatePeerCount(roomSize);
        flashStatus('PEER DISCONNECTED');
    });

    socket.on('peer-transmission', ({ isTransmitting }) => {
        if (isRecording) return;
        if (isTransmitting) {
            setStatus('RECEIVING', 'PEER TALKING...');
        } else {
            setStatus('STANDBY', 'READY');
        }
    });

    socket.on('receive-voice', (data) => {
        playIncomingAudio(data);
    });

    function joinRoom(pin) {
        if (!pin || pin.length !== 7) return;
        currentRoom = pin;
        socket.emit('join-room', { pin });
    }

    function updatePeerCount(count) {
        const peers = Math.max(0, count - 1);
        if (peers === 0) {
            peerCountDisplay.textContent = 'Solo';
        } else if (peers === 1) {
            peerCountDisplay.textContent = '1 Peer';
        } else {
            peerCountDisplay.textContent = `${peers} Peers`;
        }
    }

    let flashTimeout = null;
    function flashStatus(text) {
        if (isRecording) return;
        statusMessage.textContent = text;
        clearTimeout(flashTimeout);
        flashTimeout = setTimeout(() => {
            if (!isRecording) {
                statusMessage.textContent = 'READY';
            }
        }, 2500);
    }

    // --- Disconnect Friend Channel ---
    function disconnectFromFriend(isAutoExpiry = false) {
        localStorage.removeItem(STORAGE_KEYS.FRIEND_PIN);
        localStorage.removeItem(STORAGE_KEYS.CONN_EXPIRY);
        localStorage.removeItem(STORAGE_KEYS.CONN_DURATION);

        joinRoom(myPin);
        updateActiveChannelUI(myPin);

        if (isAutoExpiry) {
            flashStatus('SESSION EXPIRED (8H)');
        } else {
            flashStatus('RETURNED TO MY PIN');
        }
    }

    disconnectBtn.addEventListener('click', () => {
        disconnectFromFriend(false);
    });

    // --- Audio Auto-Playback ---
    function playIncomingAudio(data) {
        try {
            const rawAudio = data.audio;
            const mimeType = data.mimeType || 'audio/webm';

            const blob = new Blob([rawAudio], { type: mimeType });
            const audioUrl = URL.createObjectURL(blob);
            const audio = new Audio(audioUrl);

            isPlayingAudio = true;
            setStatus('RECEIVING', 'INCOMING AUDIO');

            const playPromise = audio.play();
            if (playPromise !== undefined) {
                playPromise.then(() => {
                    audioUnlockBanner.style.display = 'none';
                }).catch((err) => {
                    console.warn('[Two Four] Autoplay blocked:', err);
                    audioUnlockBanner.style.display = 'flex';
                    setStatus('STANDBY', 'TAP UNMUTE');
                });
            }

            audio.onended = () => {
                URL.revokeObjectURL(audioUrl);
                isPlayingAudio = false;
                if (!isRecording) {
                    setStatus('STANDBY', 'READY');
                }
            };

            audio.onerror = () => {
                URL.revokeObjectURL(audioUrl);
                isPlayingAudio = false;
                if (!isRecording) {
                    setStatus('STANDBY', 'AUDIO ERROR');
                }
            };
        } catch (err) {
            console.error('[Two Four] Playback error:', err);
            isPlayingAudio = false;
        }
    }

    // --- Battery & CPU Optimization: Lightweight Audio Constraints ---
    async function initAudio() {
        selectedMimeType = detectMimeType();

        try {
            // Optimized constraints: 16kHz mono audio drastically reduces CPU encoding load, RAM, and bandwidth
            audioStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    sampleRate: 16000,
                    channelCount: 1
                }
            });

            const options = selectedMimeType ? { mimeType: selectedMimeType } : undefined;
            mediaRecorder = new MediaRecorder(audioStream, options);

            mediaRecorder.ondataavailable = (event) => {
                if (event.data && event.data.size > 0) {
                    audioChunks.push(event.data);
                }
            };

            mediaRecorder.onstop = () => {
                const duration = Date.now() - recordingStartTime;
                if (audioChunks.length > 0 && duration >= 200) {
                    const finalBlob = new Blob(audioChunks, {
                        type: selectedMimeType || 'audio/webm'
                    });

                    socket.emit('voice-message', {
                        audio: finalBlob,
                        mimeType: selectedMimeType || 'audio/webm'
                    });
                }
                audioChunks = [];
            };

            setupAudioAnalyser(audioStream);

            pttBtn.disabled = false;
            setStatus('STANDBY', 'READY');
        } catch (err) {
            console.error('[Two Four] Mic access denied:', err);
            setStatus('ERROR', 'NO MIC ACCESS');
        }
    }

    function setupAudioAnalyser(stream) {
        try {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (!AudioContextClass) return;

            audioContext = new AudioContextClass({ sampleRate: 16000 });
            const source = audioContext.createMediaStreamSource(stream);
            analyserNode = audioContext.createAnalyser();
            analyserNode.fftSize = 32;
            source.connect(analyserNode);
        } catch (e) {
            console.warn('[Two Four] AudioContext init note:', e);
        }
    }

    // --- Battery & CPU Optimization: Zero-Idle Visualizer ---
    // Only runs requestAnimationFrame when transmitting or receiving; cancels completely when idle.
    function drawIdleVisualizer() {
        if (!canvas || !canvasCtx) return;
        canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
        canvasCtx.fillStyle = '#1e1833';
        const barWidth = 6;
        const gap = 4;
        const totalBars = 20;
        const startX = (canvas.width - (totalBars * (barWidth + gap))) / 2;

        for (let i = 0; i < totalBars; i++) {
            canvasCtx.fillRect(startX + i * (barWidth + gap), canvas.height - 3, barWidth, 3);
        }
    }

    function startVisualizer() {
        if (!canvas || !canvasCtx || visualizerAnimationId) return;

        const bufferLength = analyserNode ? analyserNode.frequencyBinCount : 16;
        const dataArray = new Uint8Array(bufferLength);

        function render() {
            if (!isRecording && !isPlayingAudio) {
                stopVisualizer();
                return;
            }

            visualizerAnimationId = requestAnimationFrame(render);

            const width = canvas.width;
            const height = canvas.height;
            canvasCtx.clearRect(0, 0, width, height);

            if (isRecording && analyserNode) {
                analyserNode.getByteFrequencyData(dataArray);
            } else {
                for (let i = 0; i < bufferLength; i++) {
                    dataArray[i] = 40 + Math.random() * 80;
                }
            }

            const barWidth = (width / bufferLength) * 1.5;
            let x = 0;

            for (let i = 0; i < bufferLength; i++) {
                const barHeight = Math.max(3, (dataArray[i] / 255) * height);
                canvasCtx.fillStyle = isRecording ? '#dc2626' : '#0284c7';
                canvasCtx.fillRect(x, height - barHeight, barWidth - 2, barHeight);
                x += barWidth;
            }
        }

        render();
    }

    function stopVisualizer() {
        if (visualizerAnimationId) {
            cancelAnimationFrame(visualizerAnimationId);
            visualizerAnimationId = null;
        }
        drawIdleVisualizer();
    }

    // --- Push-to-Talk Logic ---
    function startTalking(e) {
        if (e && e.cancelable) e.preventDefault();
        if (isRecording || !mediaRecorder || mediaRecorder.state === 'recording') return;

        if (audioContext && audioContext.state === 'suspended') {
            audioContext.resume();
        }

        try {
            audioChunks = [];
            recordingStartTime = Date.now();
            isRecording = true;

            mediaRecorder.start(100);

            socket.emit('transmission-status', { isTransmitting: true });
            setStatus('TRANSMITTING', 'TRANSMITTING...');
        } catch (err) {
            console.error('[Two Four] PTT start failed:', err);
            isRecording = false;
        }
    }

    function stopTalking(e) {
        if (e && e.cancelable) e.preventDefault();
        if (!isRecording) return;
        isRecording = false;

        try {
            if (mediaRecorder && mediaRecorder.state === 'recording') {
                mediaRecorder.stop();
            }

            socket.emit('transmission-status', { isTransmitting: false });
            setStatus('STANDBY', 'READY');
        } catch (err) {
            console.error('[Two Four] PTT stop failed:', err);
        }
    }

    // --- Event Listeners for PTT Button ---
    pttBtn.addEventListener('mousedown', (e) => {
        if (e.button === 0) startTalking(e);
    });

    window.addEventListener('mouseup', () => {
        if (isRecording) stopTalking();
    });

    pttBtn.addEventListener('touchstart', (e) => {
        startTalking(e);
    }, { passive: false });

    window.addEventListener('touchend', () => {
        if (isRecording) stopTalking();
    });

    window.addEventListener('touchcancel', () => {
        if (isRecording) stopTalking();
    });

    pttBtn.addEventListener('contextmenu', (e) => e.preventDefault());

    // Spacebar Desktop Shortcut
    let spacebarHeld = false;
    window.addEventListener('keydown', (e) => {
        if (e.code === 'Space' && !spacebarHeld && document.activeElement !== friendPinInput) {
            e.preventDefault();
            spacebarHeld = true;
            startTalking();
        }
    });

    window.addEventListener('keyup', (e) => {
        if (e.code === 'Space' && spacebarHeld) {
            e.preventDefault();
            spacebarHeld = false;
            stopTalking();
        }
    });

    // --- Connect to Friend Form ---
    connectForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const pin = friendPinInput.value.trim();
        const durationType = durationSelect.value;

        if (!/^\d{7}$/.test(pin)) {
            alert('Please enter a valid 7-digit PIN.');
            friendPinInput.focus();
            return;
        }

        if (pin === myPin) {
            alert('That is your own PIN.');
            return;
        }

        localStorage.setItem(STORAGE_KEYS.FRIEND_PIN, pin);
        localStorage.setItem(STORAGE_KEYS.CONN_DURATION, durationType);

        if (durationType === '8h') {
            const expiryTimestamp = Date.now() + EIGHT_HOURS_MS;
            localStorage.setItem(STORAGE_KEYS.CONN_EXPIRY, expiryTimestamp.toString());
        } else {
            localStorage.removeItem(STORAGE_KEYS.CONN_EXPIRY);
        }

        joinRoom(pin);
        updateActiveChannelUI(pin);

        friendPinInput.value = '';
        friendPinInput.blur();
    });

    // Copy PIN Button
    copyPinBtn.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(myPin);
            copyPinBtn.classList.add('copied');
            copyBtnText.textContent = 'Copied';
            setTimeout(() => {
                copyPinBtn.classList.remove('copied');
                copyBtnText.textContent = 'Copy';
            }, 2000);
        } catch (err) {
            const input = document.createElement('input');
            input.value = myPin;
            document.body.appendChild(input);
            input.select();
            document.execCommand('copy');
            document.body.removeChild(input);

            copyPinBtn.classList.add('copied');
            copyBtnText.textContent = 'Copied';
            setTimeout(() => {
                copyPinBtn.classList.remove('copied');
                copyBtnText.textContent = 'Copy';
            }, 2000);
        }
    });

    audioUnlockBtn.addEventListener('click', () => {
        if (audioContext && audioContext.state === 'suspended') {
            audioContext.resume();
        }
        audioUnlockBanner.style.display = 'none';
    });

    friendPinInput.addEventListener('input', (e) => {
        e.target.value = e.target.value.replace(/\D/g, '').slice(0, 7);
    });

    window.addEventListener('online', () => {
        if (!socket.connected) socket.connect();
    });

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            checkConnectionExpiry();
            updateSessionTimerUI();
            if (!socket.connected) socket.connect();
        }
    });

    // --- Startup ---
    initAppState();
    initAudio();
})();
