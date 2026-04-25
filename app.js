// TRACKFORGE - Production PWA (Vanilla JS, Local-First, Offline-Capable)
// Features: FSM, Filtered GPS, Delta Timer, IndexedDB, PNG/GPX Export, Theme/Units, A11Y, iOS BG Handling

const APP = {
  state: 'idle',
  session: { start: null, elapsed: 0, dist: 0, speeds: [], elevGain: 0, coords: [], paused: false, last: null },
  db: null, audioCtx: null, analyser: null, rafTimer: null, rafViz: null, gpsWatch: null, isIOS: /iPad|iPhone|iPod/.test(navigator.userAgent),
  units: localStorage.getItem('tf_units') || 'metric',
  theme: localStorage.getItem('tf_theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
  els: {},
  init() {
    this.cacheEls();
    this.applyTheme(this.theme);
    this.applyUnits(this.units);
    this.bindUI();
    this.openDB().then(() => {
      const saved = localStorage.getItem('tf_session');
      if (saved) this.restoreSession(JSON.parse(saved));
      this.setupPWA();
    });
  },
  cacheEls() {
    const ids = ['timer','gps-status','bg-notice','distance','speed','avg-speed','elevation','distance-unit','speed-unit','map-canvas','audio-visualizer','ctrl-primary','ctrl-secondary','ctrl-tertiary','theme-toggle','review-panel','history-panel','settings-panel','history-list','review-notes','review-stats','export-canvas'];
    ids.forEach(id => this.els[id] = document.getElementById(id));
  },
  applyTheme(t) { document.body.dataset.theme = t; localStorage.setItem('tf_theme', t); },
  applyUnits(u) {
    this.units = u; localStorage.setItem('tf_units', u);
    const isM = u === 'imperial';
    this.els['distance-unit'].textContent = isM ? 'mi' : 'km';
    this.els['speed-unit'].textContent = isM ? 'mph' : 'km/h';
    document.querySelector('[data-unit-elev]').textContent = isM ? 'ft ↑' : 'm ↑';
  },
  convert(v, t) { return this.units === 'imperial' ? v * (t==='dist'?0.621371:t==='speed'?0.621371:3.28084) : v; },

  bindUI() {
    document.getElementById('theme-toggle').onclick = () => this.applyTheme(this.theme === 'dark' ? 'light' : 'dark');
    document.getElementById('ctrl-secondary').onclick = () => this.loadHistory();
    document.getElementById('ctrl-tertiary').onclick = () => this.showPanel('settings-panel');
    document.getElementById('btn-back-history').onclick = () => this.hidePanel('history-panel');
    document.getElementById('btn-back-settings').onclick = () => this.hidePanel('settings-panel');
    document.getElementById('btn-toggle-units').onclick = () => this.applyUnits(this.units === 'metric' ? 'imperial' : 'metric');
    document.getElementById('btn-save').onclick = () => this.saveActivity();
    document.getElementById('btn-discard').onclick = () => { localStorage.removeItem('tf_session'); this.resetUI(); this.hidePanel('review-panel'); };
    document.getElementById('btn-export-png').onclick = () => this.exportPNG();
    document.getElementById('btn-export-gpx').onclick = () => this.exportGPX();
    document.getElementById('btn-export-all').onclick = () => this.exportAllData();
    document.getElementById('btn-clear-all').onclick = () => this.clearAllData();

    // Main control button
    this.els['ctrl-primary'].onclick = () => {
      if (this.state === 'idle') this.transition('tracking');
      else if (this.state === 'tracking') { this.session.paused = true; this.updateBtn('PAUSED'); this.transition('paused'); }
      else if (this.state === 'paused') { this.session.paused = false; this.updateBtn('PAUSE'); this.transition('tracking'); }
    };

    // iOS BG handling
    document.addEventListener('visibilitychange', () => {
      const bg = document.hidden;
      if (this.isIOS) {
        if (bg) { if (this.state === 'tracking') this.gpsStop(); }
        else if (this.state === 'tracking') { this.gpsStart(); this.els['bg-notice'].textContent = `Resumed after pause`; setTimeout(()=>this.els['bg-notice'].textContent='', 3000); }
      }
    });
  },

  showPanel(id) { document.querySelectorAll('.panel').forEach(p=>p.classList.add('hidden')); this.els[id].classList.remove('hidden'); },
  hidePanel(id) { this.els[id].classList.add('hidden'); },
  updateBtn(t) { this.els['ctrl-primary'].querySelector('span').textContent = t; },

  transition(to) {
    if (!['idle','tracking','paused','history','settings','review'].includes(to)) return;
    const exit = () => { if (to !== 'tracking') { this.gpsStop(); this.stopTimer(); } };
    const enter = () => {
      if (to === 'tracking') { this.gpsStart(); this.startTimer(); }
      if (to === 'idle') this.resetUI();
    };
    exit(); this.state = to; enter();
  },

  resetUI() {
    this.session = { start: null, elapsed: 0, dist: 0, speeds: [], elevGain: 0, coords: [], paused: false, last: null };
    this.els['timer'].textContent = '00:00:00'; this.updateStats(0,0,0);
    this.updateBtn('START');
    this.drawMap();
  },

  // GPS Layer
  gpsStart() {
    if (!navigator.geolocation) return;
    this.gpsWatch = navigator.geolocation.watchPosition(this.handleGPS.bind(this), this.handleGPSError.bind(this), { enableHighAccuracy: true, timeout: 8000, maximumAge: 1000 });
    this.els['gps-status'].textContent = 'Searching...'; this.els['gps-status'].className = 'status-badge';
  },
  gpsStop() { if (this.gpsWatch) navigator.geolocation.clearWatch(this.gpsWatch); },
  handleGPS(pos) {
    const { latitude, longitude, accuracy, speed, altitude } = pos.coords;
    if (accuracy > 25) return;
    const now = Date.now(), pt = { lat:latitude, lng:longitude, alt:altitude, spd:speed, time:now };
    
    if (this.session.last) {
      const d = this.haversine(this.session.last, pt);
      if (d < 2) return; // jitter filter
      const dt = (now - this.session.last.time)/1000;
      if (dt > 0 && d/dt > 40) return; // jump filter
      this.session.dist += d;
      this.session.elevGain += altitude && this.session.last.alt ? Math.max(0, altitude - this.session.last.alt) : 0;
    }
    this.session.coords.push(pt); this.session.last = pt;
    const rawSpd = pt.spd ? pt.spd * 3.6 : this.session.speeds[this.session.speeds.length-1] || 0;
    this.session.speeds.push(rawSpd * 0.3 + (this.session.speeds[this.session.speeds.length-1] || 0) * 0.7); // EMA
    
    this.els['gps-status'].textContent = 'Locked'; this.els['gps-status'].className = 'status-badge ok';
    this.drawMap();
    this.autoSave();
  },
  handleGPSError(e) { this.els['gps-status'].textContent = 'Lost'; this.els['gps-status'].className = 'status-badge lost'; },
  haversine(a, b) {
    const R = 6371e3, dLat = (b.lat-a.lat)*Math.PI/180, dLon = (b.lng-a.lng)*Math.PI/180;
    const x = Math.sin(dLat/2)**2 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
  },

  // Timer
  startTimer() {
    let last = performance.now();
    const loop = now => {
      if (this.state !== 'tracking' && this.state !== 'paused') return;
      const dt = now - last; last = now;
      if (!this.session.paused) this.session.elapsed += dt;
      const t = Math.floor(this.session.elapsed/1000);
      this.els['timer'].textContent = [Math.floor(t/3600),Math.floor((t%3600)/60),t%60].map(v=>String(v).padStart(2,'0')).join(':');
      this.rafTimer = requestAnimationFrame(loop);
    };
    this.rafTimer = requestAnimationFrame(loop);
  },
  stopTimer() { cancelAnimationFrame(this.rafTimer); },

  updateStats(d, s, a) {
    const f = this.convert.bind(this);
    this.els['distance'].textContent = f(d/1000, 'dist').toFixed(2);
    this.els['speed'].textContent = f(s, 'speed').toFixed(1);
    this.els['avg-speed'].textContent = f(a, 'speed').toFixed(1);
    this.els['elevation'].textContent = Math.round(f(this.session.elevGain, 'elev'));
    const maxD=10, maxS=30;
    this.els['dist-ring'].style.strokeDashoffset = 264 - 264*Math.min(d/1000/maxD, 1);
    this.els['speed-ring'].style.strokeDashoffset = 264 - 264*Math.min(s/maxS, 1);
  },

  drawMap() {
    const c = this.els['map-canvas'], ctx = c.getContext('2d');
    c.width = c.offsetWidth; c.height = c.offsetHeight;
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--surface'); ctx.fillRect(0,0,c.width,c.height);
    if (this.session.coords.length < 2) return;
    let mn={l:90,b:-90,lo:180,la:-180};
    this.session.coords.forEach(p=>{ mn.l=Math.min(mn.l,p.lat); mn.b=Math.max(mn.b,p.lat); mn.lo=Math.min(mn.lo,p.lng); mn.la=Math.max(mn.la,p.lng); });
    const pad=20, w=c.width-pad*2, h=c.height-pad*2;
    ctx.beginPath(); ctx.lineWidth=3; ctx.lineCap='round';
    this.session.coords.forEach((p,i)=>{
      const x=pad+(p.lng-mn.lo)/(mn.la-mn.lo||1)*w, y=pad+(p.lat-mn.l)/(mn.b-mn.l||1)*h;
      i===0?ctx.moveTo(c.width-x,y):ctx.lineTo(c.width-x,y);
    });
    ctx.strokeStyle = '#3b82f6'; ctx.stroke();
    ctx.shadowColor='#3b82f6'; ctx.shadowBlur=10; ctx.stroke(); ctx.shadowBlur=0;
    // markers
    const first=this.session.coords[0], last=this.session.coords[this.session.coords.length-1];
    ctx.fillStyle='#10b981'; ctx.beginPath(); ctx.arc(c.width-(pad+(first.lng-mn.lo)/(mn.la-mn.lo||1)*w), pad+(first.lat-mn.l)/(mn.b-mn.l||1)*h, 4,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#ef4444'; ctx.beginPath(); ctx.arc(c.width-(pad+(last.lng-mn.lo)/(mn.la-mn.lo||1)*w), pad+(last.lat-mn.l)/(mn.b-mn.l||1)*h, 4,0,Math.PI*2); ctx.fill();
  },

  saveActivity() {
    const act = { id:Date.now(), date:new Date().toISOString(), dist:this.session.dist, dur:this.els['timer'].textContent, spd:this.session.speeds[this.session.speeds.length-1]||0, elev:this.session.elevGain, coords:this.compress(this.session.coords), notes:this.els['review-notes'].value };
    this.db.transaction('acts','readwrite').objectStore('acts').add(act).onsuccess = () => {
      localStorage.removeItem('tf_session'); this.resetUI(); this.hidePanel('review-panel'); this.transition('idle');
    };
  },
  compress(pts, tol=0.000008) {
    if (pts.length<=2) return pts;
    const keep=[0], stack=[pts.length-1]; let end=pts.length-1;
    while(stack.length){
      const s=stack.pop(); if(s<=0) break;
      let mx=0,idx=0;
      for(let i=s+1;i<end;i++){ const d=this.perp(pts[i],pts[s],pts[end]); if(d>mx){mx=d;idx=i;} }
      if(mx>tol) stack.push(idx); else { end=s; keep.push(s); }
    }
    return keep.sort((a,b)=>a-b).map(i=>pts[i]);
  },
  perp(p,a,b){ const dx=b.lng-a.lng, dy=b.lat-a.lat, n=Math.abs(dy*p.lng-dx*p.lat+b.lng*a.lat-b.lat*a.lng); return n/Math.hypot(dx,dy); },

  async loadHistory() {
    const tx = this.db.transaction('acts','readonly');
    const req = tx.objectStore('acts').getAll();
    req.onsuccess = () => {
      this.els['history-list'].innerHTML = '';
      req.result.reverse().forEach(a => {
        const li = document.createElement('li');
        li.innerHTML = `<strong>${new Date(a.date).toLocaleDateString()}</strong><br>${this.convert(a.dist/1000,'dist').toFixed(2)} ${this.els['distance-unit'].textContent} • ${a.dur}`;
        li.onclick = () => { this.els['review-notes'].value = a.notes || ''; this.showPanel('review-panel'); };
        this.els['history-list'].appendChild(li);
      });
      this.showPanel('history-panel');
    };
  },

  exportPNG() {
    const c=this.els['export-canvas'], ctx=c.getContext('2d');
    ctx.fillStyle='#0f0f0f'; ctx.fillRect(0,0,c.width,c.height);
    ctx.fillStyle='#fff'; ctx.font='bold 24px system-ui'; ctx.fillText('TrackForge',20,40);
    ctx.font='16px system-ui'; ctx.fillStyle='#94a3b8';
    ctx.fillText(`Distance: ${this.convert(this.session.dist/1000,'dist').toFixed(2)} ${this.els['distance-unit'].textContent}`,20,80);
    ctx.fillText(`Time: ${this.els['timer'].textContent}`,20,110);
    ctx.fillText(`Avg Speed: ${this.convert((this.session.speeds.reduce((a,b)=>a+b,0)/this.session.speeds.length)||0,'speed').toFixed(1)} ${this.els['speed-unit'].textContent}`,20,140);
    if(this.els['review-notes'].value) { ctx.fillText(`"${this.els['review-notes'].value.slice(0,40)}"`,20,180); }
    this.downloadCanvas(c, `trackforge-${Date.now()}.png`, 'image/png');
  },
  exportGPX() {
    let g=`<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1"><trk><trkseg>`;
    this.session.coords.forEach(p => g+=`\n<trkpt lat="${p.lat}" lon="${p.lng}"><ele>${p.alt||0}</ele><time>${new Date(p.time).toISOString()}</time></trkpt>`);
    g+=`\n</trkseg></trk></gpx>`;
    const blob=new Blob([g],{type:'application/gpx+xml'});
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`trackforge-${Date.now()}.gpx`; a.click();
  },
  downloadCanvas(canvas, name, type) {
    const a=document.createElement('a'); a.href=canvas.toDataURL(type); a.download=name; document.body.appendChild(a); a.click(); document.body.removeChild(a);
  },

  async exportAllData() {
    const tx=this.db.transaction('acts','readonly');
    const acts=await tx.objectStore('acts').getAll();
    const blob=new Blob([JSON.stringify({app:'TrackForge',exported:new Date().toISOString(),acts})],{type:'application/json'});
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='trackforge-backup.json'; a.click();
  },
  async clearAllData() {
    if(!confirm('Delete all history & settings?')) return;
    const tx=this.db.transaction('acts','readwrite');
    tx.objectStore('acts').clear();
    localStorage.clear(); location.reload();
  },

  setupPWA() {
    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault(); this.installPrompt = e;
      const btn = document.getElementById('btn-install-pwa'); if(btn) btn.style.display='block';
    });
    document.getElementById('btn-install-pwa')?.addEventListener('click', () => {
      if(this.installPrompt) { this.installPrompt.prompt(); this.installPrompt = null; }
    });
  },
  async openDB() {
    return new Promise(res => {
      const req = indexedDB.open('tf-db', 1);
      req.onupgradeneeded = e => e.target.result.createObjectStore('acts', {keyPath:'id'});
      req.onsuccess = e => { this.db = e.target.result; res(); };
    });
  },
  autoSave() { localStorage.setItem('tf_session', JSON.stringify({state:this.state, elapsed:this.session.elapsed, dist:this.session.dist, coords:this.session.coords, last:this.session.last, elevGain:this.session.elevGain, speeds:this.session.speeds})); },
  restoreSession(s) {
    Object.assign(this.session, s); this.transition(this.state); this.updateStats(this.session.dist, this.session.speeds[this.session.speeds.length-1]||0, this.session.speeds.length?(this.session.speeds.reduce((a,b)=>a+b,0)/this.session.speeds.length):0);
  }
};

document.addEventListener('DOMContentLoaded', () => APP.init());
if ('serviceWorker' in navigator) navigator.serviceWorker.register('service-worker.js');
