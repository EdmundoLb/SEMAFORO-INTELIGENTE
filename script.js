/* =========================================================================
   SEMÁFORO ACÚSTICO — lógica de la interfaz (versión corregida)
   -------------------------------------------------------------------------
   Modos:
   - NORMAL: escucha en tiempo real /lecturas/actual de Firebase (ESP32).
             Si no llegan datos, muestra "Esperando datos" / "Sin señal".
   - DEMO:   abre la página con  ?demo=1  (ej. index.html?demo=1) para
             simular lecturas sin hardware. Los datos demo NO se guardan.
   ========================================================================= */

// ---- 1) CONFIGURACIÓN ----
const firebaseConfig = {
  apiKey: "AIzaSyBN4riU93LOC6h7PZmAu0r7LnHGSXQhcUs",
  authDomain: "semaforo-acustico.firebaseapp.com",
  databaseURL: "https://semaforo-acustico-default-rtdb.firebaseio.com",
  projectId: "semaforo-acustico",
  storageBucket: "semaforo-acustico.firebasestorage.app",
  messagingSenderId: "211203839942",
  appId: "1:211203839942:web:59a1210a7bc5cd2fc244c7",
  measurementId: "G-KQZBK61FFP"
};
// Estructura esperada en Firebase (la que escribe el ESP32):
// /lecturas/actual -> { db: 63.4, timestamp: 1723000000 }
// IMPORTANTE: configura las reglas de la base de datos para que solo se pueda
// LEER públicamente y la escritura quede restringida al ESP32.

const DEMO = new URLSearchParams(location.search).has('demo');

// Umbrales únicos (usados por la clasificación y por el gráfico)
const THRESHOLDS = { yellow: 60, red: 75 };   // verde < 60 · amarillo 60–75 · rojo > 75
const STALE_MS = 30000;                        // sin lecturas por 30 s => "Sin señal"
const MAX_HISTORY = 30;
const CHART = { w: 600, h: 190, pad: 10, minVal: 25, maxVal: 100 };

const COLORS = { green: '#5cff8a', yellow: '#ffd700', red: '#ff5c5c' };
const LABELS = { green: 'Ambiente adecuado', yellow: 'Precaución', red: 'Ruido excesivo' };

const ACTIVITY_PROFILES = {
  grupo:      { base: 58, amplitude: 14, spike: 0.12 },
  exposicion: { base: 42, amplitude: 8,  spike: 0.04 },
  recreo:     { base: 78, amplitude: 12, spike: 0.20 },
};

// ---- 2) ESTADO ----
let currentActivity = 'grupo';
let currentShift = shiftByHour();
let shiftIsManual = false;
let lastReadingAt = 0;
let isLive = false;

const history = [];   // [{ v, t }] para el gráfico

// Acumuladores (no guardan todas las lecturas)
let dayStats = newDayStats();
function newDayStats(){
  return {
    date: todayKey(), count: 0, sum: 0, max: -Infinity, min: Infinity,
    green: 0, yellow: 0, red: 0,
    shifts: { 'mañana': { sum: 0, count: 0 }, 'tarde': { sum: 0, count: 0 } }
  };
}
function todayKey(){
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function shiftByHour(){ return new Date().getHours() < 12 ? 'mañana' : 'tarde'; }

// Persistencia del día (se pierde solo al cambiar de fecha)
const STORAGE_KEY = 'semaforoAcustico.dayStats';
function loadStats(){
  if(DEMO) return;
  try{
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if(saved && saved.date === todayKey()) dayStats = saved;
  }catch(e){ /* sin almacenamiento: se trabaja en memoria */ }
}
function saveStats(){
  if(DEMO) return;
  try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(dayStats)); }catch(e){}
}

// ---- 3) FIREBASE ----
function connectToFirebase(){
  try{
    firebase.initializeApp(firebaseConfig);
    const db = firebase.database();
    db.ref('lecturas/actual').on('value', (snap) => {
      const data = snap.val();
      if(data && typeof data.db === 'number'){
        handleNewReading(data.db);
      }
    }, (err) => {
      console.warn('Firebase rechazó la lectura (¿reglas de seguridad?)', err);
      showOffline('Error de conexión con Firebase');
    });
  }catch(err){
    console.warn('No se pudo conectar a Firebase.', err);
    showOffline('No se pudo conectar a Firebase');
  }
}

// ---- 4) RELOJ ----
function updateClock(){
  const now = new Date();
  document.getElementById('clockTime').textContent = now.toLocaleTimeString('es-PY');
  document.getElementById('clockDate').textContent =
    now.toLocaleDateString('es-PY', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
}

// ---- 5) TURNO Y ACTIVIDAD ----
function setShift(shift, manual){
  currentShift = shift;
  if(manual) shiftIsManual = true;
  [['btnManana','mañana'], ['btnTarde','tarde']].forEach(([id, s]) => {
    const b = document.getElementById(id);
    b.classList.toggle('active', shift === s);
    b.setAttribute('aria-pressed', String(shift === s));
  });
}

function setActivity(activity){
  currentActivity = activity;
  document.querySelectorAll('.activity-btn').forEach(btn => {
    const on = btn.dataset.activity === activity;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
  });
}

// ---- 6) SIMULACIÓN (solo con ?demo=1) ----
function simulateReading(){
  const p = ACTIVITY_PROFILES[currentActivity];
  let value = p.base + (Math.random() - 0.5) * p.amplitude;
  if(Math.random() < p.spike) value += Math.random() * 20;
  value = Math.max(28, Math.min(100, value));
  return Math.round(value * 10) / 10;
}

// ---- 7) PROCESAMIENTO ----
function classify(db){
  if(db < THRESHOLDS.yellow) return 'green';
  if(db <= THRESHOLDS.red) return 'yellow';
  return 'red';
}

function handleNewReading(db){
  const now = Date.now();
  lastReadingAt = now;
  isLive = true;

  // el turno se deduce de la hora, salvo que el docente lo haya elegido
  if(!shiftIsManual && currentShift !== shiftByHour()) setShift(shiftByHour(), false);

  // cambio de día: reinicia estadísticas
  if(dayStats.date !== todayKey()) dayStats = newDayStats();

  history.push({ v: db, t: now });
  if(history.length > MAX_HISTORY) history.shift();

  const level = classify(db);
  dayStats.count++;
  dayStats.sum += db;
  dayStats.max = Math.max(dayStats.max, db);
  dayStats.min = Math.min(dayStats.min, db);
  dayStats[level]++;
  dayStats.shifts[currentShift].sum += db;
  dayStats.shifts[currentShift].count++;
  saveStats();

  renderAll(db, level);
}

// ---- 8) RENDER ----
function renderAll(db, level){
  renderSemaphore(db, level);
  renderThresholdHighlight(level);
  renderStats();
  renderChart();
  renderShiftComparison();
}

function renderSemaphore(db, level){
  const num = document.getElementById('dbNumber');
  num.textContent = db.toFixed(1);
  num.style.color = COLORS[level];
  num.style.textShadow = `0 0 24px ${COLORS[level]}55`;

  document.getElementById('ledRed').classList.toggle('on', level === 'red');
  document.getElementById('ledYellow').classList.toggle('on', level === 'yellow');
  document.getElementById('ledGreen').classList.toggle('on', level === 'green');

  const pill = document.getElementById('statusPill');
  pill.classList.remove('offline');
  pill.textContent = LABELS[level];
  pill.style.background = COLORS[level] + '22';
  pill.style.color = COLORS[level];
  pill.style.border = `1px solid ${COLORS[level]}55`;

  document.getElementById('lastUpdate').textContent =
    (DEMO ? 'Modo demo (datos simulados) · ' : 'Sensor ESP32 en vivo · ') +
    'última lectura ' + new Date().toLocaleTimeString('es-PY');
}

function showOffline(message){
  isLive = false;
  const num = document.getElementById('dbNumber');
  num.textContent = '--';
  num.style.color = 'var(--text-mut)';
  num.style.textShadow = 'none';
  ['ledRed', 'ledYellow', 'ledGreen'].forEach(id => document.getElementById(id).classList.remove('on'));
  ['thRowGreen', 'thRowYellow', 'thRowRed'].forEach(id => document.getElementById(id).classList.remove('active-threshold'));

  const pill = document.getElementById('statusPill');
  pill.classList.add('offline');
  pill.textContent = message;
  pill.style.background = '';
  pill.style.color = '';
  pill.style.border = '';
}

function renderThresholdHighlight(level){
  document.getElementById('thRowGreen').classList.toggle('active-threshold', level === 'green');
  document.getElementById('thRowYellow').classList.toggle('active-threshold', level === 'yellow');
  document.getElementById('thRowRed').classList.toggle('active-threshold', level === 'red');
}

function renderStats(){
  const s = dayStats;
  if(!s.count) return;
  document.getElementById('statAvg').textContent = (s.sum / s.count).toFixed(1);
  document.getElementById('statMax').textContent = s.max.toFixed(1);
  document.getElementById('statMin').textContent = s.min.toFixed(1);
  document.getElementById('statReadings').textContent = s.count;

  const gp = s.green / s.count * 100;
  const yp = s.yellow / s.count * 100;
  const rp = s.red / s.count * 100;
  document.getElementById('barGreen').style.width = gp + '%';
  document.getElementById('barYellow').style.width = yp + '%';
  document.getElementById('barRed').style.width = rp + '%';
  document.getElementById('pctGreen').textContent = gp.toFixed(0) + '%';
  document.getElementById('pctYellow').textContent = yp.toFixed(0) + '%';
  document.getElementById('pctRed').textContent = rp.toFixed(0) + '%';
}

function yFor(v){
  const norm = (v - CHART.minVal) / (CHART.maxVal - CHART.minVal);
  return CHART.h - CHART.pad - norm * (CHART.h - CHART.pad * 2);
}

function renderChart(){
  // líneas guía alineadas con los umbrales reales
  const yRed = yFor(THRESHOLDS.red).toFixed(1);
  const yYellow = yFor(THRESHOLDS.yellow).toFixed(1);
  const lr = document.getElementById('lineRed');
  const ly = document.getElementById('lineYellow');
  lr.setAttribute('y1', yRed);    lr.setAttribute('y2', yRed);
  ly.setAttribute('y1', yYellow); ly.setAttribute('y2', yYellow);

  if(history.length < 2) return;
  const stepX = CHART.w / (MAX_HISTORY - 1);
  const points = history.map((p, i) => `${(i * stepX).toFixed(1)},${yFor(p.v).toFixed(1)}`);

  document.getElementById('chartLine').setAttribute('points', points.join(' '));
  const lastX = ((history.length - 1) * stepX).toFixed(1);
  document.getElementById('chartArea').setAttribute('points',
    [...points, `${lastX},${CHART.h}`, `0,${CHART.h}`].join(' '));

  const secs = Math.round((Date.now() - history[0].t) / 1000);
  document.getElementById('chartOldest').textContent = secs >= 60
    ? 'hace ' + Math.round(secs / 60) + ' min'
    : 'hace ' + secs + ' s';
}

function renderShiftComparison(){
  const m = dayStats.shifts['mañana'];
  const t = dayStats.shifts['tarde'];
  const avgM = m.count ? m.sum / m.count : 0;
  const avgT = t.count ? t.sum / t.count : 0;

  document.getElementById('cmpManana').textContent = avgM.toFixed(1) + ' dB';
  document.getElementById('cmpTarde').textContent = avgT.toFixed(1) + ' dB';
  document.getElementById('barManana').style.width = Math.min(100, avgM) + '%';
  document.getElementById('barTarde').style.width = Math.min(100, avgT) + '%';
}

// ---- 9) INICIO ----
function init(){
  // eventos (sin onclick inline)
  document.querySelectorAll('.shift-btn').forEach(b =>
    b.addEventListener('click', () => setShift(b.dataset.shift, true)));
  document.querySelectorAll('.activity-btn').forEach(b =>
    b.addEventListener('click', () => setActivity(b.dataset.activity)));

  updateClock();
  setInterval(updateClock, 1000);

  setShift(currentShift, false);
  loadStats();
  if(dayStats.count){ renderStats(); renderShiftComparison(); }
  renderChart();

  if(DEMO){
    document.getElementById('lastUpdate').textContent = 'Modo demo · datos simulados';
    setInterval(() => handleNewReading(simulateReading()), 2000);
    handleNewReading(simulateReading());
  }else{
    showOffline('Esperando datos…');
    connectToFirebase();
    // detecta que el ESP32 dejó de enviar
    setInterval(() => {
      if(lastReadingAt && isLive && Date.now() - lastReadingAt > STALE_MS){
        showOffline('Sin señal del sensor');
        document.getElementById('lastUpdate').textContent =
          'Sensor ESP32 · última lectura ' + new Date(lastReadingAt).toLocaleTimeString('es-PY');
      }
    }, 5000);
  }
}

init();
