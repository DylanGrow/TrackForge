# 🗺️ TrackForge

A production-grade, marathon-ready GPS tracking Progressive Web App (PWA) built with **vanilla JavaScript**. Features real-time Kalman-filtered path smoothing, incremental canvas rendering, robust crash recovery, and a fully decoupled event-driven architecture.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![PWA Ready](https://img.shields.io/badge/PWA-Ready-green.svg)](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps)
[![No Frameworks](https://img.shields.io/badge/Dependency-Free-vanilla%20JS-orange.svg)](https://vanilla-js.com/)

---

## ✨ Features

| Capability | Description |
|------------|-------------|
| 📍 **Real-Time GPS Tracking** | High-accuracy `navigator.geolocation` with pause/resume/stop controls |
| 📉 **Kalman Filter Smoothing** | Eliminates GPS jitter & stationary drift without perceptible lag |
| 🎨 **Incremental Canvas Rendering** | Memory-efficient, DPR-aware path drawing that scales to 4+ hour sessions |
| 💾 **Crash-Resilient Storage** | IndexedDB with 5s auto-sync + `localStorage` fallback for process kills |
| 📱 **PWA & Mobile Optimized** | Screen Wake Lock API, visibility change handling, background-aware GPS |
| 📤 **Export Support** | One-click GPX & CSV download with XML/CSV sanitization |
| 🔌 **Zero Dependencies** | Pure ES6+ JavaScript, no bundlers or frameworks required |

---

## 🏗️ Architecture

TrackForge uses a **modular, event-driven architecture** to separate concerns, prevent memory leaks, and ensure testability:

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────────┐
│   UIController  │◄───►│   EventBus   │◄───►│   App (Orch.)   │
└─────────────────┘     └──────────────┘     └────────┬────────┘
        ▲                           ▲                  ▲
        │                           │                  │
┌───────┴────────┐         ┌────────┴──────┐   ┌──────┴───────┐
│ CanvasRenderer │         │  GPSTracker   │   │  KalmanFilter│
└────────────────┘         └───────────────┘   └──────────────┘
        ▲                           ▲
        └───────────────────────────┘
                  TrackDB (IndexedDB + Fallback)
```

### 🔑 Core Modules
| Module | Responsibility |
|--------|----------------|
| `EventBus` | Lightweight pub/sub system decoupling UI from core logic |
| `KalmanFilter` | 2-axis state estimation + stationary clamp for GPS noise |
| `TrackDB` | IndexedDB wrapper with 5s interval sync & crash recovery |
| `GPSTracker` | Position polling, accuracy gating, wake lock, session lifecycle |
| `CanvasRenderer` | Incremental projection, DPR scaling, bounds caching |
| `UIController` | Reactive DOM updates via event subscriptions |
| `App` | State machine orchestration, timer, export, PWA registration |

---

## 🚀 Getting Started

### Prerequisites
- Modern browser with Geolocation & IndexedDB support
- Local HTTPS/localhost server (required for PWA & Wake Lock)

### Quick Setup
```bash
# 1. Clone or create a project directory
mkdir trackforge && cd trackforge

# 2. Place the provided app.js here
touch app.js
# (Paste the refactored JavaScript into app.js)

# 3. Add minimal HTML structure (see below)
touch index.html

# 4. Serve locally
npx serve .  # or python3 -m http.server 8000
```

### Minimal `index.html`
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
  <title>TrackForge</title>
  <link rel="manifest" href="/manifest.json">
  <style>
    :root { --bg: #0f1115; --fg: #e2e8f0; --accent: #FFD700; }
    body { margin: 0; background: var(--bg); color: var(--fg); font-family: system-ui, sans-serif; }
    canvas { width: 100%; height: 70vh; display: block; }
    .controls { display: flex; gap: 10px; padding: 1rem; justify-content: center; }
    button { padding: 12px 20px; background: var(--accent); border: none; border-radius: 8px; font-weight: bold; cursor: pointer; }
    .hidden { display: none !important; }
    #error-banner { background: #ef4444; color: white; text-align: center; padding: 0.5rem; }
  </style>
</head>
<body>
  <div id="error-banner" class="hidden"></div>
  <canvas id="map-canvas"></canvas>
  <div class="controls">
    <button id="btn-start">START</button>
    <div id="active-controls" class="hidden">
      <button id="btn-pause">PAUSE</button>
      <button id="btn-stop">STOP</button>
    </div>
    <button id="btn-history">HISTORY</button>
  </div>
  <div id="display">
    <span id="display-time">00:00:00</span> | 
    <span id="display-dist">0.00</span> km | 
    <span id="display-speed">0.0</span> km/h
  </div>
  <div id="panel-history" class="hidden">
    <div class="close-panel">✕</div>
    <div id="history-list"></div>
  </div>
  <script src="app.js"></script>
</body>
</html>
```

---

## 📊 Technical Deep Dive

### 📉 GPS Filtering Strategy
- **Accuracy Gate:** Drops readings > 35m accuracy
- **2D Kalman Filter:** Smooths `lat`/`lng` independently with `q=1e-4`, `r=1e-2`
- **Stationary Clamp:** Suppresses drift if movement < ~5m between samples
- **Result:** Clean tracks even near tall buildings or when pausing

### 🎨 Incremental Canvas Rendering
- **Bounds Caching:** `minLat`, `maxLat`, `minLng`, `maxLng` expand only when necessary
- **Projection Cache:** `projected[]` array stores pre-calculated canvas coordinates
- **Draw Cycle:** Clears & redraws only cached points (avoids `Math.min/max` per frame)
- **DPR Scaling:** Auto-adapts to `window.devicePixelRatio` for crisp rendering on Retina displays

### 💾 Storage & Crash Recovery
```javascript
// 5s interval durable save
if (Date.now() - lastSave > 5000) {
  TrackDB.save(session);
}

// Immediate crash fallback (last 500 points)
TrackDB.persist(session); // localStorage fallback

// Recovery on next load
const crash = TrackDB.recoverCrash(); // Restores paused session automatically
```

### 🔋 Mobile & Background Behavior
| Event | Handling |
|-------|----------|
| `visibilitychange` | Persists session to `localStorage`, pauses heavy UI updates |
| `beforeunload` | Final fallback save if browser kills tab |
| Wake Lock | Requests screen lock on start, releases on stop/pause |
| GPS Throttling | Maintains state integrity; resumes smoothly when foregrounded |

---

## 📁 File Structure (Recommended)
```
trackforge/
├── index.html          # Entry point
├── app.js              # Core application logic (provided)
├── sw.js               # Service Worker (cache + offline fallback)
├── manifest.json       # PWA configuration
├── assets/
│   └── icon-192.png    # App icon
└── README.md
```

---

## 🧪 Testing Checklist
- [ ] Works on `localhost` & deployed HTTPS
- [ ] GPS permission grants correctly
- [ ] Path smooths without visible jitter
- [ ] Pause/Resume preserves distance & time
- [ ] Background → Foreground resumes tracking
- [ ] GPX/CSV exports open correctly in external apps
- [ ] Session survives tab reload/crash
- [ ] Runs smoothly for 60+ minutes on mobile

---

## 🤝 Contributing
1. Fork the repository
2. Create a feature branch (`git checkout -b feat/kalman-tuning`)
3. Commit changes (`git commit -m 'chore: adjust process noise for urban environments'`)
4. Push & open a Pull Request

*Please ensure all new modules subscribe to `EventBus` patterns and maintain zero direct DOM coupling.*

---

## 📄 License
Distributed under the **MIT License**. See `LICENSE` for details.

---

## 🙏 Acknowledgments
- Haversine formula for geodesic distance
- Standard 2D Kalman Filter implementation adapted for geospatial smoothing
- Mozilla Developer Network for Web APIs & PWA guidelines

*Built for runners, cyclists, and explorers who demand reliability over gimmicks.* 🏃‍♂️🚴‍♀️🌍
