const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    },
    maxHttpBufferSize: 1e7 // 10MB max audio payload buffer
});

// Serve static frontend assets from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Helper to count sockets in a room
function getRoomUserCount(roomPin) {
    const room = io.sockets.adapter.rooms.get(roomPin);
    return room ? room.size : 0;
}

io.on('connection', (socket) => {
    console.log(`[Socket Connected] ID: ${socket.id}`);

    // Track user's active room on the socket session
    socket.data.currentRoom = null;

    /**
     * Join Room Event:
     * User leaves their previous room (if any) and joins the target 7-digit PIN room.
     */
    socket.on('join-room', ({ pin }) => {
        if (!pin || typeof pin !== 'string') return;
        const normalizedPin = pin.trim();

        const previousRoom = socket.data.currentRoom;

        // Leave previous room if different
        if (previousRoom && previousRoom !== normalizedPin) {
            socket.leave(previousRoom);
            console.log(`[Room Leave] ${socket.id} left room ${previousRoom}`);

            // Notify remaining members in the old room
            io.to(previousRoom).emit('peer-left', {
                peerId: socket.id,
                roomSize: getRoomUserCount(previousRoom)
            });
        }

        // Join the new room
        socket.join(normalizedPin);
        socket.data.currentRoom = normalizedPin;
        console.log(`[Room Join] ${socket.id} joined room ${normalizedPin}`);

        const currentCount = getRoomUserCount(normalizedPin);

        // Acknowledge to the user
        socket.emit('room-joined', {
            pin: normalizedPin,
            roomSize: currentCount
        });

        // Notify other members in the new room
        socket.to(normalizedPin).emit('peer-joined', {
            peerId: socket.id,
            roomSize: currentCount
        });
    });

    /**
     * Real-time Transmission Status Event:
     * Broadcasts when a user starts or stops holding down the PTT button
     */
    socket.on('transmission-status', ({ isTransmitting }) => {
        const room = socket.data.currentRoom;
        if (!room) return;

        socket.to(room).emit('peer-transmission', {
            peerId: socket.id,
            isTransmitting: Boolean(isTransmitting)
        });
    });

    /**
     * Voice Message Event:
     * Broadcasts the recorded audio Blob/Buffer to peers in the current room only.
     */
    socket.on('voice-message', (data) => {
        const room = socket.data.currentRoom;
        if (!room) {
            console.warn(`[Voice Warning] Socket ${socket.id} attempted to send voice without a room.`);
            return;
        }

        console.log(`[Voice Broadcast] Forwarding audio from ${socket.id} to room ${room}`);

        // Broadcast audio only to others in the same room
        socket.to(room).emit('receive-voice', {
            audio: data.audio || data,
            mimeType: data.mimeType || 'audio/webm',
            senderId: socket.id,
            timestamp: Date.now()
        });
    });

    /**
     * Disconnection cleanup
     */
    socket.on('disconnecting', () => {
        const room = socket.data.currentRoom;
        if (room) {
            // Count will decrease by 1 after socket finishes disconnecting
            const remaining = Math.max(0, getRoomUserCount(room) - 1);
            socket.to(room).emit('peer-left', {
                peerId: socket.id,
                roomSize: remaining
            });
        }
    });

    socket.on('disconnect', () => {
        console.log(`[Socket Disconnected] ID: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`===========================================`);
    console.log(`  Walkie-Talkie Server running on port ${PORT}`);
    console.log(`  Local URL: http://localhost:${PORT}`);
    console.log(`===========================================`);
});
