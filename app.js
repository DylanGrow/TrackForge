"use strict";

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
    const dLat = (c2.lat - c1.lat) * Math.PI / 180;
    const dLng = (c2.lng - c1.lng) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(c1.lat*Math.PI/180)*Math.cos(c2.lat*Math.PI/180)*Math.sin(dLng/2)**2;
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
      { enableHighAccuracy: true, maximumAge: 0, timeout: 5000 }
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
    this.resize();
    EventBus.on('gps:point', () => this.draw());
    window.addEventListener('resize', () => this.resize());
  },
  
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.width = rect.width; this.height = rect.height;
    this.canvas.width = rect.width * this.dpr;
    this.canvas.height = rect.height * this.dpr;
    this.ctx.scale(this.dpr, this.dpr);
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
    // Re-project only if we have data (managed by GPSTracker path sync)
  },
  
  draw() {
    if (this.projected.length < 2) return;
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.ctx.beginPath();
    this.ctx.strokeStyle = '#FFD700';
    this.ctx.lineWidth = 3;
    this.ctx.lineJoin = 'round';
    this.ctx.lineCap = 'round';
    
    this.ctx.moveTo(this.projected[0][0], this.projected[0][1]);
    for (let i = 1; i < this.projected.length; i++) {
      this.ctx.lineTo(this.projected[i][0], this.projected[i][1]);
    }
    this.ctx.stroke();
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
      panelHistory: document.getElementById('panel-history'),
      historyList: document.getElementById('history-list'),
      errorBanner: document.getElementById('error-banner')
    };
    
    // Bind once
    this.els.btnStart.onclick = () => EventBus.emit('action:start');
    this.els.btnPause.onclick = () => EventBus.emit('action:togglePause');
    this.els.btnStop.onclick = () => EventBus.emit('action:stop');
    this.els.btnHistory.onclick = () => this.showHistory(true);
    document.querySelectorAll('.close-panel').forEach(b => b.onclick = () => this.showHistory(false));
    
    // Subscribe to core events
    EventBus.on('ui:update', s => this.renderState(s));
    EventBus.on('stats:update', s => this.renderStats(s));
    EventBus.on('gps:error', m => this.showError(m));
    EventBus.on('gps:point', () => this.els.errorBanner?.classList.add('hidden'));
  },
  
  renderState(state) {
    const active = state !== State.IDLE;
    this.els.btnStart.classList.toggle('hidden', active);
    this.els.activeControls.classList.toggle('hidden', !active);
    this.els.btnPause.textContent = state === State.PAUSED ? 'RESUME' : 'PAUSE';
  },
  
  renderStats(stats) {
    this.els.displayTime.textContent = new Date(stats.elapsed).toISOString().substr(11, 8);
    this.els.displayDist.textContent = stats.distance.toFixed(2);
    this.els.displaySpeed.textContent = (stats.speed || 0).toFixed(1);
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
      this.els.historyList.innerHTML = data.map(s => `
        <div class="history-item">
          <div><b>${new Date(s.id).toLocaleDateString()}</b><br><small>${s.distance.toFixed(2)}km</small></div>
          <div>
            <button onclick="App.export(${JSON.stringify(s).replace(/"/g, '&quot;')}, 'gpx')">GPX</button>
            <button onclick="App.export(${JSON.stringify(s).replace(/"/g, '&quot;')}, 'csv')">CSV</button>
          </div>
        </div>
      `).join('');
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
    
    // PWA Service Worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  },
  
  registerLifecycle() {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === State.TRACKING) {
        // Browser will throttle GPS. We keep state intact.
        TrackDB.persist(this.session);
      }
    });
    
    window.addEventListener('beforeunload', () => {
      if (this.state !== State.IDLE) TrackDB.persist(this.session);
    });
  },
  
  start() {
    if (this.state !== State.IDLE) return;
    this.session = { id: Date.now(), elapsed: 0, distance: 0, path: [], lastSync: Date.now() };
    this.startTime = Date.now();
    this.pausedAccum = 0;
    
    GPSTracker.start(this.session);
    this.state = State.TRACKING;
    this.startTimer();
    this.reprojectPath();
    UIController.els.displayDist.textContent = "0.00";
    UIController.els.displayTime.textContent = "00:00:00";
    UIController.els.displaySpeed.textContent = "0.0";
    EventBus.emit('ui:update', this.state);
  },
  
  togglePause() {
    if (this.state === State.TRACKING) {
      this.state = State.PAUSED;
      this.pausedAccum += Date.now() - this.startTime;
      clearInterval(this.timerId);
      GPSTracker.stop(false); // Keep session in memory
      EventBus.emit('ui:update', this.state);
    } else if (this.state === State.PAUSED) {
      this.state = State.TRACKING;
      this.startTime = Date.now();
      GPSTracker.start(this.session);
      this.startTimer();
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
    EventBus.emit('ui:update', this.state);
    UIController.renderStats({ elapsed: 0, distance: 0, speed: 0 });
  },
  
  startTimer() {
    this.timerId = setInterval(() => {
      if (this.state !== State.TRACKING) return;
      const now = Date.now();
      const elapsed = this.pausedAccum + (now - this.startTime);
      const dist = this.session.distance;
      const speed = elapsed > 0 ? (dist / (elapsed / 3600000)) : 0;
      EventBus.emit('stats:update', { elapsed, distance: dist, speed });
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
    const escapeXml = unsafe => unsafe.replace(/[<>&'"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'}[c]));
    
    if (type === 'gpx') {
      content = `<?xml version="1.0"?><gpx version="1.1" creator="TrackForge">` + 
                `<trk><trkseg>` + s.path.map(p => `<trkpt lat="${p.lat}" lon="${p.lng}"><time>${new Date(p.ts).toISOString()}</time></trkpt>`).join('') +
                `</trkseg></trk></gpx>`;
      mime = 'application/gpx+xml'; ext = 'gpx';
    } else {
      content = "Timestamp,Lat,Lng,Accuracy\n" + s.path.map(p => `${p.ts},${p.lat},${p.lng},${p.accuracy}`).join('\n');
      mime = 'text/csv'; ext = 'csv';
    }
    const b = new Blob([content], { type: mime });
    const u = URL.createObjectURL(b);
    const a = document.createElement('a'); a.href = u; a.download = `trackforge-${s.id}.${ext}`; 
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(u);
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
