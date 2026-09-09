// ===================== Brick Blast Online — server.js =====================
// سرور بازی چندنفره «Brick Blast» (پونگ چهارجهته) با اتاق، چت، پاور-آپ و فیزیک توپ
// ساخته‌شده با Express + Socket.io — تمام فیزیک و منطق بازی روی سرور اجرا می‌شود.
// =============================================================================

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ----------------------------- تنظیمات بازی --------------------------------
const FIELD = 800;              // ابعاد منطقی زمین بازی (مربع)
const BALL_R = 11;              // شعاع توپ
const PADDLE_INSET = 26;        // فاصله پنل از لبه‌ی دیوار
const PADDLE_THICK = 16;        // ضخامت پنل
const BASE_HALF = 58;           // نصف طول پیش‌فرض پنل
const BIG_HALF = 100;           // نصف طول پنل با پاور-آپ "بزرگ"
const BASE_SPEED = 6.2;         // سرعت اولیه‌ی هر توپ
const MAX_SPEED = 13.5;         // سقف سرعت توپ
const TICK_MS = 1000 / 60;      // نرخ به‌روزرسانی فیزیک
const BALL_ADD_INTERVAL = 30000;// هر ۳۰ ثانیه یک توپ اضافه می‌شود
const MAX_BALLS = 6;            // سقف تعداد توپ‌های همزمان
const POWERUP_INTERVAL = 9000;  // فاصله‌ی تلاش برای اسپاون پاور-آپ
const POWERUP_LIFETIME = 11000; // مدت باقی‌ماندن پاور-آپ روی زمین
const POWERUP_DURATION = 15000; // مدت اثر پاور-آپ بعد از گرفتن (۱۵ ثانیه طبق درخواست)
const MAX_ROOM_PLAYERS = 4;

const POSITION_ORDER = ['bottom', 'top', 'left', 'right'];
const COLOR_POOL = ['#00d4ff', '#ff3b5c', '#ffd23f', '#7cff5e', '#c77dff', '#ff8c42'];
const POWERUP_TYPES = ['big', 'fast', 'shield', 'slow'];

const rooms = new Map(); // code -> room

// ------------------------------- کمک‌تابع‌ها --------------------------------
function randCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function shuffledColors() {
  const arr = [...COLOR_POOL];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function isVertical(position) { return position === 'left' || position === 'right'; }

function wallDirSign(position) {
  // جهتی که توپ باید بعد از برخورد با پنل/دیوار به سمت داخل زمین حرکت کند
  if (position === 'top') return 1;
  if (position === 'bottom') return -1;
  if (position === 'left') return 1;
  if (position === 'right') return -1;
}

function wallCoord(position) {
  if (position === 'top' || position === 'left') return 0;
  return FIELD;
}

function paddleFixedCoord(position) {
  if (position === 'top' || position === 'left') return PADDLE_INSET;
  return FIELD - PADDLE_INSET;
}

function makeRoom(hostSocketId, hostName) {
  const code = randCode();
  const room = {
    code,
    hostId: hostSocketId,
    state: 'lobby', // lobby | playing | ended
    players: new Map(), // socketId -> player
    colors: shuffledColors(),
    chat: [],
    balls: [],
    powerups: [],
    nextBallAt: 0,
    nextPowerupAt: 0,
    loop: null,
  };
  rooms.set(code, room);
  addPlayer(room, hostSocketId, hostName, true);
  return room;
}

function addPlayer(room, socketId, name, isHost) {
  const usedPositions = new Set([...room.players.values()].map(p => p.position));
  const position = POSITION_ORDER.find(p => !usedPositions.has(p));
  const usedColors = new Set([...room.players.values()].map(p => p.color));
  const color = room.colors.find(c => !usedColors.has(c)) || '#ffffff';

  const player = {
    id: socketId,
    name: (name || 'بازیکن').slice(0, 14),
    color,
    position,
    isHost: !!isHost,
    alive: true,
    connected: true,
    half: BASE_HALF,
    paddleCenter: FIELD / 2,
    powerups: {}, // type -> expireTimestamp
    score: 0,
  };
  room.players.set(socketId, player);
  return player;
}

function publicPlayers(room) {
  return [...room.players.values()].map(p => ({
    id: p.id, name: p.name, color: p.color, position: p.position,
    isHost: p.isHost, alive: p.alive, connected: p.connected,
  }));
}

function broadcastLobby(room) {
  io.to(room.code).emit('lobbyUpdate', {
    code: room.code,
    hostId: room.hostId,
    players: publicPlayers(room),
  });
}

function spawnBall(room, atCenterBias = true) {
  const angle = Math.random() * Math.PI * 2;
  room.balls.push({
    id: 'b' + Math.random().toString(36).slice(2, 9),
    x: FIELD / 2 + (Math.random() - 0.5) * 40,
    y: FIELD / 2 + (Math.random() - 0.5) * 40,
    vx: Math.cos(angle) * BASE_SPEED,
    vy: Math.sin(angle) * BASE_SPEED,
    speed: BASE_SPEED,
    lastHitBy: null,
  });
}

function alivePlayers(room) {
  return [...room.players.values()].filter(p => p.alive && p.connected);
}

function activePlayerAt(room, position) {
  const p = [...room.players.values()].find(pl => pl.position === position);
  return p && p.alive ? p : null;
}

function playerHasPowerup(player, type) {
  return player.powerups[type] && player.powerups[type] > Date.now();
}

function currentHalf(player) {
  return playerHasPowerup(player, 'big') ? BIG_HALF : BASE_HALF;
}

function globalSlowFactor(room) {
  const anySlow = [...room.players.values()].some(p => p.alive && playerHasPowerup(p, 'slow'));
  return anySlow ? 0.55 : 1;
}

function eliminatePlayer(room, player) {
  if (playerHasPowerup(player, 'shield')) {
    delete player.powerups.shield; // سپر مصرف می‌شود ولی بازیکن زنده می‌ماند
    io.to(room.code).emit('shieldBlocked', { id: player.id });
    return false;
  }
  player.alive = false;
  io.to(room.code).emit('playerEliminated', { id: player.id, name: player.name });
  checkWinCondition(room);
  return true;
}

function checkWinCondition(room) {
  const alive = alivePlayers(room);
  if (room.state === 'playing' && alive.length <= 1) {
    room.state = 'ended';
    stopLoop(room);
    io.to(room.code).emit('gameOver', {
      winner: alive[0] ? { id: alive[0].id, name: alive[0].name, color: alive[0].color } : null,
    });
  }
}

function bounceOffPaddle(ball, position, paddleCenter, half) {
  const dirSign = wallDirSign(position);
  const speed = Math.min(MAX_SPEED, ball.speed * 1.035);
  const maxAngle = Math.PI / 3.1; // ~58 درجه حداکثر زاویه‌ی برخورد
  ball.speed = speed;
  if (isVertical(position)) {
    const offset = clamp((ball.y - paddleCenter) / half, -1, 1);
    const angle = offset * maxAngle;
    ball.vy = Math.sin(angle) * speed;
    ball.vx = dirSign * Math.cos(angle) * speed;
  } else {
    const offset = clamp((ball.x - paddleCenter) / half, -1, 1);
    const angle = offset * maxAngle;
    ball.vx = Math.sin(angle) * speed;
    ball.vy = dirSign * Math.cos(angle) * speed;
  }
}

function bounceSolidWall(ball, position) {
  if (isVertical(position)) ball.vx = -ball.vx;
  else ball.vy = -ball.vy;
}

function stepBall(room, ball, dt) {
  const slow = globalSlowFactor(room);
  ball.x += ball.vx * dt * slow;
  ball.y += ball.vy * dt * slow;

  for (const position of POSITION_ORDER) {
    const vertical = isVertical(position);
    const coord = wallCoord(position);
    const isNear = vertical
      ? (position === 'left' ? ball.x - BALL_R <= coord : ball.x + BALL_R >= coord)
      : (position === 'top' ? ball.y - BALL_R <= coord : ball.y + BALL_R >= coord);
    if (!isNear) continue;

    const owner = activePlayerAt(room, position);
    if (owner) {
      const half = currentHalf(owner);
      const paddleCenter = clamp(owner.paddleCenter, half, FIELD - half);
      owner.half = half;
      owner.paddleCenter = paddleCenter;
      const ballAxisPos = vertical ? ball.y : ball.x;
      const withinPaddle = ballAxisPos >= paddleCenter - half && ballAxisPos <= paddleCenter + half;
      if (withinPaddle) {
        bounceOffPaddle(ball, position, paddleCenter, half);
        ball.lastHitBy = owner.id;
        // خارج کردن توپ از داخل پنل برای جلوگیری از گیر کردن
        const fixed = paddleFixedCoord(position) + (wallDirSign(position) * (BALL_R + 2));
        if (vertical) ball.x = fixed; else ball.y = fixed;
      } else {
        const survived = eliminatePlayer(room, owner) === false;
        bounceSolidWall(ball, position);
        if (vertical) ball.x = clamp(ball.x, BALL_R, FIELD - BALL_R);
        else ball.y = clamp(ball.y, BALL_R, FIELD - BALL_R);
      }
    } else {
      bounceSolidWall(ball, position);
      if (vertical) ball.x = clamp(ball.x, BALL_R, FIELD - BALL_R);
      else ball.y = clamp(ball.y, BALL_R, FIELD - BALL_R);
    }
  }
}

function randomPowerupSpot() {
  const margin = 180;
  return {
    x: margin + Math.random() * (FIELD - margin * 2),
    y: margin + Math.random() * (FIELD - margin * 2),
  };
}

function tick(room) {
  const now = Date.now();
  for (const ball of room.balls) stepBall(room, ball, 1);

  // برخورد توپ با پاور-آپ‌های روی زمین
  room.powerups = room.powerups.filter(pu => {
    if (now > pu.expiresAt) return false;
    for (const ball of room.balls) {
      const dx = ball.x - pu.x, dy = ball.y - pu.y;
      if (Math.hypot(dx, dy) <= BALL_R + 20 && ball.lastHitBy) {
        const owner = room.players.get(ball.lastHitBy);
        if (owner && owner.alive) {
          owner.powerups[pu.type] = now + POWERUP_DURATION;
          io.to(room.code).emit('powerupTaken', { id: owner.id, type: pu.type });
        }
        return false; // مصرف شد
      }
    }
    return true;
  });

  if (now >= room.nextPowerupAt && room.powerups.length < 2) {
    const spot = randomPowerupSpot();
    room.powerups.push({
      id: 'p' + Math.random().toString(36).slice(2, 8),
      type: POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)],
      x: spot.x, y: spot.y,
      expiresAt: now + POWERUP_LIFETIME,
    });
    room.nextPowerupAt = now + POWERUP_INTERVAL;
  }

  if (now >= room.nextBallAt && room.balls.length < MAX_BALLS) {
    spawnBall(room);
    room.nextBallAt = now + BALL_ADD_INTERVAL;
  }

  io.to(room.code).emit('stateUpdate', {
    balls: room.balls.map(b => ({ x: b.x, y: b.y })),
    powerups: room.powerups.map(p => ({ id: p.id, type: p.type, x: p.x, y: p.y })),
    players: [...room.players.values()].map(p => ({
      id: p.id, paddleCenter: p.paddleCenter, half: p.half, alive: p.alive,
      powerups: Object.fromEntries(Object.entries(p.powerups).filter(([, t]) => t > now)),
    })),
  });
}

function startLoop(room) {
  stopLoop(room);
  room.loop = setInterval(() => tick(room), TICK_MS);
}
function stopLoop(room) {
  if (room.loop) { clearInterval(room.loop); room.loop = null; }
}

function removeRoomIfEmpty(room) {
  const connected = [...room.players.values()].some(p => p.connected);
  if (!connected) {
    stopLoop(room);
    rooms.delete(room.code);
  }
}

// --------------------------------- سوکت‌ها ----------------------------------
io.on('connection', (socket) => {
  socket.on('createRoom', ({ name }) => {
    const room = makeRoom(socket.id, name);
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.emit('roomCreated', { code: room.code, playerId: socket.id });
    broadcastLobby(room);
  });

  socket.on('joinRoom', ({ name, code }) => {
    const room = rooms.get((code || '').toUpperCase().trim());
    if (!room) return socket.emit('joinError', { message: 'اتاقی با این کد پیدا نشد.' });
    if (room.state !== 'lobby') return socket.emit('joinError', { message: 'بازی این اتاق قبلاً شروع شده.' });
    if (room.players.size >= MAX_ROOM_PLAYERS) return socket.emit('joinError', { message: 'اتاق پره (حداکثر ۴ نفر).' });

    addPlayer(room, socket.id, name, false);
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.emit('roomJoined', { code: room.code, playerId: socket.id });
    broadcastLobby(room);
    io.to(room.code).emit('chatMessage', { system: true, text: `${name} وارد اتاق شد.` });
  });

  socket.on('kickPlayer', ({ targetId }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id || targetId === socket.id) return;
    const target = room.players.get(targetId);
    if (!target) return;
    room.players.delete(targetId);
    io.to(targetId).emit('kicked');
    io.sockets.sockets.get(targetId)?.leave(room.code);
    broadcastLobby(room);
  });

  socket.on('chatMessage', ({ text }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !text) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    const clean = String(text).slice(0, 200);
    io.to(room.code).emit('chatMessage', { name: player.name, color: player.color, text: clean });
  });

  socket.on('startGame', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;
    if (room.players.size < 2) return socket.emit('joinError', { message: 'حداقل ۲ بازیکن لازم است.' });

    room.state = 'playing';
    room.balls = [];
    room.powerups = [];
    for (const p of room.players.values()) {
      p.alive = true; p.paddleCenter = FIELD / 2; p.half = BASE_HALF; p.powerups = {};
    }
    spawnBall(room);
    room.nextBallAt = Date.now() + BALL_ADD_INTERVAL;
    room.nextPowerupAt = Date.now() + 4000;

    io.to(room.code).emit('gameStart', {
      field: FIELD, ballRadius: BALL_R, paddleInset: PADDLE_INSET, paddleThick: PADDLE_THICK,
      players: [...room.players.values()].map(p => ({
        id: p.id, name: p.name, color: p.color, position: p.position,
      })),
    });
    startLoop(room);
  });

  socket.on('paddleInput', ({ value }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.state !== 'playing') return;
    const player = room.players.get(socket.id);
    if (!player || !player.alive) return;
    if (typeof value !== 'number' || Number.isNaN(value)) return;
    player.paddleCenter = clamp(value, 0, FIELD);
  });

  socket.on('returnToLobby', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id || room.state !== 'ended') return;
    room.state = 'lobby';
    room.balls = [];
    room.powerups = [];
    for (const p of room.players.values()) { p.alive = true; p.powerups = {}; }
    io.to(room.code).emit('backToLobby');
    broadcastLobby(room);
  });

  socket.on('leaveRoom', () => handleLeave(socket));
  socket.on('disconnect', () => handleLeave(socket));

  function handleLeave(sock) {
    const room = rooms.get(sock.data.roomCode);
    if (!room) return;
    const player = room.players.get(sock.id);
    if (!player) return;

    if (room.state === 'playing' && player.alive) {
      player.alive = false;
      player.connected = false;
      io.to(room.code).emit('playerEliminated', { id: player.id, name: player.name, left: true });
      checkWinCondition(room);
    } else {
      room.players.delete(sock.id);
    }

    if (room.hostId === sock.id) {
      const next = [...room.players.values()].find(p => p.connected !== false);
      if (next) { room.hostId = next.id; next.isHost = true; }
    }
    if (room.state === 'lobby') broadcastLobby(room);
    else io.to(room.code).emit('lobbyUpdate', { code: room.code, hostId: room.hostId, players: publicPlayers(room) });

    removeRoomIfEmpty(room);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Brick Blast Online running on http://localhost:${PORT}`));
