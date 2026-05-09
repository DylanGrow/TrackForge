"use strict";

// Production Error Boundaries
window.onerror = (msg, url, line, col, error) => {
  console.error("Global Error:", msg, error);
  // Delay slightly to ensure EventBus exists
  setTimeout(() => typeof EventBus !== 'undefined' && EventBus.emit('gps:error', `Crash: ${msg}`), 100);
};
window.onunhandledrejection = (e) => {
  console.error("Unhandled Promise Rejection:", e.reason);
  setTimeout(() => typeof EventBus !== 'undefined' && EventBus.emit('gps:error', `Error: ${e.reason?.message || 'Unknown'}`), 100);
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. EVENT BUS & STATE MANAGEMENT
// Decouples core logic from UI via a lightweight pub/sub pattern
// ─────────────────────────────────────────────────────────────────────────────
const EventBus = {
  _listeners: new Map(),
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push(fn);
    return () => this.off(event, fn);
  },
  off(event, fn) {
    const fns = this._listeners.get(event) || [];
    this._listeners.set(event, fns.filter(cb => cb !== fn));
  },
  emit(event, payload) {
    (this._listeners.get(event) || []).forEach(fn => fn(payload));
  }
};

const State = { IDLE: 'IDLE', TRACKING: 'TRACKING', PAUSED: 'PAUSED' };

const Feedback = {
  vibrate(pattern) { if (navigator.vibrate) navigator.vibrate(pattern); },
  speak(text) {
    if ('speechSynthesis' in window) {
      // Only cancel if it's high priority (e.g., error), otherwise let them queue
      // window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 0.95; u.pitch = 1.0; u.volume = 0.8;
      window.speechSynthesis.speak(u);
    }
  }
};

const Pedometer = {
  steps: 0,
  lastY: 0,
  lastStepTime: 0,
  running: false,
  _handler: null,
  start() {
    this.steps = 0;
    this.running = true;
    this._handler = (e) => {
      if (!this.running || !e.accelerationIncludingGravity) return;
      const y = e.accelerationIncludingGravity.y;
      const now = Date.now();
      // Min 250ms between steps to avoid counting vibrations/jitter
      if (Math.abs(y - this.lastY) > 1.2 && (now - this.lastStepTime) > 250) {
        this.steps++;
        this.lastStepTime = now;
      }
      this.lastY = y;
    };
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      DeviceMotionEvent.requestPermission().then(() => {
        window.addEventListener('devicemotion', this._handler);
      }).catch(console.error);
    } else {
      window.addEventListener('devicemotion', this._handler);
    }
  },
  stop() {
    this.running = false;
    if (this._handler) window.removeEventListener('devicemotion', this._handler);
    this._handler = null;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. GPS SMOOTHING & FILTERING
// Lightweight 2-axis Kalman Filter + Stationary Detection + Accuracy Gating
// ─────────────────────────────────────────────────────────────────────────────
class KalmanFilter {
  constructor(q = 1e-5, r = 1e-3) {
    this.q = q; // Process noise
    this.r = r; // Measurement noise
    this.reset();
  }
  reset() {
    this.x = [0, 0]; // [position, velocity]
    this.p = [[1, 0], [0, 1]]; // Error covariance
  }
  update(measurement) {
    // Predict
    const F = [[1, 1], [0, 1]];
    this.x = this.matMul(F, this.x);
    this.p = this.matAdd(
      this.matMul(this.matMul(F, this.p), this.transpose(F)),
      [[this.q, 0], [0, this.q]]
    );
    // Update
    const H = [[1, 0]];
    const S = this.matAdd(this.matMul(this.matMul(H, this.p), this.transpose(H)), [[this.r]]);
    const K = this.matMul(this.p, this.transpose(H), 1 / S[0][0]);
    const y = [measurement - this.x[0]];
    this.x = this.matAdd(this.x, this.matMul(K, y));
    this.p = this.matSub(this.p, this.matMul(K, this.matMul(H, this.p)));
    return this.x[0];
  }
  matMul(A, B, scalar = 1) {
    return [[
      (A[0][0] * B[0] + A[0][1] * B[1]) * scalar,
      (A[1][0] * B[0] + A[1][1] * B[1]) * scalar
    ]];
  }
  matAdd(A, B) { return [[A[0][0]+B[0][0], A[0][1]+B[0][1]], [A[1][0]+B[1][0], A[1][1]+B[1][1]]]; }
  matSub(A, B) { return [[A[0][0]-B[0][0], A[0][1]-B[0][1]], [A[1][0]-B[1][0], A[1][1]-B[1][1]]]; }
  transpose(M) { return [[M[0][0], M[1][0]], [M[0][1], M[1][1]]]; }
}

const gpsFilter = {
  latKF: new KalmanFilter(1e-4, 1e-2),
  lngKF: new KalmanFilter(1e-4, 1e-2),
  lastPoint: null,
  stationaryThreshold: 0.00005, // ~5 meters
  process(lat, lng, accuracy, ts) {
    if (accuracy > 35) return null; // Hard gate
    
    const smoothedLat = this.latKF.update(lat);
    const smoothedLng = this.lngKF.update(lng);
    
    // Stationary clamp
    if (this.lastPoint) {
      const dist = this.haversine(this.lastPoint, { lat: smoothedLat, lng: smoothedLng });
      if (dist < this.stationaryThreshold) return { ...this.lastPoint, ts, accuracy };
    }
    
    const point = { lat: smoothedLat, lng: smoothedLng, ts, accuracy };
    this.lastPoint = point;
    return point;
  },
  haversine(c1, c2) {
    const R = 6371;
    const rad = Math.PI / 180;
    const dLat = (c2.lat - c1.lat) * rad;
    const dLng = (c2.lng - c1.lng) * rad;
    const a = Math.sin(dLat/2)**2 + Math.cos(c1.lat*rad)*Math.cos(c2.lat*rad)*Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  },
  reset() {
    this.latKF.reset(); this.lngKF.reset(); this.lastPoint = null;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. STORAGE LAYER (IndexedDB + Crash Recovery)
// ─────────────────────────────────────────────────────────────────────────────
const TrackDB = {
  _db: null,
  DB_NAME: 'TrackForge_v2026',
  async init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.DB_NAME, 2);
      req.onupgradeneeded = e => e.target.result.createObjectStore('sessions', { keyPath: 'id' });
      req.onsuccess = e => { this._db = e.target.result; resolve(); };
      req.onerror = e => reject(e.target.error || new Error('IDB Failed'));
    });
  },
  async save(session) {
    if (!this._db) return;
    return new Promise((resolve, reject) => {
      try {
        const tx = this._db.transaction('sessions', 'readwrite');
        tx.objectStore('sessions').put(session);
        tx.oncomplete = resolve;
        tx.onerror = e => reject(e.target.error);
      } catch (e) { reject(e); }
    });
  },
  async getAll() {
    if (!this._db) throw new Error('DB not initialized');
    return new Promise((resolve, reject) => {
      const req = this._db.transaction('sessions', 'readonly').objectStore('sessions').getAll();
      req.onsuccess = () => resolve(req.result.sort((a,b) => b.id - a.id));
      req.onerror = () => reject(req.error);
    });
  },
  async delete(id) {
    if (!this._db) return;
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction('sessions', 'readwrite');
      tx.objectStore('sessions').delete(id);
      tx.oncomplete = resolve;
      tx.onerror = e => reject(e.target.error);
    });
  },
  persist(session) {
    // Fallback for crash recovery
    localStorage.setItem('tf_session_crash', JSON.stringify({
      ...session,
      path: session.path.slice(-500) // Keep last 500 points to avoid quota limits
    }));
  },
  recoverCrash() {
    const raw = localStorage.getItem('tf_session_crash');
    if (raw) { localStorage.removeItem('tf_session_crash'); return JSON.parse(raw); }
    return null;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. GPS TRACKER (Background-aware, Throttled, Periodic Saves)
// ─────────────────────────────────────────────────────────────────────────────
const GPSTracker = {
  watchId: null,
  wakeLock: null,
  session: null,
  lastSave: Date.now(),
  saveInterval: 5000, // Save to IDB every 5s for marathon resilience
  
  async start(session) {
    this.session = session;
    gpsFilter.reset();
    
    try {
      if ('wakeLock' in navigator) this.wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) {
      console.warn('Wake Lock rejected:', e);
    }
    
    this.watchId = navigator.geolocation.watchPosition(
      p => this.onPosition(p),
      e => this.onError(e),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
    );
  },
  
  onPosition(pos) {
    if (!this.session) return;
    const filtered = gpsFilter.process(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy, Date.now());
    if (!filtered) return;
    
    const prev = this.session.path[this.session.path.length - 1];
    if (prev) {
      const d = gpsFilter.haversine(prev, filtered);
      if (d > 0.002) { // Minimum movement threshold
        this.session.distance += d;
        this.session.path.push(filtered);
      }
    } else {
      this.session.path.push(filtered);
    }
    
    this.session.lastSync = Date.now();
    TrackDB.persist(this.session);
    
    // Periodic durable save
    if (Date.now() - this.lastSave > this.saveInterval) {
      TrackDB.save(this.session).catch(console.error);
      this.lastSave = Date.now();
    }
    
    EventBus.emit('gps:lock', true);
    EventBus.emit('gps:point', { point: filtered, distance: this.session.distance, ts: filtered.ts });
  },
  
  stop(saveFinal = true) {
    if (this.watchId) navigator.geolocation.clearWatch(this.watchId);
    this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
    
    if (saveFinal && this.session?.path.length > 1) {
      TrackDB.save(this.session).catch(console.error);
    }
    this.session = null;
    localStorage.removeItem('tf_session_crash');
  },
  
  onError(err) {
    let msg = 'GPS Error';
    if (err.code === 1) msg = 'Location permission denied';
    else if (err.code === 2) msg = 'Position unavailable';
    else if (err.code === 3) msg = 'GPS timeout';
    EventBus.emit('gps:error', msg);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 5. CANVAS RENDERER (Incremental, DPR-Safe, Memory-Efficient)
// ─────────────────────────────────────────────────────────────────────────────
const CanvasRenderer = {
  canvas: null, ctx: null,
  dpr: 1, width: 0, height: 0,
  projected: [],
  bounds: { minLat: 90, maxLat: -90, minLng: 180, maxLng: -180 },
  padding: 40,
  
  init(el) {
    this.canvas = el;
    this.ctx = el.getContext('2d', { alpha: false });
    this._resizeTimer = null;
    this.resize();
    EventBus.on('gps:point', () => this.draw());
    window.addEventListener('resize', () => {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => this.resize(), 150);
    });
  },
  
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.width = rect.width; this.height = rect.height;
    this.canvas.width = rect.width * this.dpr;
    this.canvas.height = rect.height * this.dpr;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.reproject();
    this.draw();
  },
  
  addPoint(p) {
    this.bounds.minLat = Math.min(this.bounds.minLat, p.lat);
    this.bounds.maxLat = Math.max(this.bounds.maxLat, p.lat);
    this.bounds.minLng = Math.min(this.bounds.minLng, p.lng);
    this.bounds.maxLng = Math.max(this.bounds.maxLng, p.lng);
    this.projected.push(this.toCanvas(p.lat, p.lng));
  },
  
  toCanvas(lat, lng) {
    const latRange = (this.bounds.maxLat - this.bounds.minLat) || 1;
    const lngRange = (this.bounds.maxLng - this.bounds.minLng) || 1;
    return [
      this.padding + (lng - this.bounds.minLng) / lngRange * (this.width - this.padding * 2),
      this.height - (this.padding + (lat - this.bounds.minLat) / latRange * (this.height - this.padding * 2))
    ];
  },
  
  reproject() {
    this.projected = [];
    if (App.session && App.session.path) {
      App.session.path.forEach(p => this.addPoint(p));
    }
  },
  
  draw() {
    if (this.projected.length < 2) return;
    this.ctx.clearRect(0, 0, this.width, this.height);
    
    const path = new Path2D();
    path.moveTo(this.projected[0][0], this.projected[0][1]);
    for (let i = 1; i < this.projected.length; i++) {
      path.lineTo(this.projected[i][0], this.projected[i][1]);
    }
    
    this.ctx.strokeStyle = '#38bdf8';
    this.ctx.lineWidth = 4;
    this.ctx.lineJoin = 'round';
    this.ctx.lineCap = 'round';
    this.ctx.stroke(path);

    // Draw Start Marker
    this.ctx.fillStyle = '#22c55e';
    this.ctx.beginPath();
    this.ctx.arc(this.projected[0][0], this.projected[0][1], 6, 0, Math.PI * 2);
    this.ctx.fill();

    // Draw End Marker
    const last = this.projected[this.projected.length - 1];
    this.ctx.fillStyle = '#ef4444';
    this.ctx.beginPath();
    this.ctx.arc(last[0], last[1], 6, 0, Math.PI * 2);
    this.ctx.fill();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 6. UI CONTROLLER (Zero Direct DOM Manipulation in Core)
// ─────────────────────────────────────────────────────────────────────────────
const UIController = {
  els: {},
  
  init() {
    this.els = {
      btnStart: document.getElementById('btn-start'),
      btnPause: document.getElementById('btn-pause'),
      btnStop: document.getElementById('btn-stop'),
      btnHistory: document.getElementById('btn-history'),
      activeControls: document.getElementById('active-controls'),
      displayTime: document.getElementById('display-time'),
      displayDist: document.getElementById('display-dist'),
      displaySpeed: document.getElementById('display-speed'),
      displaySteps: document.getElementById('display-steps'),
      panelHistory: document.getElementById('panel-history'),
      historyList: document.getElementById('history-list'),
      errorBanner: document.getElementById('error-banner'),
      gpsDot: document.getElementById('gps-indicator'),
      clockDisplay: document.getElementById('clock-display'),
      btnPower: document.getElementById('btn-power-mode'),
      powerOverlay: document.getElementById('power-overlay'),
      powerTime: document.getElementById('power-time'),
      powerDist: document.getElementById('power-dist')
    };
    
    // Real-time clock
    setInterval(() => {
      const d = new Date();
      this.els.clockDisplay.textContent = d.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    }, 1000);
    
    // Bind once
    this.els.btnStart.onclick = () => { Feedback.vibrate(50); EventBus.emit('action:start'); };
    this.els.btnPause.onclick = () => { Feedback.vibrate(50); EventBus.emit('action:togglePause'); };
    this.els.btnPower.onclick = () => {
      this.els.powerOverlay.classList.remove('hidden');
    };
    this.els.powerOverlay.onclick = () => {
      this.els.powerOverlay.classList.add('hidden');
    };
    
    // Hold-to-stop logic
    let stopTimer;
    const startStopTimer = () => {
      Feedback.vibrate(20);
      this.els.btnStop.style.setProperty('--hold-progress', '100%');
      this.els.btnStop.style.transition = 'width 1s linear';
      stopTimer = setTimeout(() => {
        Feedback.vibrate([50, 50, 50]); 
        EventBus.emit('action:stop');
      }, 1000);
    };
    const cancelStopTimer = () => {
      clearTimeout(stopTimer);
      this.els.btnStop.style.setProperty('--hold-progress', '0%');
      this.els.btnStop.style.transition = 'width 0.2s';
    };
    this.els.btnStop.onmousedown = startStopTimer;
    this.els.btnStop.onmouseup = cancelStopTimer;
    this.els.btnStop.onmouseleave = cancelStopTimer;
    this.els.btnStop.ontouchstart = (e) => { e.preventDefault(); startStopTimer(); };
    this.els.btnStop.ontouchend = (e) => { e.preventDefault(); cancelStopTimer(); };
    this.els.btnStop.ontouchcancel = cancelStopTimer;

    this.els.btnHistory.onclick = () => { Feedback.vibrate(20); this.showHistory(true); };
    document.querySelectorAll('.close-panel').forEach(b => b.onclick = () => { Feedback.vibrate(20); this.showHistory(false); });
    
    // Subscribe to core events
    EventBus.on('ui:update', s => this.renderState(s));
    EventBus.on('stats:update', s => this.renderStats(s));
    EventBus.on('gps:error', m => this.showError(m));
    EventBus.on('gps:point', () => {
       this.els.errorBanner?.classList.add('hidden');
       this.els.gpsDot.classList.add('locked');
       this.els.gpsDot.classList.remove('pulse');
    });
    EventBus.on('gps:searching', () => {
       this.els.gpsDot.classList.remove('locked');
       this.els.gpsDot.classList.add('pulse');
    });
  },
  
  renderState(state) {
    const active = state !== State.IDLE;
    this.els.btnStart.classList.toggle('hidden', active);
    this.els.activeControls.classList.toggle('hidden', !active);
    this.els.btnPause.textContent = state === State.PAUSED ? 'RESUME' : 'PAUSE';
  },
  
  renderStats(stats) {
    // Format elapsed time > 24 hours properly
    const s = Math.floor(stats.elapsed / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const timeStr = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
    this.els.displayTime.textContent = timeStr;
    this.els.powerTime.textContent = timeStr;
    
    const distStr = stats.distance.toFixed(2);
    this.els.displayDist.textContent = distStr;
    this.els.powerDist.textContent = `${distStr} KM`;
    
    this.els.displaySteps.textContent = Pedometer.steps.toLocaleString();
    
    // Convert speed (km/h) to pace (min/km)
    if (stats.speed > 0) {
      const paceMin = 60 / stats.speed;
      const pm = Math.floor(paceMin);
      const ps = Math.round((paceMin - pm) * 60);
      this.els.displaySpeed.textContent = `${pm}:${ps.toString().padStart(2, '0')}`;
    } else {
      this.els.displaySpeed.textContent = "--:--";
    }
  },
  
  showError(msg) {
    const banner = this.els.errorBanner;
    if (banner) {
      banner.textContent = msg;
      banner.classList.remove('hidden');
      setTimeout(() => banner.classList.add('hidden'), 5000);
    }
  },
  
  async showHistory(show) {
    this.els.panelHistory.classList.toggle('hidden', !show);
    if (!show) return;
    try {
      const data = await TrackDB.getAll();
      if (data.length === 0) {
         this.els.historyList.innerHTML = `<div style="text-align:center; padding: 40px 20px; color: var(--text-muted);">You have no runs yet!<br><br>Go outside! 🏃‍♂️</div>`;
         return;
      }
      this.els.historyList.innerHTML = '';
      data.forEach(s => {
        const div = document.createElement('div');
        div.className = 'history-item';
        div.id = `hist-${s.id}`;
        div.innerHTML = `
          <div><b>${new Date(s.id).toLocaleDateString()}</b><br><small>${s.distance.toFixed(2)}km</small></div>
          <div>
            <button class="export-gpx">GPX</button>
            <button class="export-csv">CSV</button>
            <button class="del-run" style="background:rgba(239,68,68,0.2); color:#ef4444;">DEL</button>
          </div>
        `;
        div.querySelector('.export-gpx').onclick = () => App.export(s, 'gpx');
        div.querySelector('.export-csv').onclick = () => App.export(s, 'csv');
        div.querySelector('.del-run').onclick = () => App.deleteRun(s.id);
        this.els.historyList.appendChild(div);
      });
    } catch (e) {
      this.showError('Failed to load history');
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 7. APP ORCHESTRATOR (Lifecycle, Error Boundaries, PWA Ready)
// ─────────────────────────────────────────────────────────────────────────────
const App = {
  state: State.IDLE,
  session: null,
  timerId: null,
  startTime: 0,
  pausedAccum: 0,
  
  async init() {
    try {
      await TrackDB.init();
    } catch (e) {
      console.error('Storage init failed:', e);
      UIController.showError('Storage unavailable. Running in memory-only mode.');
    }
    
    CanvasRenderer.init(document.getElementById('map-canvas'));
    UIController.init();
    this.registerLifecycle();
    this.recover();
    
    // Attempt Orientation Lock (Mobile only)
    try {
      if (screen.orientation && screen.orientation.lock) {
        screen.orientation.lock('portrait').catch(() => {});
      }
    } catch(e) {}
    
    // PWA Service Worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./service-worker.js').catch(() => {});
    }
  },
  
  registerLifecycle() {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === State.TRACKING) {
        // Browser will throttle GPS. We keep state intact.
        TrackDB.persist(this.session);
      }
      // Re-acquire WakeLock when returning to tab
      if (!document.hidden && this.state === State.TRACKING) {
        if ('wakeLock' in navigator) {
          navigator.wakeLock.request('screen').then(lock => {
            GPSTracker.wakeLock = lock;
          }).catch(() => {});
        }
      }
    });
    
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: 'TrackForge Workout',
        artist: 'Tracking Active',
        artwork: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }]
      });
      navigator.mediaSession.setActionHandler('play', () => { if(this.state === State.PAUSED) this.togglePause(); });
      navigator.mediaSession.setActionHandler('pause', () => { if(this.state === State.TRACKING) this.togglePause(); });
      navigator.mediaSession.setActionHandler('stop', () => this.stop());
    }
    
    window.addEventListener('beforeunload', (e) => {
      if (this.state === State.TRACKING) { e.preventDefault(); e.returnValue = ''; }
      if (this.state !== State.IDLE) TrackDB.persist(this.session);
    });
  },
  
  async start() {
    if (this.state !== State.IDLE) return;
    
    // Check Permissions proactively
    try {
      if (navigator.permissions) {
        const status = await navigator.permissions.query({name: 'geolocation'});
        if (status.state === 'denied') {
          EventBus.emit('gps:error', 'GPS permission denied. Enable in settings.');
          return;
        }
      }
    } catch (e) {}
    
    this.session = { id: Date.now(), elapsed: 0, distance: 0, path: [], lastSync: Date.now() };
    this.startTime = Date.now();
    this.pausedAccum = 0;
    this.lastMilestone = 0;
    this.zeroSpeedStart = null;
    EventBus.emit('gps:searching');
    Feedback.speak("Tracking started");
    Pedometer.start();
    
    GPSTracker.start(this.session);
    this.state = State.TRACKING;
    this.startTimer();
    this.reprojectPath();
    UIController.els.displayDist.textContent = "0.00";
    UIController.els.displayTime.textContent = "00:00:00";
    UIController.els.displaySpeed.textContent = "--:--";
    EventBus.emit('ui:update', this.state);
  },
  
  togglePause() {
    if (this.state === State.TRACKING) {
      this.state = State.PAUSED;
      this.pausedAccum += Date.now() - this.startTime;
      clearInterval(this.timerId);
      GPSTracker.stop(false); // Keep session in memory
      Feedback.speak("Tracking paused");
      EventBus.emit('ui:update', this.state);
    } else if (this.state === State.PAUSED) {
      this.state = State.TRACKING;
      this.startTime = Date.now();
      this.zeroSpeedStart = null;
      GPSTracker.start(this.session);
      this.startTimer();
      Feedback.speak("Tracking resumed");
      EventBus.emit('ui:update', this.state);
    }
  },
  
  stop() {
    GPSTracker.stop(true);
    clearInterval(this.timerId);
    CanvasRenderer.projected = [];
    CanvasRenderer.bounds = { minLat: 90, maxLat: -90, minLng: 180, maxLng: -180 };
    CanvasRenderer.draw();
    this.state = State.IDLE;
    this.session = null;
    Pedometer.stop();
    Feedback.speak("Session finished and saved");
    EventBus.emit('ui:update', this.state);
    UIController.renderStats({ elapsed: 0, distance: 0, speed: 0 });
  },
  
  startTimer() {
    this.timerId = setInterval(() => {
      if (this.state !== State.TRACKING) return;
      const now = Date.now();
      const elapsed = this.pausedAccum + (now - this.startTime);
      const dist = this.session.distance;
      
      // Calculate current speed (rolling window of last 5 seconds)
      let currentSpeed = 0;
      if (this.session.path.length > 1) {
        const path = this.session.path;
        let recentPoint = null;
        for (let i = path.length - 1; i >= 0; i--) {
          if (now - path[i].ts > 5000) {
            recentPoint = path[i];
            break;
          }
        }
        if (recentPoint) {
          const lastPoint = path[path.length - 1];
          const timeDiff = (lastPoint.ts - recentPoint.ts) / 3600000; // hours
          if (timeDiff > 0) {
            const distDiff = gpsFilter.haversine(recentPoint, lastPoint);
            currentSpeed = distDiff / timeDiff;
          }
        }
        
        // Auto-zero if no new points in 5 seconds
        if (now - path[path.length - 1].ts > 5000) {
          currentSpeed = 0;
        }
      }
      
      // Auto pause if zero speed for 15s
      if (currentSpeed === 0 && this.session.path.length > 1) {
         if (!this.zeroSpeedStart) this.zeroSpeedStart = now;
         else if (now - this.zeroSpeedStart > 15000) {
             this.togglePause();
         }
      } else {
         this.zeroSpeedStart = null;
      }
      
      // Milestone Audio
      const currentMilestone = Math.floor(dist);
      if (currentMilestone > 0 && currentMilestone > this.lastMilestone) {
         this.lastMilestone = currentMilestone;
         Feedback.speak(`Completed ${currentMilestone} kilometers.`);
      }
      
      EventBus.emit('stats:update', { elapsed, distance: dist, speed: currentSpeed });
    }, 1000);
  },
  
  reprojectPath() {
    CanvasRenderer.projected = [];
    CanvasRenderer.bounds = { minLat: 90, maxLat: -90, minLng: 180, maxLng: -180 };
    this.session.path.forEach(p => CanvasRenderer.addPoint(p));
    CanvasRenderer.draw();
  },
  
  recover() {
    const crash = TrackDB.recoverCrash();
    if (crash && crash.path.length > 0) {
      this.session = crash;
      if (this.session.path.length > 0) {
        this.session.path[this.session.path.length - 1].ts = Date.now();
      }
      this.zeroSpeedStart = null;
      this.state = State.PAUSED;
      CanvasRenderer.projected = [];
      CanvasRenderer.bounds = { minLat: 90, maxLat: -90, minLng: 180, maxLng: -180 };
      this.session.path.forEach(p => CanvasRenderer.addPoint(p));
      CanvasRenderer.draw();
      UIController.renderState(this.state);
      UIController.renderStats({ elapsed: this.session.elapsed || 0, distance: this.session.distance, speed: 0 });
    }
  },
  
  export(s, type) {
    let content, mime, ext;
    const escapeXml = unsafe => String(unsafe).replace(/[<>&'"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'}[c]));
    
    if (type === 'gpx') {
      content = `<?xml version="1.0"?><gpx version="1.1" creator="${escapeXml('TrackForge')}">` + 
                `<trk><trkseg>` + s.path.map(p => `<trkpt lat="${p.lat}" lon="${p.lng}"><time>${new Date(p.ts).toISOString()}</time></trkpt>`).join('') +
                `</trkseg></trk></gpx>`;
      mime = 'application/gpx+xml'; ext = 'gpx';
    } else {
      content = "\uFEFFTimestamp,Lat,Lng,Accuracy\n" + s.path.map(p => `${p.ts},${p.lat},${p.lng},${p.accuracy}`).join('\n');
      mime = 'text/csv'; ext = 'csv';
    }
    const b = new Blob([content], { type: mime });
    const u = URL.createObjectURL(b);
    const a = document.createElement('a'); a.href = u; a.download = `trackforge-${s.id}.${ext}`; 
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(u);
  },
  
  async deleteRun(id) {
    if (confirm("Delete this session forever?")) {
      await TrackDB.delete(id);
      document.getElementById(`hist-${id}`)?.remove();
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 8. EVENT ROUTING
// ─────────────────────────────────────────────────────────────────────────────
EventBus.on('action:start', () => App.start());
EventBus.on('action:togglePause', () => App.togglePause());
EventBus.on('action:stop', () => App.stop());

// Initialize
App.init();
