// ===================== Brick Blast Online — script.js =====================
const socket = io();

let myId = null;
let roomCode = null;
let isHost = false;
let gamePlayers = {};     // id -> {name,color,position}
let myPosition = null;
let latestState = null;   // آخرین stateUpdate از سرور
const FIELD = 800;
let BALL_R = 11, PADDLE_INSET = 26, PADDLE_THICK = 16;

// ------------------------------ ابزارهای عمومی ------------------------------
function $(sel) { return document.querySelector(sel); }
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $('#' + id).classList.add('active');
}
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}
const POWERUP_ICON = { big: '⬛', fast: '⚡', shield: '🛡️', slow: '🐌' };
const POWERUP_LABEL = { big: 'پنل بزرگ', fast: 'سرعت بالا', shield: 'سپر', slow: 'کندی توپ' };

// ================================ منوی اصلی =================================
$('#btn-create').addEventListener('click', () => {
  const name = $('#input-name').value.trim();
  if (!name) return toast('اول اسمت رو بنویس.');
  socket.emit('createRoom', { name });
});
$('#btn-join').addEventListener('click', () => {
  const name = $('#input-name').value.trim();
  const code = $('#input-code').value.trim().toUpperCase();
  if (!name) return toast('اول اسمت رو بنویس.');
  if (code.length < 4) return toast('کد اتاق رو درست وارد کن.');
  socket.emit('joinRoom', { name, code });
});

socket.on('roomCreated', ({ code, playerId }) => { myId = playerId; roomCode = code; showScreen('screen-lobby'); });
socket.on('roomJoined', ({ code, playerId }) => { myId = playerId; roomCode = code; showScreen('screen-lobby'); });
socket.on('joinError', ({ message }) => toast(message));
socket.on('kicked', () => { toast('میزبان تو رو از اتاق بیرون انداخت.'); location.reload(); });

// ================================ لابی اتاق ==================================
$('#btn-copy-code').addEventListener('click', () => {
  navigator.clipboard?.writeText(roomCode || '');
  toast('کد اتاق کپی شد.');
});
$('#btn-leave-lobby').addEventListener('click', () => { socket.emit('leaveRoom'); location.reload(); });

socket.on('lobbyUpdate', ({ code, hostId, players }) => {
  roomCode = code;
  isHost = hostId === myId;
  $('#room-code-display').textContent = code;
  $('#players-count').textContent = `(${players.length}/4)`;
  const list = $('#players-list');
  list.innerHTML = '';
  players.forEach(p => {
    const row = document.createElement('div');
    row.className = 'player-row';
    row.innerHTML = `
      <span class="player-dot" style="background:${p.color};box-shadow:0 0 8px ${p.color}"></span>
      <span class="pname">${escapeHtml(p.name)}</span>
      <span class="ppos">${posLabel(p.position)}</span>
      ${p.isHost ? '<span class="crown">👑</span>' : ''}
      ${(isHost && p.id !== myId) ? `<button class="kick-btn" data-id="${p.id}">اخراج</button>` : ''}
    `;
    list.appendChild(row);
  });
  list.querySelectorAll('.kick-btn').forEach(btn => {
    btn.addEventListener('click', () => socket.emit('kickPlayer', { targetId: btn.dataset.id }));
  });
  const startBtn = $('#btn-start');
  startBtn.classList.toggle('hidden', !isHost);
  startBtn.disabled = players.length < 2;
});

function posLabel(pos) {
  return { top: 'بالا', bottom: 'پایین', left: 'چپ', right: 'راست' }[pos] || '';
}
function escapeHtml(s) { return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

$('#btn-start').addEventListener('click', () => socket.emit('startGame'));

$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  socket.emit('chatMessage', { text });
  input.value = '';
});
socket.on('chatMessage', (msg) => {
  const log = $('#chat-log');
  const div = document.createElement('div');
  if (msg.system) {
    div.className = 'chat-msg system';
    div.textContent = msg.text;
  } else {
    div.className = 'chat-msg';
    div.innerHTML = `<span class="cname" style="color:${msg.color}">${escapeHtml(msg.name)}:</span> ${escapeHtml(msg.text)}`;
  }
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
});

// ================================= بازی =====================================
socket.on('gameStart', (payload) => {
  FIELD_SET(payload);
  gamePlayers = {};
  payload.players.forEach(p => { gamePlayers[p.id] = p; });
  myPosition = gamePlayers[myId] ? gamePlayers[myId].position : null;
  showScreen('screen-game');
  renderHudSkeleton();
  requestAnimationFrame(gameLoop);
});
function FIELD_SET(payload) {
  BALL_R = payload.ballRadius; PADDLE_INSET = payload.paddleInset; PADDLE_THICK = payload.paddleThick;
}

socket.on('stateUpdate', (state) => { latestState = state; updateHud(); });
socket.on('playerEliminated', ({ id, name, left }) => {
  const p = gamePlayers[id];
  toast(`${name} ${left ? 'اتاق رو ترک کرد' : 'حذف شد'} 💥`);
});
socket.on('shieldBlocked', ({ id }) => {
  const p = gamePlayers[id];
  if (p) toast(`سپر ${p.name} یه ضربه رو خنثی کرد! 🛡️`);
});
socket.on('powerupTaken', ({ id, type }) => {
  const p = gamePlayers[id];
  if (p) toast(`${p.name} پاور-آپ «${POWERUP_LABEL[type]}» رو گرفت!`);
});
socket.on('gameOver', ({ winner }) => {
  const title = $('#winner-title');
  title.innerHTML = winner ? `🏆 برنده: <span style="color:${winner.color}">${escapeHtml(winner.name)}</span>` : 'بازی مساوی شد!';
  showScreen('screen-gameover');
  document.exitPointerLock?.();
  pointerLocked = false;
});
$('#btn-again').addEventListener('click', () => socket.emit('returnToLobby'));
$('#btn-exit').addEventListener('click', () => { socket.emit('leaveRoom'); location.reload(); });
socket.on('backToLobby', () => showScreen('screen-lobby'));

// ---------------------------- HUD (نوار وضعیت) ------------------------------
function renderHudSkeleton() {
  const hud = $('#hud');
  hud.innerHTML = '';
  Object.values(gamePlayers).forEach(p => {
    const el = document.createElement('div');
    el.className = 'hud-item';
    el.id = 'hud-' + p.id;
    el.innerHTML = `<span class="hud-dot" style="background:${p.color}"></span>
      <span>${escapeHtml(p.name)} (${posLabel(p.position)})</span>
      <span class="hud-powerups"></span>`;
    hud.appendChild(el);
  });
}
function updateHud() {
  if (!latestState) return;
  latestState.players.forEach(ps => {
    const el = document.getElementById('hud-' + ps.id);
    if (!el) return;
    el.classList.toggle('dead', !ps.alive);
    el.querySelector('.hud-powerups').textContent = Object.keys(ps.powerups || {}).map(t => POWERUP_ICON[t]).join(' ');
  });
}

// ------------------------------- کنترل‌ها -----------------------------------
const keys = {};
let pointerLocked = false;
let myPaddleValue = FIELD / 2;
const arena = $('#arena');

window.addEventListener('keydown', (e) => {
  keys[e.key.toLowerCase()] = true;
  if (e.key === 'Control' && document.getElementById('screen-game').classList.contains('active')) {
    e.preventDefault();
    togglePointerLock();
  }
});
window.addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });

function togglePointerLock() {
  if (!pointerLocked) arena.requestPointerLock?.();
  else document.exitPointerLock?.();
}
document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === arena;
  $('#pointer-hint').classList.toggle('hidden', !pointerLocked);
});
document.addEventListener('mousemove', (e) => {
  if (!pointerLocked || !myPosition) return;
  const sensitivity = 1.4;
  const delta = (myPosition === 'left' || myPosition === 'right') ? e.movementY : e.movementX;
  myPaddleValue = clamp(myPaddleValue + delta * sensitivity, 0, FIELD);
});
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function myPowerups() {
  if (!latestState) return {};
  const ps = latestState.players.find(p => p.id === myId);
  return (ps && ps.powerups) || {};
}

function handleKeyboardMovement(dt) {
  if (!myPosition) return;
  const fast = myPowerups().fast ? 1.7 : 1;
  const step = 0.62 * dt * fast; // px per ms تقریبی
  let dir = 0;
  if (myPosition === 'top' || myPosition === 'bottom') {
    if (keys['arrowleft'] || keys['a']) dir -= 1;
    if (keys['arrowright'] || keys['d']) dir += 1;
  } else {
    if (keys['arrowup'] || keys['w']) dir -= 1;
    if (keys['arrowdown'] || keys['s']) dir += 1;
  }
  if (dir !== 0) myPaddleValue = clamp(myPaddleValue + dir * step, 0, FIELD);
}

// ------------------------------- رندر بازی ----------------------------------
const ctx = arena.getContext('2d');
let lastTs = performance.now();

function gameLoop(ts) {
  if (!document.getElementById('screen-game').classList.contains('active')) return;
  const dt = Math.min(48, ts - lastTs);
  lastTs = ts;
  handleKeyboardMovement(dt);
  socket.emit('paddleInput', { value: myPaddleValue });
  draw();
  requestAnimationFrame(gameLoop);
}

function wallGeom(position) {
  if (position === 'top') return { x1: 0, y1: PADDLE_INSET, x2: FIELD, y2: PADDLE_INSET, vertical: false, edgeY: 0 };
  if (position === 'bottom') return { x1: 0, y1: FIELD - PADDLE_INSET, x2: FIELD, y2: FIELD - PADDLE_INSET, vertical: false, edgeY: FIELD };
  if (position === 'left') return { x1: PADDLE_INSET, y1: 0, x2: PADDLE_INSET, y2: FIELD, vertical: true, edgeX: 0 };
  if (position === 'right') return { x1: FIELD - PADDLE_INSET, y1: 0, x2: FIELD - PADDLE_INSET, y2: FIELD, vertical: true, edgeX: FIELD };
}

function draw() {
  ctx.clearRect(0, 0, FIELD, FIELD);
  // زمینه
  ctx.fillStyle = '#05070c';
  ctx.fillRect(0, 0, FIELD, FIELD);
  // خطوط شطرنجی کم‌رنگ
  ctx.strokeStyle = '#131a28';
  ctx.lineWidth = 1;
  for (let i = 1; i < 8; i++) {
    ctx.beginPath(); ctx.moveTo(i * FIELD / 8, 0); ctx.lineTo(i * FIELD / 8, FIELD); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i * FIELD / 8); ctx.lineTo(FIELD, i * FIELD / 8); ctx.stroke();
  }

  const positions = ['top', 'bottom', 'left', 'right'];
  const byPos = {};
  Object.values(gamePlayers).forEach(p => { byPos[p.position] = p; });

  positions.forEach(pos => {
    const gp = byPos[pos];
    const geom = wallGeom(pos);
    const ps = latestState && latestState.players.find(p => p.id === (gp && gp.id));
    const color = gp ? gp.color : '#2a3245';
    const alive = ps ? ps.alive : false;

    // نور دیوار (فعال=روشن، حذف‌شده=کدر، بدون‌بازیکن=خاموش)
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = PADDLE_THICK;
    ctx.globalAlpha = gp ? (alive ? 0.18 : 0.35) : 0.12;
    ctx.shadowBlur = gp && alive ? 22 : 0;
    ctx.shadowColor = color;
    ctx.beginPath(); ctx.moveTo(geom.x1, geom.y1); ctx.lineTo(geom.x2, geom.y2); ctx.stroke();
    ctx.restore();

    if (gp && alive && ps) {
      // پنل بازیکن
      const half = ps.half || 58;
      ctx.save();
      ctx.fillStyle = color;
      ctx.shadowBlur = 16; ctx.shadowColor = color;
      if (!geom.vertical) {
        const cx = clamp(ps.paddleCenter, half, FIELD - half);
        roundRect(ctx, cx - half, geom.y1 - PADDLE_THICK / 2, half * 2, PADDLE_THICK, 8);
      } else {
        const cy = clamp(ps.paddleCenter, half, FIELD - half);
        roundRect(ctx, geom.x1 - PADDLE_THICK / 2, cy - half, PADDLE_THICK, half * 2, 8);
      }
      ctx.fill();
      ctx.restore();

      // اسم بازیکن
      ctx.save();
      ctx.fillStyle = color;
      ctx.font = 'bold 15px Vazirmatn, sans-serif';
      ctx.textAlign = 'center';
      if (pos === 'top') ctx.fillText(gp.name, FIELD / 2, geom.y1 + 34);
      if (pos === 'bottom') ctx.fillText(gp.name, FIELD / 2, geom.y1 - 20);
      if (pos === 'left') { ctx.save(); ctx.translate(geom.x1 + 34, FIELD / 2); ctx.rotate(Math.PI / 2); ctx.fillText(gp.name, 0, 0); ctx.restore(); }
      if (pos === 'right') { ctx.save(); ctx.translate(geom.x1 - 20, FIELD / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(gp.name, 0, 0); ctx.restore(); }
      ctx.restore();
    } else if (gp && !alive) {
      ctx.save();
      ctx.fillStyle = '#0009';
      ctx.font = '13px Vazirmatn, sans-serif';
      ctx.textAlign = 'center';
      ctx.globalAlpha = 0.7;
      ctx.restore();
    }
  });

  // پاور-آپ‌ها
  if (latestState) {
    latestState.powerups.forEach(pu => {
      ctx.save();
      const colorMap = { big: '#00d4ff', fast: '#ffd23f', shield: '#7cff5e', slow: '#c77dff' };
      ctx.fillStyle = colorMap[pu.type] || '#fff';
      ctx.shadowBlur = 18; ctx.shadowColor = ctx.fillStyle;
      ctx.beginPath(); ctx.arc(pu.x, pu.y, 20, 0, Math.PI * 2); ctx.fill();
      ctx.font = '20px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(POWERUP_ICON[pu.type] || '?', pu.x, pu.y + 1);
      ctx.restore();
    });

    // توپ‌ها
    latestState.balls.forEach(b => {
      ctx.save();
      ctx.fillStyle = '#ffffff';
      ctx.shadowBlur = 14; ctx.shadowColor = '#ffffff';
      ctx.beginPath(); ctx.arc(b.x, b.y, BALL_R, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    });
  }
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

// ============================ مینی‌گیم دایناسور ==============================
function initDinoGame(canvas, startBtn) {
  const g = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const groundY = H - 24;
  const BASE_SPEED = 4.2, MAX_SPEED = 15;
  let dino, obstacles, speed, score, alive, started, spawnTimer;

  function hardReset() {
    dino = { x: 30, y: groundY - 28, w: 24, h: 28, vy: 0, jumping: false };
    obstacles = []; speed = BASE_SPEED; score = 0; alive = true; spawnTimer = 40;
  }
  hardReset();
  started = false;

  function beginGame() {
    hardReset();
    started = true;
    startBtn.classList.add('hidden');
    startBtn.textContent = '▶ شروع بازی';
  }

  function jumpOrAct() {
    if (!started) { beginGame(); return; }
    if (!alive) { beginGame(); return; }
    if (!dino.jumping) { dino.vy = -9.5; dino.jumping = true; }
  }

  startBtn.addEventListener('click', (e) => { e.stopPropagation(); beginGame(); });
  canvas.addEventListener('click', jumpOrAct);
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && isVisible(canvas)) { e.preventDefault(); jumpOrAct(); }
  });

  function isVisible(el) { return el.offsetParent !== null; }

  // هرچی امتیاز بالاتر بره، سرعت بیشتر می‌شه و فاصله‌ی موانع کمتر می‌شه (سختی تدریجی)
  function difficultySpawnGap() {
    const level = Math.min(1, speed / MAX_SPEED); // 0..1
    const gap = 62 - level * 32; // از ۶۲ فریم تا ۳۰ فریم
    return gap + Math.random() * (25 - level * 10);
  }

  function step() {
    if (isVisible(canvas)) {
      g.clearRect(0, 0, W, H);
      g.fillStyle = '#0d1220'; g.fillRect(0, 0, W, H);
      g.strokeStyle = '#2a3245'; g.beginPath(); g.moveTo(0, groundY + 4); g.lineTo(W, groundY + 4); g.stroke();

      if (started && alive) {
        dino.vy += 0.55; dino.y += dino.vy;
        if (dino.y > groundY - dino.h) { dino.y = groundY - dino.h; dino.vy = 0; dino.jumping = false; }
        spawnTimer -= 1;
        if (spawnTimer <= 0) {
          obstacles.push({ x: W, w: 14 + Math.random() * 10, h: 22 + Math.random() * (14 + speed) });
          spawnTimer = difficultySpawnGap();
        }
        obstacles.forEach(o => o.x -= speed);
        obstacles = obstacles.filter(o => o.x > -30);
        speed = Math.min(MAX_SPEED, speed + 0.0055); // افزایش تدریجی سرعت = سخت‌تر شدن بازی
        score += 1;
        for (const o of obstacles) {
          if (dino.x < o.x + o.w && dino.x + dino.w > o.x && dino.y + dino.h > groundY - o.h) {
            alive = false;
            startBtn.textContent = '↻ دوباره بازی کن';
            startBtn.classList.remove('hidden');
          }
        }
      }

      g.fillStyle = '#00d4ff';
      g.shadowBlur = 10; g.shadowColor = '#00d4ff';
      g.fillRect(dino.x, dino.y, dino.w, dino.h);
      g.shadowBlur = 0;
      g.fillStyle = '#ff3b5c';
      obstacles.forEach(o => g.fillRect(o.x, groundY - o.h, o.w, o.h));

      g.fillStyle = '#7c879c'; g.font = '12px Vazirmatn, sans-serif'; g.textAlign = 'left';
      if (started) g.fillText('امتیاز: ' + Math.floor(score / 5), 10, 18);

      if (!started) {
        g.fillStyle = '#7c879c'; g.textAlign = 'center'; g.font = '13px Vazirmatn, sans-serif';
        g.fillText('برای شروع، دکمه رو بزن', W / 2, H - 12);
      } else if (!alive) {
        g.fillStyle = '#e8edf7'; g.textAlign = 'center'; g.font = 'bold 14px Vazirmatn, sans-serif';
        g.fillText('باختی! امتیاز: ' + Math.floor(score / 5), W / 2, H / 2);
      }
    }
    requestAnimationFrame(step);
  }
  step();
}
initDinoGame(document.getElementById('dino-canvas-menu'), document.getElementById('dino-start-menu'));
initDinoGame(document.getElementById('dino-canvas-lobby'), document.getElementById('dino-start-lobby'));
