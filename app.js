// TRACKFORGE - Local-First Activity Tracker
// Architecture: State Machine | Reliability | Feedback | Persistence

const APP_STATE = {
  IDLE: 'idle', TRACKING: 'tracking', PAUSED: 'paused',
  REVIEW: 'review', HISTORY: 'history', DETAIL: 'detail', SETTINGS: 'settings'
};

let state = APP_STATE.IDLE;
let geoWatchId = null;
let session = {
  start: null, elapsed: 0, distance: 0, elevGain: 0,
  coords: [], speeds: [], paused: false, lastPoint: null
};

// DOM Refs
const $ = id => document.getElementById(id);
const els = {
  app: $('app'), timer: $('timer'), gps: $('gps-status'),
  dist: $('distance'), distUnit: $('distance-unit'),
  speed: $('speed'), speedUnit: $('speed-unit'), avgSpeed: $('avg-speed'), elev: $('elevation'),
  ctrl: $('ctrl-primary'), sec: $('ctrl-secondary'), tert: $('ctrl-tertiary'),
  review: $('review-panel'), reviewStats: $('review-stats'),
  notes: $('review-notes'), exportCanvas: $('export-canvas'),
  history: $('history-panel'), historyList: $('history-list'),
  backHistory: $('btn-back-history'), mapCanvas: $('map-canvas')
};

// State Machine
function transition(newState) {
  state = newState;
  els.app.className = `state-${state}`;
  updateUI();
  if (state === APP_STATE.TRACKING) startTracking();
  else if (state === APP_STATE.IDLE) stopTracking();
  else if (state === APP_STATE.REVIEW) initReview();
  else if (state === APP_STATE.HISTORY) loadHistory();
}

// Reliability Layer: GPS
const GPS_CONFIG = {
  enableHighAccuracy: true, timeout: 15000, maximumAge: 2000,
  minJumpSpeed: 50, // m/s
  minMovement: 2,    // meters
  maxAccuracy: 30    // meters
};

function startTracking() {
  if (!navigator.geolocation) return alert('GPS unavailable');
  els.ctrl.textContent = 'PAUSE';
  els.sec.disabled = els.tert.disabled = true;
  session.start = Date.now();
  session.elapsed = 0;
  session.coords = [];
  session.speeds = [];
  session.elevGain = 0;
  session.lastPoint = null;
  session.paused = false;

  geoWatchId = navigator.geolocation.watchPosition(onPosition, onError, GPS_CONFIG);
  setInterval(autoSave, 5000);
  tick();
}

function stopTracking() {
  if (geoWatchId) navigator.geolocation.clearWatch(geoWatchId);
  geoWatchId = null;
  els.ctrl.textContent = 'START';
  els.sec.disabled = els.tert.disabled = false;
}

function onPosition(pos) {
  const { latitude, longitude, accuracy, altitude } = pos.coords;
  if (accuracy > GPS_CONFIG.maxAccuracy) {
    els.gps.className = 'status-badge signal-lost';
    return;
  }
  els.gps.className = 'status-badge signal-ok';

  const now = Date.now();
  const point = { lat: latitude, lng: longitude, alt: altitude, time: now };
  
  if (!session.lastPoint) {
    session.lastPoint = point;
    session.coords.push(point);
    drawRoute();
    return;
  }

  // Jitter & Jump Filtering
  const dist = haversine(session.lastPoint, point);
  const dt = (now - session.lastPoint.time) / 1000;
  if (dt === 0 || dist < GPS_CONFIG.minMovement) return;
  if (dist / dt > GPS_CONFIG.minJumpSpeed) return; // reject jump

  session.lastPoint = point;
  session.coords.push(point);
  session.distance += dist;
  
  // Elevation
  if (altitude && session.coords.length > 1 && session.coords[session.coords.length-2].alt) {
    const prevAlt = session.coords[session.coords.length-2].alt;
    if (altitude > prevAlt) session.elevGain += (altitude - prevAlt);
  }

  session.speeds.push(dist / dt);
  drawRoute();
}

function onError() {
  els.gps.className = 'status-badge signal-lost';
  els.gps.textContent = 'GPS Lost';
}

// Math & Smoothing
function haversine(p1, p2) {
  const R = 6371000;
  const dLat = (p2.lat - p1.lat) * Math.PI / 180;
  const dLng = (p2.lng - p1.lng) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(p1.lat*Math.PI/180)*Math.cos(p2.lat*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function tick() {
  if (state !== APP_STATE.TRACKING && state !== APP_STATE.PAUSED) return;
  if (!session.paused) session.elapsed += 1000;
  
  const elapsed = Math.floor(session.elapsed / 1000);
  const h = String(Math.floor(elapsed/3600)).padStart(2,'0');
  const m = String(Math.floor((elapsed%3600)/60)).padStart(2,'0');
  const s = String(elapsed%60).padStart(2,'0');
  els.timer.textContent = `${h}:${m}:${s}`;

  const distKm = session.distance / 1000;
  els.dist.textContent = distKm.toFixed(2);
  els.distUnit.textContent = 'km';

  const currentSpeed = session.speeds.length ? session.speeds[session.speeds.length-1] * 3.6 : 0;
  els.speed.textContent = currentSpeed.toFixed(1);
  const avg = session.speeds.length ? (session.speeds.reduce((a,b)=>a+b,0)/session.speeds.length)*3.6 : 0;
  els.avgSpeed.textContent = avg.toFixed(1);
  els.elev.textContent = Math.round(session.elevGain);

  // Milestone
  if (Math.floor(distKm * 1000) % 1000 === 0 && session.distance > 50) {
    playMilestone();
  }

  setTimeout(tick, 1000);
}

// Feedback Layer: Audio & Haptics
function playMilestone() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.5);
    if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
  } catch(e) {}
}

// Map Rendering (Lightweight Canvas Tiles)
const mapCtx = els.mapCanvas.getContext('2d');
function drawRoute() {
  if (state !== APP_STATE.TRACKING && state !== APP_STATE.PAUSED) return;
  const w = els.mapCanvas.width = els.mapCanvas.offsetWidth;
  const h = els.mapCanvas.height = els.mapCanvas.offsetHeight;
  mapCtx.clearRect(0, 0, w, h);
  mapCtx.fillStyle = '#151515';
  mapCtx.fillRect(0, 0, w, h);

  // Simplified: Draw route relative to bounding box
  if (session.coords.length < 2) return;
  let minLat=90, maxLat=-90, minLng=180, maxLng=-180;
  session.coords.forEach(c => {
    minLat=Math.min(minLat,c.lat); maxLat=Math.max(maxLat,c.lat);
    minLng=Math.min(minLng,c.lng); maxLng=Math.max(maxLng,c.lng);
  });
  const pad=0.1;
  const xScale = w / (maxLng-minLng+pad);
  const yScale = h / (maxLat-minLat+pad);
  mapCtx.beginPath();
  mapCtx.strokeStyle = '#3b82f6';
  mapCtx.lineWidth = 3;
  session.coords.forEach((c,i) => {
    const x = (c.lng - minLng + pad/2) * xScale;
    const y = h - (c.lat - minLat + pad/2) * yScale;
    i===0 ? mapCtx.moveTo(x,y) : mapCtx.lineTo(x,y);
  });
  mapCtx.stroke();

  // Start/End markers
  mapCtx.fillStyle = '#22c55e';
  mapCtx.beginPath(); mapCtx.arc(xStart, yStart, 5, 0, Math.PI*2); mapCtx.fill();
  const xEnd = (session.coords[session.coords.length-1].lng - minLng + pad/2) * xScale;
  const yEnd = h - (session.coords[session.coords.length-1].lat - minLat + pad/2) * yScale;
  mapCtx.fillStyle = '#ef4444';
  mapCtx.beginPath(); mapCtx.arc(xEnd, yEnd, 5, 0, Math.PI*2); mapCtx.fill();
}

// Persistence Layer
function autoSave() {
  localStorage.setItem('trackforge_session', JSON.stringify(session));
}

function restoreSession() {
  const saved = localStorage.getItem('trackforge_session');
  if (saved) {
    session = JSON.parse(saved);
    transition(APP_STATE.REVIEW);
  }
}

// IndexedDB (History)
let db;
function openDB() {
  return new Promise(resolve => {
    const req = indexedDB.open('trackforge', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('activities', { keyPath: 'id' });
    req.onsuccess = e => { db = e.target.result; resolve(); };
  });
}

async function saveActivity(activity) {
  await openDB();
  db.transaction('activities','readwrite').objectStore('activities').add(activity);
}

async function loadHistory() {
  await openDB();
  const tx = db.transaction('activities','readonly');
  const req = tx.objectStore('activities').getAll();
  req.onsuccess = () => {
    els.historyList.innerHTML = '';
    req.result.reverse().forEach(a => {
      const li = document.createElement('li');
      li.innerHTML = `<strong>${new Date(a.date).toLocaleDateString()}</strong> • ${a.distance.toFixed(2)}km • ${a.duration}`;
      li.onclick = () => alert('Detail view: implement routing later');
      els.historyList.appendChild(li);
    });
  };
}

// Review & Export
function initReview() {
  transition(APP_STATE.REVIEW);
  els.review.classList.remove('hidden');
  els.reviewStats.innerHTML = `
    Distance: ${(session.distance/1000).toFixed(2)}km<br>
    Time: ${els.timer.textContent}<br>
    Avg Speed: ${els.avgSpeed.textContent} km/h<br>
    Elevation: ${Math.round(session.elevGain)}m
  `;
}

$('btn-save').onclick = async () => {
  const act = { id: Date.now(), date: new Date(), distance: session.distance/1000, duration: els.timer.textContent, avgSpeed: parseFloat(els.avgSpeed.textContent), elev: Math.round(session.elevGain), notes: els.notes.value, coords: session.coords };
  await saveActivity(act);
  localStorage.removeItem('trackforge_session');
  els.review.classList.add('hidden');
  transition(APP_STATE.IDLE);
};

$('btn-export').onclick = () => {
  const c = els.exportCanvas;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#111'; ctx.fillRect(0,0,c.width,c.height);
  ctx.fillStyle = '#fff'; ctx.font='18px sans-serif';
  ctx.fillText('TrackForge', 20, 30);
  ctx.fillText(`${els.reviewStats.innerText.replace(/\n/g, ' | ')}`, 20, 70);
  const link = document.createElement('a');
  link.download = `trackforge-${Date.now()}.png`;
  link.href = c.toDataURL();
  link.click();
};

$('btn-discard').onclick = () => {
  localStorage.removeItem('trackforge_session');
  els.review.classList.add('hidden');
  transition(APP_STATE.IDLE);
};

// Controls & Gestures
$('ctrl-primary').onclick = () => {
  if (state === APP_STATE.IDLE) transition(APP_STATE.TRACKING);
  else if (state === APP_STATE.TRACKING) { session.paused = true; els.ctrl.textContent='RESUME'; transition(APP_STATE.PAUSED); }
  else if (state === APP_STATE.PAUSED) { session.paused = false; els.ctrl.textContent='PAUSE'; transition(APP_STATE.TRACKING); }
};

$('ctrl-secondary').onclick = () => transition(APP_STATE.HISTORY);
$('backHistory').onclick = () => { els.history.classList.add('hidden'); transition(state); };

// Long press to reset, slide to end (simplified)
let pressTimer;
$('ctrl-tertiary').addEventListener('touchstart', () => pressTimer=setTimeout(()=>confirm('Reset session?')&&location.reload(), 1500));
$('ctrl-tertiary').addEventListener('touchend', () => clearTimeout(pressTimer));

// Service Worker Registration
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('service-worker.js').catch(console.error);
}

// Init
openDB().then(() => {
  if (localStorage.getItem('trackforge_session')) restoreSession();
  transition(APP_STATE.IDLE);
});
