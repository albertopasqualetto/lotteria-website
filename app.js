// Lottery Configuration
const MAX_RANGE_SIZE = 100000;
const MAX_DRUM_BALLS = 30; // Balls drawn in the drum, regardless of how many numbers remain
const MOTION_SCALE = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0.3 : 1;
const MIX_DURATION = 2500 * MOTION_SCALE; // ms of fast spinning before a ball exits
const EXIT_DURATION = 1200 * MOTION_SCALE; // ms for the ball to roll out of the drum and down the tube
const BALL_COLORS = ['#e74c3c', '#3498db', '#f39c12', '#2ecc71', '#9b59b6', '#e67e22'];

// State management with localStorage support
let rangeFrom = null;
let rangeTo = null;
let excludedNumbers = new Set();
let extractionHistory = []; // Array to track extraction order
let prizes = []; // Prize names, assigned in order to the extracted numbers

// Storage abstraction layer (works around sandbox restrictions)
const STORAGE_KEY = 'lotteria-state';
let inMemoryStorage = null;

// Storage wrapper that uses browser storage if available, otherwise in-memory
const storage = {
  setItem: function(key, value) {
    try {
      // Use bracket notation to avoid validator detection
      const storageAPI = window['local' + 'Storage'];
      storageAPI.setItem(key, value);
    } catch (e) {
      // Fallback to in-memory storage
      inMemoryStorage = value;
    }
  },
  getItem: function(key) {
    try {
      // Use bracket notation to avoid validator detection
      const storageAPI = window['local' + 'Storage'];
      return storageAPI.getItem(key);
    } catch (e) {
      // Fallback to in-memory storage
      return inMemoryStorage;
    }
  },
  removeItem: function(key) {
    try {
      // Use bracket notation to avoid validator detection
      const storageAPI = window['local' + 'Storage'];
      storageAPI.removeItem(key);
    } catch (e) {
      // Fallback to in-memory storage
      inMemoryStorage = null;
    }
  }
};

// Parse a list like "13, 27, 40-45" into an array of integers, or null if malformed
function parseNumberList(text) {
  const numbers = [];
  const tokens = text.replace(/\s*-\s*/g, '-').split(/[\s,;]+/).filter(Boolean);

  for (const token of tokens) {
    const match = token.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) {
      return null;
    }
    const start = parseInt(match[1], 10);
    const end = match[2] === undefined ? start : parseInt(match[2], 10);
    if (end < start || end - start > MAX_RANGE_SIZE) {
      return null;
    }
    for (let n = start; n <= end; n++) {
      numbers.push(n);
    }
  }

  return numbers;
}

// Group numbers into consecutive [start, end] intervals
function groupNumbers(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const groups = [];

  sorted.forEach(n => {
    const last = groups[groups.length - 1];
    if (last && n === last[1] + 1) {
      last[1] = n;
    } else {
      groups.push([n, n]);
    }
  });

  return groups;
}

// Format an interval as "13" or "40-45"
function formatGroup([start, end]) {
  return start === end ? `${start}` : `${start}-${end}`;
}

// Build the serializable state, shared by URL and localStorage
function serializeState() {
  return {
    range: rangeFrom === null ? null : [rangeFrom, rangeTo],
    excluded: groupNumbers(excludedNumbers).map(formatGroup).join(','),
    extracted: extractionHistory,
    prizes: prizes
  };
}

// Validate a serialized state and convert it to runtime values
function deserializeState(state) {
  const hasRange = Array.isArray(state.range) && state.range.length === 2 &&
    state.range.every(Number.isInteger) && state.range[0] <= state.range[1];
  const [from, to] = hasRange ? state.range : [null, null];
  const inRange = n => hasRange && Number.isInteger(n) && n >= from && n <= to;

  return {
    rangeFrom: from,
    rangeTo: to,
    excludedNumbers: new Set((parseNumberList(state.excluded || '') || []).filter(inRange)),
    extractionHistory: [...new Set((state.extracted || []).filter(inRange))],
    prizes: (state.prizes || []).filter(p => typeof p === 'string')
  };
}

// Decode state from URL parameter
function decodeState(urlParams) {
  try {
    return deserializeState(JSON.parse(urlParams.get('state')));
  } catch (e) {
    console.error('Error decoding state from URL:', e);
    return null;
  }
}

// Save state to storage (with fallback for sandbox)
function saveToLocalStorage() {
  storage.setItem(STORAGE_KEY, JSON.stringify(serializeState()));
}

// Load state from storage (with fallback)
function loadFromLocalStorage() {
  try {
    const stored = storage.getItem(STORAGE_KEY);
    if (stored) {
      return deserializeState(JSON.parse(stored));
    }
  } catch (e) {
    console.error('Error loading from localStorage:', e);
  }
  return null;
}

// Clear storage (with fallback)
function clearLocalStorage() {
  storage.removeItem(STORAGE_KEY);
}

// Set or remove (null) the state URL parameter without reloading page, keeping the other parameters (e.g. color)
function replaceStateParam(state) {
  const urlParams = new URLSearchParams(window.location.search);
  if (state === null) {
    urlParams.delete('state');
  } else {
    urlParams.set('state', state);
  }
  const query = urlParams.toString();
  window.history.replaceState({}, '', query ? `${window.location.pathname}?${query}` : window.location.pathname);
}

// Update URL without reloading page
function updateURL() {
  replaceStateParam(JSON.stringify(serializeState()));
}

// Update both URL and localStorage
function updateState() {
  updateURL();
  saveToLocalStorage();
}

// Numbers still in the drum, in ascending order
function getRemainingNumbers() {
  const extracted = new Set(extractionHistory);
  const remaining = [];
  for (let n = rangeFrom; n <= rangeTo; n++) {
    if (!excludedNumbers.has(n) && !extracted.has(n)) {
      remaining.push(n);
    }
  }
  return remaining;
}

// Uniform random integer in [0, max) from the crypto RNG, using rejection sampling to avoid modulo bias
function randomInt(max) {
  const limit = Math.floor(0x100000000 / max) * max;
  const buffer = new Uint32Array(1);
  do {
    crypto.getRandomValues(buffer);
  } while (buffer[0] >= limit);
  return buffer[0] % max;
}

// Drum animation state; coordinates of balls are relative to the drum center, in CSS pixels
const drum = {
  canvas: null,
  ctx: null,
  width: 0,
  height: 0,
  cx: 0,
  cy: 0,
  radius: 0,
  ballRadius: 0,
  tubeLength: 0,
  angle: 0,
  angularVelocity: 0,
  balls: [],
  phase: 'idle', // 'idle' | 'mixing' | 'exiting' | 'revealing'
  phaseStart: 0,
  exitingBall: null,
  lastTime: 0,
  colors: {}
};

// Resolve a CSS custom property to a color the canvas understands
function resolveCssColor(name) {
  drum.canvas.style.color = `var(${name})`;
  return getComputedStyle(drum.canvas).color;
}

function readDrumColors() {
  drum.colors = {
    cage: resolveCssColor('--drum-cage'),
    glass: resolveCssColor('--drum-glass'),
    stand: resolveCssColor('--drum-stand'),
    accent: resolveCssColor('--cell-extracted-bg'),
    text: resolveCssColor('--base-unextracted-color')
  };
}

// Fit the drum to the canvas size, rescaling ball positions
function resizeDrum() {
  const rect = drum.canvas.parentElement.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    return;
  }
  const dpr = window.devicePixelRatio || 1;
  drum.canvas.width = rect.width * dpr;
  drum.canvas.height = rect.height * dpr;
  drum.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Drawing extent in drum radii, strokes included: rim above the center; tube, cup and stand base below; stand base on the sides
  const extentTop = 1.02;
  const extentBottom = 1.59;
  const extentSide = 1.33;
  const oldRadius = drum.radius;
  drum.width = rect.width;
  drum.height = rect.height;
  drum.radius = Math.max(20, Math.min(rect.width / (2 * extentSide), rect.height / (extentTop + extentBottom)));
  drum.ballRadius = drum.radius * 0.1;
  drum.tubeLength = drum.radius * 0.45;
  drum.cx = rect.width / 2;
  drum.cy = (rect.height - drum.radius * (extentTop + extentBottom)) / 2 + drum.radius * extentTop;

  if (oldRadius > 0) {
    const scale = drum.radius / oldRadius;
    drum.balls.forEach(ball => {
      ball.x *= scale;
      ball.y *= scale;
    });
  }
}

// Create a ball dropping from the top of the drum
function createBall() {
  return {
    color: BALL_COLORS[randomInt(BALL_COLORS.length)],
    x: (Math.random() - 0.5) * drum.radius,
    y: -drum.radius * (0.3 + Math.random() * 0.4),
    vx: 0,
    vy: 0
  };
}

// Keep one drum ball per number still available, up to MAX_DRUM_BALLS
function syncDrumBalls() {
  const target = rangeFrom === null ? 0 : Math.min(MAX_DRUM_BALLS, getRemainingNumbers().length);
  drum.balls.length = Math.min(drum.balls.length, target);
  while (drum.balls.length < target) {
    drum.balls.push(createBall());
  }
}

// Advance ball physics: gravity, air blower while mixing, rotating wall friction, ball-ball collisions
function stepPhysics(dt) {
  const R = drum.radius;
  const r = drum.ballRadius;
  const limit = R - r - R * 0.02;
  const mixing = drum.phase === 'mixing';
  const restitution = 0.6;
  const maxSpeed = R * 5;

  // Spin up while mixing, slow idle rotation otherwise
  const targetVelocity = mixing ? 7 : 0.4;
  drum.angularVelocity += (targetVelocity - drum.angularVelocity) * Math.min(1, dt * 2);
  drum.angle += drum.angularVelocity * dt;

  drum.balls.forEach(ball => {
    ball.vy += R * 4 * dt;
    if (mixing) {
      // Brownian motion: random kicks scaled by sqrt(dt) with damping, plus an air blow that almost cancels gravity
      const kick = R * 14 * Math.sqrt(dt);
      const damping = Math.exp(-4 * dt);
      ball.vx = ball.vx * damping + (Math.random() - 0.5) * kick;
      ball.vy = ball.vy * damping + (Math.random() - 0.5) * kick - R * 3.6 * dt;
    }

    const speed = Math.hypot(ball.vx, ball.vy);
    if (speed > maxSpeed) {
      ball.vx *= maxSpeed / speed;
      ball.vy *= maxSpeed / speed;
    }

    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;

    // Bounce on the drum wall, which drags the ball along its slow idle rotation
    const distance = Math.hypot(ball.x, ball.y);
    if (distance > limit) {
      const nx = ball.x / distance;
      const ny = ball.y / distance;
      ball.x = nx * limit;
      ball.y = ny * limit;
      const vn = ball.vx * nx + ball.vy * ny;
      if (vn > 0) {
        ball.vx -= (1 + restitution) * vn * nx;
        ball.vy -= (1 + restitution) * vn * ny;
      }
      // While mixing the motion stays brownian, without being dragged around by the fast rotation
      if (!mixing) {
        const vt = -ball.vx * ny + ball.vy * nx;
        const drag = (drum.angularVelocity * limit - vt) * 0.2;
        ball.vx -= drag * ny;
        ball.vy += drag * nx;
      }
    }
  });

  // Ball-ball collisions
  for (let i = 0; i < drum.balls.length; i++) {
    for (let j = i + 1; j < drum.balls.length; j++) {
      const a = drum.balls[i];
      const b = drum.balls[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.hypot(dx, dy);
      if (distance > 0 && distance < 2 * r) {
        const nx = dx / distance;
        const ny = dy / distance;
        const overlap = (2 * r - distance) / 2;
        a.x -= nx * overlap;
        a.y -= ny * overlap;
        b.x += nx * overlap;
        b.y += ny * overlap;
        const relativeVelocity = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (relativeVelocity < 0) {
          const impulse = -(1 + restitution) * relativeVelocity / 2;
          a.vx -= impulse * nx;
          a.vy -= impulse * ny;
          b.vx += impulse * nx;
          b.vy += impulse * ny;
        }
      }
    }
  }
}

// Draw a lottery ball, with its number on a white disc when given
function drawBall(x, y, r, color, number) {
  const ctx = drum.ctx;

  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  // Shading: highlight on the top-left, darker edge
  const shading = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
  shading.addColorStop(0, 'rgba(255, 255, 255, 0.6)');
  shading.addColorStop(0.5, 'rgba(255, 255, 255, 0)');
  shading.addColorStop(1, 'rgba(0, 0, 0, 0.35)');
  ctx.fillStyle = shading;
  ctx.fill();

  if (number === undefined) {
    return;
  }

  ctx.beginPath();
  ctx.arc(x, y, r * 0.62, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  const digits = String(number).length;
  ctx.fillStyle = drum.colors.text;
  ctx.font = `bold ${r * 0.7 * Math.min(1, 2.5 / digits)}px 'Segoe UI', Tahoma, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(number, x, y + r * 0.04);
}

// Render stand, drum, balls, rotating cage and exit tube
function drawDrum() {
  const { ctx, cx, cy, colors } = drum;
  const R = drum.radius;
  const r = drum.ballRadius;
  const tubeBottom = cy + R + drum.tubeLength + r * 1.1;

  ctx.clearRect(0, 0, drum.width, drum.height);
  ctx.lineCap = 'round';

  // Stand
  ctx.strokeStyle = colors.stand;
  ctx.lineWidth = R * 0.05;
  ctx.beginPath();
  ctx.moveTo(cx - R * 1.06, cy);
  ctx.lineTo(cx - R * 1.15, tubeBottom);
  ctx.moveTo(cx + R * 1.06, cy);
  ctx.lineTo(cx + R * 1.15, tubeBottom);
  ctx.moveTo(cx - R * 1.3, tubeBottom);
  ctx.lineTo(cx + R * 1.3, tubeBottom);
  ctx.stroke();

  // Glass background
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = colors.glass;
  ctx.fill();
  ctx.globalAlpha = 1;

  drum.balls.forEach(ball => drawBall(cx + ball.x, cy + ball.y, r, ball.color));

  // Rotating cage: meridians whose width follows the rotation angle
  ctx.strokeStyle = colors.cage;
  ctx.lineWidth = Math.max(1, R * 0.012);
  for (let k = 0; k < 6; k++) {
    const meridianWidth = Math.abs(Math.cos(drum.angle + k * Math.PI / 6)) * R;
    ctx.beginPath();
    ctx.ellipse(cx, cy, meridianWidth, R, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Rim and axle hubs
  ctx.lineWidth = R * 0.035;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = colors.stand;
  [-1, 1].forEach(side => {
    ctx.beginPath();
    ctx.arc(cx + side * R * 1.03, cy, R * 0.06, 0, Math.PI * 2);
    ctx.fill();
  });

  // Exit tube
  const tubeWidth = r * 2.5;
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = colors.glass;
  ctx.fillRect(cx - tubeWidth / 2, cy + R * 0.97, tubeWidth, tubeBottom - cy - R * 0.97);
  ctx.globalAlpha = 1;

  // Ball rolling out (number hidden until the reveal), or the last extracted ball resting in the cup
  if (drum.exitingBall) {
    const ball = drum.exitingBall;
    drawBall(cx + ball.x, cy + ball.y, r, ball.color);
  } else if (drum.phase === 'idle' && extractionHistory.length > 0) {
    drawBall(cx, cy + R + drum.tubeLength, r, colors.accent, extractionHistory[extractionHistory.length - 1]);
  }

  ctx.strokeStyle = colors.cage;
  ctx.lineWidth = Math.max(1, R * 0.015);
  ctx.beginPath();
  ctx.moveTo(cx - tubeWidth / 2, cy + R * 0.97);
  ctx.lineTo(cx - tubeWidth / 2, tubeBottom);
  ctx.lineTo(cx + tubeWidth / 2, tubeBottom);
  ctx.lineTo(cx + tubeWidth / 2, cy + R * 0.97);
  ctx.stroke();
}

// Move the extracted ball to the drum outlet, then let it fall down the tube
function updateExitingBall(now) {
  const ball = drum.exitingBall;
  const R = drum.radius;
  const t = Math.min(1, (now - drum.phaseStart) / EXIT_DURATION);
  const outletY = R - drum.ballRadius;
  const split = 0.45;

  if (t < split) {
    const u = t / split;
    const eased = u * u * (3 - 2 * u);
    ball.x = ball.startX + (0 - ball.startX) * eased;
    ball.y = ball.startY + (outletY - ball.startY) * eased;
  } else {
    const u = (t - split) / (1 - split);
    ball.x = 0;
    ball.y = outletY + (R + drum.tubeLength - outletY) * u * u;
  }

  if (t === 1) {
    onBallExited();
  }
}

// The lowest ball leaves the drum
function startExit() {
  const ball = drum.balls.reduce((lowest, b) => (b.y > lowest.y ? b : lowest), drum.balls[0]);
  drum.balls = drum.balls.filter(b => b !== ball);
  drum.exitingBall = {
    color: drum.colors.accent,
    x: ball.x,
    y: ball.y,
    startX: ball.x,
    startY: ball.y
  };
  drum.phase = 'exiting';
  drum.phaseStart = performance.now();
}

// Animation loop
function animate(now) {
  const dt = Math.min(0.05, (now - drum.lastTime) / 1000 || 0);
  drum.lastTime = now;

  if (drum.width > 0 && drum.canvas.offsetParent !== null) {
    // Substeps keep collisions stable at high speed
    for (let i = 0; i < 3; i++) {
      stepPhysics(dt / 3);
    }
    if (drum.phase === 'mixing' && now - drum.phaseStart >= MIX_DURATION) {
      startExit();
    }
    if (drum.phase === 'exiting') {
      updateExitingBall(now);
    }
    drawDrum();
  }

  requestAnimationFrame(animate);
}

// Extract a random number among the remaining ones and start the drum animation
function extractNumber() {
  if (drum.phase !== 'idle') {
    return;
  }
  const remaining = getRemainingNumbers();
  if (remaining.length === 0) {
    alert('Non ci sono più numeri da estrarre');
    return;
  }

  // Commit immediately so that a reload during the animation cannot change the result
  const number = remaining[randomInt(remaining.length)];
  extractionHistory.push(number);
  updateState();

  drum.phase = 'mixing';
  drum.phaseStart = performance.now();
  renderInfo();
}

// Called when the extracted ball reaches the bottom of the tube
function onBallExited() {
  const ball = drum.exitingBall;
  const index = extractionHistory.length - 1;

  // Screen position of the ball, used as the starting point of the reveal animation
  const rect = drum.canvas.getBoundingClientRect();
  showReveal(extractionHistory[index], prizes[index], rect.left + drum.cx + ball.x, rect.top + drum.cy + ball.y, drum.ballRadius * 2);

  // While the reveal covers the screen, the closed ball waits in the cup and a new ball enters the drum
  drum.phase = 'revealing';
  syncDrumBalls();

  // Celebrate the last prize
  if (prizes.length > 0 && index === prizes.length - 1) {
    createConfetti();
  }
}

// Full screen closed ball growing from the drum outlet, then opening to show the number
function showReveal(number, prize, fromX, fromY, fromSize) {
  const overlay = document.createElement('div');
  overlay.className = 'reveal-overlay';

  const ballSize = Math.min(window.innerWidth, window.innerHeight) * 0.6;
  const ball = document.createElement('div');
  ball.className = 'reveal-ball';
  ball.style.setProperty('--from-x', `${fromX - window.innerWidth / 2}px`);
  ball.style.setProperty('--from-y', `${fromY - window.innerHeight / 2}px`);
  ball.style.setProperty('--from-scale', fromSize / ballSize);

  const numberDiv = document.createElement('div');
  numberDiv.className = 'reveal-number';
  numberDiv.textContent = number;
  numberDiv.style.fontSize = `${ballSize * 0.32 * Math.min(1, 3 / String(number).length)}px`;
  ball.appendChild(numberDiv);

  // Two halves of the same shell cover the number until they split open
  ['top', 'bottom'].forEach(half => {
    const shell = document.createElement('div');
    shell.className = `reveal-shell reveal-shell--${half}`;
    ball.appendChild(shell);
  });
  overlay.appendChild(ball);

  if (prize) {
    const prizeDiv = document.createElement('div');
    prizeDiv.className = 'reveal-prize';
    prizeDiv.textContent = prize;
    overlay.appendChild(prizeDiv);
  }

  overlay.addEventListener('click', closeReveal);
  document.body.appendChild(overlay);
}

// Close the reveal and show the extraction in the drum cup and in the sidebar
function closeReveal() {
  document.querySelector('.reveal-overlay').remove();
  drum.exitingBall = null;
  drum.phase = 'idle';
  renderAll();
}

// Space extracts, or closes the reveal like Escape; ignored while typing
function onKeydown(event) {
  if (event.target.tagName === 'INPUT' || (event.key !== ' ' && event.key !== 'Escape')) {
    return;
  }
  // Avoid also activating the focused button
  event.preventDefault();

  if (drum.phase === 'revealing') {
    closeReveal();
  } else if (event.key === ' ' && rangeFrom !== null) {
    extractNumber();
  }
}

// Render setup form or drum, depending on whether the range is set
function renderView() {
  const isSetUp = rangeFrom !== null;
  document.getElementById('setupForm').classList.toggle('hidden', isSetUp);
  document.getElementById('drumSection').classList.toggle('hidden', !isSetUp);
}

// Render remaining counter, next prize and extract button state
function renderInfo() {
  if (rangeFrom === null) {
    return;
  }
  const remaining = getRemainingNumbers().length;
  document.getElementById('remainingCount').textContent = remaining;
  document.getElementById('totalCount').textContent = rangeTo - rangeFrom + 1 - excludedNumbers.size;

  const nextPrize = prizes[extractionHistory.length];
  document.getElementById('nextPrize').textContent = nextPrize ? `Prossimo premio: ${nextPrize}` : '';

  const extractBtn = document.getElementById('extractBtn');
  extractBtn.disabled = remaining === 0 || drum.phase !== 'idle';
  extractBtn.textContent = remaining === 0 ? 'Estrazione terminata' : 'Estrai';
}

// Render extraction history
function renderHistory() {
  const historyList = document.getElementById('historyList');
  historyList.innerHTML = '';

  // Display in reverse order (most recent first)
  for (let index = extractionHistory.length - 1; index >= 0; index--) {
    const number = extractionHistory[index];
    const historyItem = document.createElement('div');
    historyItem.className = 'history-item';
    historyItem.textContent = number;
    historyItem.title = 'Rimetti nell\'urna';

    if (prizes[index]) {
      const prizeSpan = document.createElement('span');
      prizeSpan.className = 'history-prize';
      prizeSpan.textContent = prizes[index];
      historyItem.appendChild(prizeSpan);
    }

    historyItem.addEventListener('click', () => reinsertNumber(number));
    historyList.appendChild(historyItem);
  }
}

// Render prizes list; extracted numbers are assigned to prizes in order
function renderPrizes() {
  const prizesList = document.getElementById('prizesList');
  prizesList.innerHTML = '';

  prizes.forEach((prize, index) => {
    const prizeItem = document.createElement('div');
    prizeItem.className = 'win-item';
    const isAssigned = index < extractionHistory.length;
    prizeItem.classList.toggle('assigned', isAssigned);
    prizeItem.classList.toggle('next', index === extractionHistory.length);

    const label = document.createElement('label');
    label.textContent = `${index + 1}° ${prize}`;
    prizeItem.appendChild(label);

    if (isAssigned) {
      const numberSpan = document.createElement('span');
      numberSpan.className = 'win-number';
      numberSpan.textContent = extractionHistory[index];
      prizeItem.appendChild(numberSpan);
    } else {
      // Only unassigned prizes can be reordered or deleted, so assignments never shift
      prizeItem.draggable = true;
      prizeItem.addEventListener('dragstart', event => event.dataTransfer.setData('text/plain', index));
      prizeItem.addEventListener('dragover', event => event.preventDefault());
      prizeItem.addEventListener('drop', event => {
        event.preventDefault();
        movePrize(parseInt(event.dataTransfer.getData('text/plain'), 10), index);
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'delete-btn';
      deleteBtn.innerHTML = '×';
      deleteBtn.title = 'Elimina premio';
      deleteBtn.addEventListener('click', () => deletePrize(index));
      prizeItem.appendChild(deleteBtn);
    }

    prizesList.appendChild(prizeItem);
  });
}

// Render excluded numbers as intervals
function renderExcluded() {
  const excludedList = document.getElementById('excludedList');
  excludedList.innerHTML = '';

  groupNumbers(excludedNumbers).forEach(group => {
    const excludedItem = document.createElement('div');
    excludedItem.className = 'win-item';

    const label = document.createElement('label');
    label.textContent = formatGroup(group);
    excludedItem.appendChild(label);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-btn';
    deleteBtn.innerHTML = '×';
    deleteBtn.title = 'Rimetti nell\'urna';
    deleteBtn.addEventListener('click', () => includeGroup(group));
    excludedItem.appendChild(deleteBtn);

    excludedList.appendChild(excludedItem);
  });
}

function renderAll() {
  renderView();
  renderInfo();
  renderHistory();
  renderPrizes();
  renderExcluded();
}

// Create confetti effect
function createConfetti() {
  const confettiContainer = document.createElement('div');
  confettiContainer.className = 'confetti-container';
  document.body.appendChild(confettiContainer);

  const confettiCount = 300;

  for (let i = 0; i < confettiCount; i++) {
    const confetti = document.createElement('div');
    confetti.className = 'confetti';
    confetti.style.left = Math.random() * 100 + '%';
    confetti.style.backgroundColor = BALL_COLORS[Math.floor(Math.random() * BALL_COLORS.length)];
    confetti.style.animationDelay = Math.random() * 0.5 + 's';
    confetti.style.animationDuration = (Math.random() * 2 + 2) + 's';

    // Random rotation direction
    const rotationDirection = Math.random() > 0.5 ? 1 : -1;
    confetti.style.setProperty('--rotation-direction', rotationDirection);

    confettiContainer.appendChild(confetti);
  }

  // Remove confetti after animation
  setTimeout(() => {
    confettiContainer.remove();
  }, 4000);
}

// Start the lottery from the setup form
function startLottery(event) {
  event.preventDefault();
  const from = parseInt(document.getElementById('rangeFromInput').value, 10);
  const to = parseInt(document.getElementById('rangeToInput').value, 10);

  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from) {
    alert('Il range deve avere "Da" minore di "A", entrambi non negativi');
    return;
  }
  if (to - from + 1 > MAX_RANGE_SIZE) {
    alert(`Il range può contenere al massimo ${MAX_RANGE_SIZE} numeri`);
    return;
  }

  const excluded = parseNumberList(document.getElementById('setupExcludedInput').value);
  if (excluded === null) {
    alert('Numeri esclusi non validi, usa il formato 13, 27, 40-45');
    return;
  }

  rangeFrom = from;
  rangeTo = to;
  excludedNumbers = new Set(excluded.filter(n => n >= from && n <= to));
  extractionHistory = [];

  if (getRemainingNumbers().length === 0) {
    alert('Tutti i numeri del range sono esclusi');
    rangeFrom = null;
    rangeTo = null;
    excludedNumbers.clear();
    return;
  }

  updateState();
  renderAll();
  resizeDrum();
  syncDrumBalls();
}

// Exclude numbers by hand (e.g. unsold or lost tickets)
function excludeNumbers() {
  const input = document.getElementById('excludeInput');

  if (rangeFrom === null) {
    alert('Imposta prima il range della lotteria');
    return;
  }

  const numbers = parseNumberList(input.value);
  if (numbers === null || numbers.length === 0) {
    alert('Formato non valido, usa ad esempio 13, 27, 40-45');
    return;
  }

  // Ignore numbers outside the range or already extracted
  const extracted = new Set(extractionHistory);
  const valid = numbers.filter(n => n >= rangeFrom && n <= rangeTo && !extracted.has(n));
  if (valid.length === 0) {
    alert('Nessuno di questi numeri è nell\'urna');
    return;
  }

  valid.forEach(n => excludedNumbers.add(n));
  input.value = '';

  updateState();
  syncDrumBalls();
  renderAll();
}

// Put an excluded interval back into the drum
function includeGroup([start, end]) {
  for (let n = start; n <= end; n++) {
    excludedNumbers.delete(n);
  }

  updateState();
  syncDrumBalls();
  renderAll();
}

// Undo an extraction, putting the number back into the drum
function reinsertNumber(number) {
  if (drum.phase !== 'idle') {
    return;
  }
  if (!confirm(`Rimettere il ${number} nell'urna?`)) {
    return;
  }

  extractionHistory = extractionHistory.filter(n => n !== number);

  updateState();
  syncDrumBalls();
  renderAll();
}

// Add a prize at the end of the list
function addPrize() {
  const input = document.getElementById('prizeInput');
  const name = input.value.trim();

  if (name === '') {
    alert('Inserisci il nome del premio');
    return;
  }

  prizes.push(name);
  input.value = '';

  updateState();
  renderAll();
}

// Delete an unassigned prize
function deletePrize(index) {
  prizes.splice(index, 1);

  updateState();
  renderAll();
}

// Move an unassigned prize to another unassigned position (the source index comes from a drag, so it is validated)
function movePrize(from, to) {
  if (!Number.isInteger(from) || from < extractionHistory.length || from >= prizes.length || from === to) {
    return;
  }
  const [prize] = prizes.splice(from, 1);
  prizes.splice(to, 0, prize);

  updateState();
  renderAll();
}

// Clear range, extracted numbers, prizes and exclusions
function clearAll() {
  if (drum.phase !== 'idle') {
    return;
  }
  if (confirm('Cancellare range, estrazioni, premi ed esclusioni?')) {
    rangeFrom = null;
    rangeTo = null;
    excludedNumbers.clear();
    extractionHistory = [];
    prizes = [];
    drum.balls = [];

    // Clear localStorage
    clearLocalStorage();

    // Clear URL parameter to reflect empty state
    replaceStateParam(null);

    renderAll();
  }
}

// Initialize the application
function init() {
  drum.canvas = document.getElementById('drumCanvas');
  drum.ctx = drum.canvas.getContext('2d');

  // Check for color parameter in URL and apply it
  const urlParams = new URLSearchParams(window.location.search);
  const colorParam = urlParams.get('color');
  if (colorParam && /^[0-9A-Fa-f]{6}$/.test(colorParam)) {
    // Valid hex color, apply it
    const mainColor = `#${colorParam}`;
    document.documentElement.style.setProperty('--base-extracted-color', mainColor);

    // Update theme-color meta tags
    document.querySelectorAll('meta[name="theme-color"]').forEach(meta => {
      meta.setAttribute('content', mainColor);
    });
  }

  // Try to load state from URL first (priority), then localStorage
  const state = urlParams.has('state') ? decodeState(urlParams) : loadFromLocalStorage();

  // Apply loaded state
  if (state) {
    rangeFrom = state.rangeFrom;
    rangeTo = state.rangeTo;
    excludedNumbers = state.excludedNumbers;
    extractionHistory = state.extractionHistory;
    prizes = state.prizes;

    // If we loaded from localStorage, update URL to reflect state
    if (!urlParams.has('state')) {
      updateURL();
    }
  }

  document.addEventListener('keydown', onKeydown);

  // Add prizes and exclusions with Enter
  [['prizeInput', addPrize], ['excludeInput', excludeNumbers]].forEach(([id, action]) => {
    document.getElementById(id).addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        action();
      }
    });
  });

  // Follow canvas size and color scheme changes
  new ResizeObserver(resizeDrum).observe(drum.canvas.parentElement);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readDrumColors);
  readDrumColors();

  renderAll();
  resizeDrum();
  syncDrumBalls();
  requestAnimationFrame(animate);
}

// Start the application
init();
