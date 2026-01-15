const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Game Data
const categories = [
    { id: 'general', name: 'عام', words: ['مدرسة', 'جامعة', 'مطار', 'مستشفى', 'سينما', 'حديقة', 'مطعم', 'سوق', 'ملعب', 'مكتبة', 'مسجد', 'فندق'] },
    { id: 'animals', name: 'حيوانات', words: ['أسد', 'نمر', 'فيل', 'زرافة', 'قرد', 'كلب', 'قطة', 'حصان', 'جمل', 'صقر', 'نسر', 'بطريق'] },
    { id: 'food', name: 'أكل', words: ['بيتزا', 'برجر', 'شاورما', 'كبسة', 'سوشي', 'باستا', 'فلافل', 'سمك', 'ستيك', 'سلطة', 'شوربة'] },
    { id: 'objects', name: 'أشياء', words: ['قلم', 'كتاب', 'جوال', 'لابتوب', 'ساعة', 'نظارة', 'مفتاح', 'شنطة', 'كرسي', 'طاولة', 'سيارة'] },
    { id: 'tech', name: 'تقنية', words: ['ايفون', 'اندرويد', 'ويندوز', 'فيسبوك', 'تويتر', 'انستقرام', 'واتساب', 'يوتيوب', 'جوجل', 'تيك توك'] }
];

// Room State: { [roomCode]: { players: [], gameStarted: false, hostId: '', category: 'general', spiesCount: 1, secretWord: '', timer: { interval: null, seconds: 0 } } }
const rooms = {};

// Helper to generate 4-letter code
function generateRoomId() {
    return Math.random().toString(36).substring(2, 6).toUpperCase();
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // --- Lobby Events ---

    socket.on('create_room', ({ playerName }) => {
        const roomCode = generateRoomId();
        rooms[roomCode] = {
            code: roomCode,
            players: [{ id: socket.id, name: playerName, isHost: true, role: null }],
            gameStarted: false,
            hostId: socket.id,
            category: 'general',
            spiesCount: 1,
            secretWord: '',
            timerSeconds: 0,
            timerRunning: false
        };

        socket.join(roomCode);
        socket.emit('room_joined', { roomCode, isHost: true, playerId: socket.id });
        io.to(roomCode).emit('update_players', rooms[roomCode].players);
        io.to(roomCode).emit('update_settings', {
            category: rooms[roomCode].category,
            spiesCount: rooms[roomCode].spiesCount
        });
    });

    socket.on('join_room', ({ roomCode, playerName }) => {
        const room = rooms[roomCode];
        if (!room) {
            socket.emit('error_message', 'الغرفة غير موجودة');
            return;
        }
        if (room.gameStarted) {
            socket.emit('error_message', 'اللعبة بدأت بالفعل');
            return;
        }
        if (room.players.length >= 20) {
            socket.emit('error_message', 'الغرفة ممتلئة');
            return;
        }

        room.players.push({ id: socket.id, name: playerName, isHost: false, role: null });
        socket.join(roomCode);

        socket.emit('room_joined', { roomCode, isHost: false, playerId: socket.id });
        io.to(roomCode).emit('update_players', room.players);
        socket.emit('update_settings', {
            category: room.category,
            spiesCount: room.spiesCount
        });
    });

    // --- Setup Events (Host Only) ---

    socket.on('update_settings', ({ roomCode, category, spiesCount, customWords }) => {
        const room = rooms[roomCode];
        if (!room || room.hostId !== socket.id) return;

        if (category) room.category = category;
        if (spiesCount) room.spiesCount = spiesCount;
        if (customWords) room.customWords = customWords;

        io.to(roomCode).emit('update_settings', {
            category: room.category,
            spiesCount: room.spiesCount,
            hasCustomWords: room.customWords && room.customWords.length > 0
        });
    });

    socket.on('start_game', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room || room.hostId !== socket.id) return;
        if (room.players.length < 3) {
            socket.emit('error_message', 'تحتاج 3 لاعبين على الأقل');
            return;
        }

        // 1. Pick Word
        let word = '';
        if (room.category === 'custom') {
            if (!room.customWords || room.customWords.length === 0) {
                socket.emit('error_message', 'أضف كلمات مخصصة أولاً!');
                return;
            }
            word = room.customWords[Math.floor(Math.random() * room.customWords.length)];
        } else {
            const catData = categories.find(c => c.id === room.category) || categories[0];
            word = catData.words[Math.floor(Math.random() * catData.words.length)];
        }
        room.secretWord = word;
        room.votes = {}; // Reset votes

        // 2. Assign Spies
        // Reset roles
        room.players.forEach(p => p.role = 'civilian');

        if (room.spiesCount >= room.players.length) {
            room.spiesCount = Math.max(1, room.players.length - 1);
        }

        let assignedSpies = 0;
        while (assignedSpies < room.spiesCount) {
            const idx = Math.floor(Math.random() * room.players.length);
            if (room.players[idx].role !== 'spy') {
                room.players[idx].role = 'spy';
                assignedSpies++;
            }
        }

        // 3. Pick First Player
        const firstPlayerIdx = Math.floor(Math.random() * room.players.length);
        const firstPlayerName = room.players[firstPlayerIdx].name;

        // 4. Send Individual Roles
        room.gameStarted = true;
        room.players.forEach(p => {
            const secret = p.role === 'spy' ? 'أنت برا السالفة!' : word;
            io.to(p.id).emit('game_start', {
                role: p.role,
                word: secret,
                firstPlayer: firstPlayerName
            });
        });
    });

    // --- Game Phase Events ---

    socket.on('timer_action', ({ roomCode, action }) => {
        // action: 'start', 'stop', 'reset'
        const room = rooms[roomCode];
        if (!room) return;

        io.to(roomCode).emit('timer_update', { action, value: room.timerSeconds });
    });

    socket.on('start_voting', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room || room.hostId !== socket.id) return;

        room.votes = {};
        io.to(roomCode).emit('voting_phase', { players: room.players.map(p => ({ id: p.id, name: p.name })) });
    });

    socket.on('submit_vote', ({ roomCode, suspectId }) => {
        const room = rooms[roomCode];
        if (!room) return;

        // Record vote: VoterID -> SuspectID
        room.votes[socket.id] = suspectId;

        // Check if everyone voted
        const votersCount = Object.keys(room.votes).length;
        // Host can still force end, but let's notify progress
        io.to(roomCode).emit('vote_update', { count: votersCount, total: room.players.length });

        if (votersCount === room.players.length) {
            // Auto reveal if everyone voted
            finishGame(roomCode);
        }
    });

    socket.on('force_reveal', ({ roomCode }) => {
        finishGame(roomCode);
    });

    function finishGame(roomCode) {
        const room = rooms[roomCode];
        if (!room) return;

        // Calculate Votes
        const voteCounts = {};
        Object.values(room.votes).forEach(suspectId => {
            voteCounts[suspectId] = (voteCounts[suspectId] || 0) + 1;
        });

        // Find suspect with most votes
        let maxVotes = 0;
        let topSuspectId = null;
        for (const [id, count] of Object.entries(voteCounts)) {
            if (count > maxVotes) {
                maxVotes = count;
                topSuspectId = id;
            }
        }

        // Determine Winner
        const spies = room.players.filter(p => p.role === 'spy');
        const spyIds = spies.map(p => p.id);
        const spyNames = spies.map(p => p.name);

        let winner = 'spy'; // Default if wrong vote or tie (benefit of doubt to spy)
        let caughtSpy = false;

        // If top suspect is a spy, Civilians win
        if (topSuspectId && spyIds.includes(topSuspectId)) {
            winner = 'civilians';
            caughtSpy = true;
        }

        io.to(roomCode).emit('game_over', {
            secretWord: room.secretWord,
            spies: spyNames,
            winner: winner,
            votes: voteCounts,
            players: room.players.map(p => ({ id: p.id, name: p.name })) // to map IDs back to names
        });

        room.gameStarted = false;
    }

    socket.on('reset_lobby', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room || room.hostId !== socket.id) return;
        io.to(roomCode).emit('return_to_lobby');
    });

    // --- Disconnect ---
    socket.on('disconnect', () => {
        // Find room user was in
        for (const code in rooms) {
            const room = rooms[code];
            const pIndex = room.players.findIndex(p => p.id === socket.id);
            if (pIndex !== -1) {
                const wasHost = room.players[pIndex].isHost;
                room.players.splice(pIndex, 1);

                if (room.players.length === 0) {
                    delete rooms[code];
                } else {
                    if (wasHost) {
                        room.players[0].isHost = true;
                        room.hostId = room.players[0].id;
                        io.to(room.players[0].id).emit('you_are_host');
                    }
                    io.to(code).emit('update_players', room.players);
                }
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
