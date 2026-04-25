"use strict";

const State = { IDLE: 'IDLE', TRACKING: 'TRACKING', PAUSED: 'PAUSED' };
const DB_NAME = 'TrackForge_v2026';

const db = {
    _db: null,
    async init() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 2);
            req.onupgradeneeded = e => e.target.result.createObjectStore('sessions', { keyPath: 'id' });
            req.onsuccess = e => { this._db = e.target.result; resolve(); };
            req.onerror = () => reject(req.error);
        });
    },
    async save(s) {
        const tx = this._db.transaction('sessions', 'readwrite');
        tx.objectStore('sessions').put(s);
        return new Promise(r => tx.oncomplete = r);
    },
    async getAll() {
        return new Promise(r => {
            const req = this._db.transaction('sessions', 'readonly').objectStore('sessions').getAll();
            req.onsuccess = () => r(req.result.sort((a,b) => b.id - a.id));
        });
    }
};

const App = {
    state: State.IDLE, session: null, watchId: null, wakeLock: null, timerId: null,

    async init() {
        this.canvas = document.getElementById('map-canvas');
        this.ctx = this.canvas.getContext('2d');
        await db.init();
        this.bindEvents();
        this.handleResize();
        this.recover();
    },

    bindEvents() {
        document.getElementById('btn-start').onclick = () => this.transition(State.TRACKING);
        document.getElementById('btn-pause').onclick = () => this.state === State.TRACKING ? this.transition(State.PAUSED) : this.transition(State.TRACKING);
        document.getElementById('btn-stop').onclick = () => this.transition(State.IDLE);
        document.getElementById('btn-history').onclick = () => this.uiHistory(true);
        document.querySelectorAll('.close-panel').forEach(b => b.onclick = () => this.uiHistory(false));
        window.onresize = () => this.handleResize();
    },

    async transition(next) {
        if (next === State.TRACKING) {
            if (this.state === State.IDLE) this.session = { id: Date.now(), elapsed: 0, distance: 0, path: [], lastSync: Date.now() };
            this.session.lastSync = Date.now();
            this.timerId = setInterval(() => this.tick(), 1000);
            this.watchId = navigator.geolocation.watchPosition(p => this.gps(p), null, { enableHighAccuracy: true });
            if ('wakeLock' in navigator) this.wakeLock = await navigator.wakeLock.request('screen');
        } else {
            clearInterval(this.timerId);
            navigator.geolocation.clearWatch(this.watchId);
            this.wakeLock?.release();
            if (next === State.IDLE) {
                if (this.session?.path.length > 1) await db.save(this.session);
                localStorage.removeItem('tf_session');
                this.session = null;
                this.resetUI();
            }
        }
        this.state = next;
        this.updateUI();
    },

    gps(pos) {
        const { latitude: lat, longitude: lng, accuracy } = pos.coords;
        if (accuracy > 35) return;
        const p = { lat, lng, ts: Date.now() };
        if (this.session.path.length > 0) {
            const d = this.calc(this.session.path[this.session.path.length-1], p);
            if (d < 0.002) return;
            this.session.distance += d;
        }
        this.session.path.push(p);
        localStorage.setItem('tf_session', JSON.stringify(this.session));
        this.draw();
    },

    tick() {
        const now = Date.now();
        this.session.elapsed += (now - this.session.lastSync);
        this.session.lastSync = now;
        const s = Math.floor(this.session.elapsed / 1000);
        document.getElementById('display-time').textContent = new Date(s * 1000).toISOString().substr(11, 8);
        document.getElementById('display-dist').textContent = this.session.distance.toFixed(2);
        const speed = (this.session.distance / (this.session.elapsed / 3600000)) || 0;
        document.getElementById('display-speed').textContent = speed.toFixed(1);
    },

    calc(c1, c2) {
        const R = 6371;
        const dLat = (c2.lat - c1.lat) * Math.PI / 180;
        const dLng = (c2.lng - c1.lng) * Math.PI / 180;
        const a = Math.sin(dLat/2)**2 + Math.cos(c1.lat*Math.PI/180)*Math.cos(c2.lat*Math.PI/180)*Math.sin(dLng/2)**2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    },

    draw() {
        if (!this.session || this.session.path.length < 2) return;
        const { width: w, height: h } = this.canvas.getBoundingClientRect();
        this.ctx.clearRect(0,0,w,h);
        const lats = this.session.path.map(p => p.lat), lngs = this.session.path.map(p => p.lng);
        const minLat = Math.min(...lats), maxLat = Math.max(...lats), minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
        const pad = 40;
        const mX = (ln) => pad + (ln - minLng) / (maxLng - minLng || 1) * (w - pad * 2);
        const mY = (lt) => h - (pad + (lt - minLat) / (maxLat - minLat || 1) * (h - pad * 2));
        this.ctx.beginPath(); this.ctx.strokeStyle = '#FFD700'; this.ctx.lineWidth = 4; this.ctx.lineJoin = 'round';
        this.session.path.forEach((p, i) => i === 0 ? this.ctx.moveTo(mX(p.lng), mY(p.lat)) : this.ctx.lineTo(mX(p.lng), mY(p.lat)));
        this.ctx.stroke();
    },

    export(s, type) {
        let content, mime, ext;
        if (type === 'gpx') {
            content = `<?xml version="1.0"?><gpx version="1.1" creator="TF">` + 
                      `<trk><trkseg>` + s.path.map(p => `<trkpt lat="${p.lat}" lon="${p.lng}"><time>${new Date(p.ts).toISOString()}</time></trkpt>`).join('') +
                      `</trkseg></trk></gpx>`;
            mime = 'application/gpx+xml'; ext = 'gpx';
        } else {
            content = "Time,Lat,Lng\n" + s.path.map(p => `${p.ts},${p.lat},${p.lng}`).join('\n');
            mime = 'text/csv'; ext = 'csv';
        }
        const b = new Blob([content], { type: mime });
        const u = URL.createObjectURL(b);
        const a = document.createElement('a'); a.href = u; a.download = `track-${s.id}.${ext}`; a.click();
    },

    async uiHistory(show) {
        const p = document.getElementById('panel-history');
        if (!show) return p.classList.add('hidden');
        p.classList.remove('hidden');
        const data = await db.getAll();
        document.getElementById('history-list').innerHTML = data.map(s => `
            <div class="history-item">
                <div><b>${new Date(s.id).toLocaleDateString()}</b><br><small>${s.distance.toFixed(2)}km</small></div>
                <div>
                    <button onclick='App.export(${JSON.stringify(s)}, "gpx")'>GPX</button>
                    <button onclick='App.export(${JSON.stringify(s)}, "csv")'>CSV</button>
                </div>
            </div>`).join('');
    },

    handleResize() {
        const dpr = window.devicePixelRatio || 1;
        const r = this.canvas.getBoundingClientRect();
        this.canvas.width = r.width * dpr; this.canvas.height = r.height * dpr;
        this.ctx.scale(dpr, dpr);
        if (this.session) this.draw();
    },

    recover() {
        const s = localStorage.getItem('tf_session');
        if (s) { this.session = JSON.parse(s); this.transition(State.PAUSED); this.draw(); }
    },

    updateUI() {
        const active = this.state !== State.IDLE;
        document.getElementById('btn-start').classList.toggle('hidden', active);
        document.getElementById('active-controls').classList.toggle('hidden', !active);
        document.getElementById('btn-pause').textContent = this.state === State.PAUSED ? 'RESUME' : 'PAUSE';
    },

    resetUI() {
        document.getElementById('display-time').textContent = "00:00:00";
        document.getElementById('display-dist').textContent = "0.00";
        document.getElementById('display-speed').textContent = "0.0";
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
};

App.init();
