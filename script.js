/**
 * EmoSense — Frontend Script
 * Handles: auth, webcam capture, API calls, chart rendering, UI state
 */

// ─── CONFIGURATION ──────────────────────────────────────────────────────────
const API_BASE = 'http://localhost:5000/api';
const CAPTURE_INTERVAL_MS = 600;   // ms between frames sent to backend
const MAX_HISTORY_DISPLAY = 200;

// ─── STATE ──────────────────────────────────────────────────────────────────
let authToken = null;
let currentUser = null;
let webcamStream = null;
let captureTimer = null;
let isDetecting = true;
let sessionData = { total: 0, emotions: {}, confidences: [] };
let charts = {};
let fpsCounter = { frames: 0, lastTime: Date.now(), fps: 0 };

// ─── EMOTION META ────────────────────────────────────────────────────────────
const EMOTION_META = {
  happy:    { emoji: '😄', color: '#ffe34d' },
  sad:      { emoji: '😢', color: '#63caff' },
  angry:    { emoji: '😠', color: '#ff4f4f' },
  fear:     { emoji: '😨', color: '#b97dff' },
  surprise: { emoji: '😲', color: '#ff9f40' },
  disgust:  { emoji: '🤢', color: '#39ff96' },
  neutral:  { emoji: '😐', color: '#8fa3ba' },
};

// ─── INIT ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const token = localStorage.getItem('emo_token');
  const user  = localStorage.getItem('emo_user');
  if (token && user) {
    authToken = token;
    currentUser = user;
    enterApp();
  }
  buildEmotionMeters();
});

// ─── AUTH ─────────────────────────────────────────────────────────────────────
function switchTab(tab) {
  const isLogin = tab === 'login';
  document.getElementById('tab-login').classList.toggle('active', isLogin);
  document.getElementById('tab-signup').classList.toggle('active', !isLogin);
  document.getElementById('form-login').classList.toggle('active', isLogin);
  document.getElementById('form-signup').classList.toggle('active', !isLogin);
  document.getElementById('tab-indicator').classList.toggle('right', !isLogin);
  document.getElementById('auth-error').style.display = 'none';
}

async function login() {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  if (!username || !password) return showAuthError('Please fill in all fields');

  setButtonLoading('btn-primary', true);
  try {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) return showAuthError(data.error || 'Login failed');
    authToken = data.token;
    currentUser = data.username;
    localStorage.setItem('emo_token', authToken);
    localStorage.setItem('emo_user', currentUser);
    enterApp();
  } catch (e) {
    showAuthError('Cannot connect to backend. Make sure Flask is running on port 5000.');
  } finally {
    setButtonLoading('btn-primary', false);
  }
}

async function signup() {
  const username = document.getElementById('signup-username').value.trim();
  const email    = document.getElementById('signup-email').value.trim();
  const password = document.getElementById('signup-password').value;
  if (!username || !email || !password) return showAuthError('Please fill in all fields');

  setButtonLoading('btn-primary', true);
  try {
    const res = await fetch(`${API_BASE}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email, password })
    });
    const data = await res.json();
    if (!res.ok) return showAuthError(data.error || 'Signup failed');
    authToken = data.token;
    currentUser = data.username;
    localStorage.setItem('emo_token', authToken);
    localStorage.setItem('emo_user', currentUser);
    enterApp();
  } catch (e) {
    showAuthError('Cannot connect to backend. Make sure Flask is running on port 5000.');
  } finally {
    setButtonLoading('btn-primary', false);
  }
}

function logout() {
  stopCamera();
  fetch(`${API_BASE}/auth/logout`, { method: 'POST', headers: authHeaders() });
  authToken = null; currentUser = null;
  localStorage.removeItem('emo_token');
  localStorage.removeItem('emo_user');
  document.getElementById('auth-screen').classList.add('active');
  document.getElementById('app-screen').classList.remove('active');
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg; el.style.display = 'block';
}

function setButtonLoading(cls, loading) {
  const btn = document.querySelector(`.${cls}`);
  if (!btn) return;
  btn.disabled = loading;
  btn.querySelector('.btn-text').style.display = loading ? 'none' : '';
  btn.querySelector('.btn-loader').style.display = loading ? '' : 'none';
}

function enterApp() {
  document.getElementById('auth-screen').classList.remove('active');
  document.getElementById('app-screen').classList.add('active');
  document.getElementById('sidebar-username').textContent = currentUser;
  document.getElementById('user-avatar').textContent = currentUser[0].toUpperCase();
  showPage('camera');
  loadHistory();
}

function authHeaders() {
  return { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' };
}

// ─── PAGE ROUTING ─────────────────────────────────────────────────────────────
function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(`page-${name}`).classList.add('active');
  document.querySelector(`[data-page="${name}"]`).classList.add('active');

  if (name === 'dashboard') loadAnalytics();
  if (name === 'history') loadHistory();
}

// ─── CAMERA ──────────────────────────────────────────────────────────────────
async function startCamera() {
  try {
    webcamStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: false
    });
    const video = document.getElementById('webcam');
    video.srcObject = webcamStream;
    await video.play();

    document.getElementById('btn-start-cam').style.display = 'none';
    document.getElementById('btn-stop-cam').style.display = '';
    document.getElementById('btn-toggle-detect').style.display = '';

    sessionData = { total: 0, emotions: {}, confidences: [] };
    captureTimer = setInterval(captureAndPredict, CAPTURE_INTERVAL_MS);
    showToast('Camera started ✓');
  } catch (err) {
    showToast(`Camera error: ${err.message}`);
  }
}

function stopCamera() {
  if (captureTimer) { clearInterval(captureTimer); captureTimer = null; }
  if (webcamStream) {
    webcamStream.getTracks().forEach(t => t.stop());
    webcamStream = null;
  }
  document.getElementById('btn-start-cam').style.display = '';
  document.getElementById('btn-stop-cam').style.display = 'none';
  document.getElementById('btn-toggle-detect').style.display = 'none';
  document.getElementById('no-face-msg').style.display = 'none';
  resetEmotionOverlay();
}

function toggleDetection() {
  isDetecting = !isDetecting;
  document.getElementById('detect-label').textContent =
    isDetecting ? 'Pause Detection' : 'Resume Detection';
  showToast(isDetecting ? 'Detection resumed' : 'Detection paused');
}

// ─── FRAME CAPTURE & PREDICTION ──────────────────────────────────────────────
async function captureAndPredict() {
  if (!isDetecting) return;
  const video = document.getElementById('webcam');
  if (video.readyState < 2) return;

  // Draw frame to temp canvas
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0);

  // FPS tracking
  fpsCounter.frames++;
  const now = Date.now();
  if (now - fpsCounter.lastTime >= 1000) {
    fpsCounter.fps = fpsCounter.frames;
    fpsCounter.frames = 0;
    fpsCounter.lastTime = now;
    document.getElementById('fps-badge').textContent = `${fpsCounter.fps} FPS`;
    document.getElementById('stat-fps').textContent = fpsCounter.fps;
  }

  const imageData = canvas.toDataURL('image/jpeg', 0.7);

  try {
    const res = await fetch(`${API_BASE}/predict`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ image: imageData })
    });
    if (res.status === 401) { logout(); return; }
    const data = await res.json();
    updateEmotionUI(data);
  } catch (e) {
    // Silently ignore network errors during capture
  }
}

// ─── EMOTION UI UPDATE ────────────────────────────────────────────────────────
function updateEmotionUI(data) {
  const noFaceEl = document.getElementById('no-face-msg');
  const overlayEl = document.getElementById('emotion-overlay');

  if (!data.face_detected || !data.emotion) {
    noFaceEl.style.display = 'flex';
    overlayEl.style.opacity = '0.4';
    resetEmotionOverlay();
    return;
  }

  noFaceEl.style.display = 'none';
  overlayEl.style.opacity = '1';

  const emotion = data.emotion.toLowerCase();
  const meta = EMOTION_META[emotion] || { emoji: '🤔', color: '#8fa3ba' };
  const conf = Math.round((data.confidence || 0) * 100);

  // Main badge
  document.getElementById('current-emoji').textContent = meta.emoji;
  document.getElementById('current-emotion-label').textContent = emotion;
  document.getElementById('current-emotion-label').style.color = meta.color;

  // Confidence bar
  const bar = document.getElementById('confidence-bar');
  bar.style.width = `${conf}%`;
  bar.style.background = meta.color;
  bar.style.boxShadow = `0 0 8px ${meta.color}88`;
  document.getElementById('confidence-text').textContent = `${conf}%`;

  // Meters
  updateMeters(data.all_emotions || {});

  // Session stats
  sessionData.total++;
  sessionData.emotions[emotion] = (sessionData.emotions[emotion] || 0) + 1;
  sessionData.confidences.push(data.confidence || 0);

  const dominant = Object.entries(sessionData.emotions)
    .sort((a, b) => b[1] - a[1])[0]?.[0] || '—';
  const avgConf = sessionData.confidences.length
    ? Math.round(sessionData.confidences.reduce((a, b) => a + b) / sessionData.confidences.length * 100)
    : 0;

  document.getElementById('stat-total').textContent = sessionData.total;
  document.getElementById('stat-dominant').textContent = dominant;
  document.getElementById('stat-avgconf').textContent = `${avgConf}%`;
}

function resetEmotionOverlay() {
  document.getElementById('current-emoji').textContent = '🎭';
  document.getElementById('current-emotion-label').textContent = 'Waiting...';
  document.getElementById('current-emotion-label').style.color = '';
  document.getElementById('confidence-bar').style.width = '0%';
  document.getElementById('confidence-text').textContent = '0%';
}

// ─── EMOTION METERS ───────────────────────────────────────────────────────────
function buildEmotionMeters() {
  const container = document.getElementById('emotion-meters');
  container.innerHTML = '';
  Object.entries(EMOTION_META).forEach(([emotion, meta]) => {
    container.innerHTML += `
      <div class="meter-item" data-emotion="${emotion}">
        <div class="meter-header">
          <span class="meter-name">${meta.emoji} ${emotion}</span>
          <span class="meter-value" id="meter-val-${emotion}">0%</span>
        </div>
        <div class="meter-track">
          <div class="meter-fill" id="meter-fill-${emotion}"
               style="background:${meta.color}; box-shadow: 0 0 6px ${meta.color}66;"></div>
        </div>
      </div>
    `;
  });
}

function updateMeters(allEmotions) {
  Object.entries(allEmotions).forEach(([emotion, score]) => {
    const pct = Math.round(score * 100);
    const fill = document.getElementById(`meter-fill-${emotion}`);
    const val  = document.getElementById(`meter-val-${emotion}`);
    if (fill) fill.style.width = `${pct}%`;
    if (val)  val.textContent = `${pct}%`;
  });
}

// ─── HISTORY ──────────────────────────────────────────────────────────────────
async function loadHistory() {
  const tbody = document.getElementById('history-tbody');
  tbody.innerHTML = '<tr><td colspan="5" class="loading-row">Loading...</td></tr>';
  try {
    const res = await fetch(`${API_BASE}/history?limit=${MAX_HISTORY_DISPLAY}`, { headers: authHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    renderHistoryTable(data.records);
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="5" class="loading-row">Error loading history</td></tr>';
  }
}

function renderHistoryTable(records) {
  const tbody = document.getElementById('history-tbody');
  if (!records.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="loading-row">No records yet. Start the camera!</td></tr>';
    return;
  }
  tbody.innerHTML = records.map((r, i) => {
    const meta = EMOTION_META[r.emotion] || { emoji: '🤔', color: '#8fa3ba' };
    const conf = Math.round((r.confidence || 0) * 100);
    const top2 = Object.entries(r.all_emotions || {})
      .sort((a,b) => b[1]-a[1]).slice(0, 3)
      .map(([k,v]) => `${k}:${Math.round(v*100)}%`).join(' ');
    return `
      <tr>
        <td style="color:var(--text-3);font-family:'DM Mono',monospace;font-size:12px">${i+1}</td>
        <td>
          <span class="emotion-pill" style="background:${meta.color}22;color:${meta.color};border:1px solid ${meta.color}44">
            ${meta.emoji} ${r.emotion}
          </span>
        </td>
        <td>
          <span class="conf-bar-mini">
            <span class="conf-fill-mini" style="width:${conf}%;background:${meta.color}"></span>
          </span>
          <span style="font-family:'DM Mono',monospace;font-size:12px;margin-left:6px">${conf}%</span>
        </td>
        <td class="time-cell">${formatDate(r.recorded_at)}</td>
        <td class="breakdown-mini">${top2}</td>
      </tr>
    `;
  }).join('');
}

// ─── ANALYTICS ────────────────────────────────────────────────────────────────
async function loadAnalytics() {
  try {
    const res = await fetch(`${API_BASE}/analytics`, { headers: authHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    renderAnalytics(data);
  } catch (e) {
    showToast('Could not load analytics');
  }
}

function renderAnalytics(data) {
  const s = data.stats;
  document.getElementById('astat-total').textContent = s.total || 0;
  document.getElementById('astat-conf').textContent = s.avg_confidence
    ? `${Math.round(s.avg_confidence * 100)}%` : '—';
  document.getElementById('astat-last').textContent = s.last_seen
    ? formatDate(s.last_seen) : '—';

  const topEmotion = data.distribution[0];
  if (topEmotion) {
    const meta = EMOTION_META[topEmotion.emotion] || {};
    document.getElementById('astat-top').textContent = `${meta.emoji || ''} ${topEmotion.emotion}`;
  }

  renderDistributionChart(data.distribution);
  renderTimelineChart(data.timeline);
  renderTrendChart(data.daily);
}

function renderDistributionChart(dist) {
  const ctx = document.getElementById('chart-distribution').getContext('2d');
  if (charts.dist) charts.dist.destroy();

  const labels = dist.map(d => d.emotion);
  const counts = dist.map(d => d.count);
  const colors = labels.map(l => (EMOTION_META[l]?.color || '#8fa3ba'));

  charts.dist = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data: counts, backgroundColor: colors.map(c => c + 'cc'),
                   borderColor: colors, borderWidth: 2, hoverOffset: 8 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      cutout: '65%',
      plugins: {
        legend: { position: 'right', labels: { color: '#8fa3ba', font: { family: 'DM Sans', size: 12 }, padding: 12 } },
        tooltip: { callbacks: { label: (ctx) => ` ${ctx.label}: ${ctx.parsed} detections` } }
      }
    }
  });
}

function renderTimelineChart(timeline) {
  const ctx = document.getElementById('chart-timeline').getContext('2d');
  if (charts.timeline) charts.timeline.destroy();

  // Aggregate by hour
  const hourMap = {};
  timeline.forEach(t => {
    hourMap[t.hour] = (hourMap[t.hour] || 0) + t.count;
  });
  const hours = Object.keys(hourMap).sort();
  const counts = hours.map(h => hourMap[h]);

  charts.timeline = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: hours,
      datasets: [{
        label: 'Detections',
        data: counts,
        backgroundColor: 'rgba(99,202,255,0.3)',
        borderColor: '#63caff',
        borderWidth: 1.5,
        borderRadius: 4,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#4a6070', font: { size: 11 } } },
        y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#4a6070', font: { size: 11 } } }
      }
    }
  });
}

function renderTrendChart(daily) {
  const ctx = document.getElementById('chart-trend').getContext('2d');
  if (charts.trend) charts.trend.destroy();

  // Get unique days and emotions
  const days = [...new Set(daily.map(d => d.day))].sort();
  const emotions = [...new Set(daily.map(d => d.emotion))];

  const datasets = emotions.map(emotion => {
    const meta = EMOTION_META[emotion] || { color: '#8fa3ba' };
    const dataMap = {};
    daily.filter(d => d.emotion === emotion).forEach(d => { dataMap[d.day] = d.count; });
    return {
      label: emotion,
      data: days.map(day => dataMap[day] || 0),
      borderColor: meta.color,
      backgroundColor: meta.color + '22',
      fill: true,
      tension: 0.4,
      pointRadius: 3,
      borderWidth: 2,
    };
  });

  charts.trend = new Chart(ctx, {
    type: 'line',
    data: { labels: days, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top', labels: { color: '#8fa3ba', font: { family: 'DM Sans', size: 11 }, boxWidth: 10, padding: 10 } }
      },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#4a6070', font: { size: 11 } } },
        y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#4a6070', font: { size: 11 } } }
      }
    }
  });
}

// ─── EXPORT ──────────────────────────────────────────────────────────────────
async function exportData(format) {
  try {
    const res = await fetch(`${API_BASE}/export?format=${format}`, { headers: authHeaders() });
    if (!res.ok) { showToast('Export failed'); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `emotion_history.${format}`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Exported as ${format.toUpperCase()} ✓`);
  } catch (e) {
    showToast('Export failed');
  }
}

// ─── UTILITIES ────────────────────────────────────────────────────────────────
function formatDate(isoStr) {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  return d.toLocaleString('en-IN', { month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit' });
}

let toastTimer;
function showToast(msg, duration = 3000) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.display = 'none'; }, duration);
}

// Support Enter key on login/signup
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (document.getElementById('form-login').classList.contains('active')) login();
  else signup();
});
