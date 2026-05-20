'use strict';

// ============================================================
//  IoT Backend — Salle Réseau v12.1
//
//  Nouveautés v12.1 :
//    [WS-1] WebSocket Server sur le même port HTTP (3000)
//    [WS-2] Broadcast alertes en temps réel vers Flutter
//    [WS-3] Broadcast live_data à chaque mesure capteur
//    [WS-4] Ping/Pong keepalive toutes les 30 secondes
//    [WS-5] Reconnexion automatique côté client Flutter
// ============================================================

require('dotenv').config();

const crypto  = require('crypto');
const http    = require('http');                              // [WS-1] Nécessaire pour partager le port
const tf      = require('@tensorflow/tfjs');
require('@tensorflow/tfjs-backend-wasm');
const faceapi = require('@vladmandic/face-api/dist/face-api.node-wasm.js');
const canvas  = require('canvas');
const express = require('express');
const cors    = require('cors'); 
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const mqtt    = require('mqtt');
const mongoose = require('mongoose');
const { PolynomialRegression } = require('ml-regression');
const { WebSocketServer, OPEN } = require('ws');             // [WS-1] Import WebSocket
const authRoutes = require('./routes/auth');
const { auth, isAdmin, isAdminOrTech } = require('./config/middleware/authMiddleware');
const chatRoutes = require('./routes/chat');
const rfidRoutes = require('./routes/rfid');
// ─────────────────────────────────────────────
//  CONFIGURATION
// ─────────────────────────────────────────────
const CONFIG = {
  port        : parseInt(process.env.PORT, 10) || 3000,
  mqttHost    : process.env.MQTT_HOST,
  mqttPort    : parseInt(process.env.MQTT_PORT, 10) || 8883,
  mqttUser    : process.env.MQTT_USER,
  mqttPassword: process.env.MQTT_PASSWORD,
  mongoUri    : process.env.MONGO_URI || 'mongodb://localhost:27017/salle_reseau',
  hmacKey     : process.env.MQTT_HMAC_KEY,
  apiKey      : process.env.API_KEY,

  deviceId : 'esp32_01',
  location : 'salle',

  // ESP32-CAM
  camUrl    : process.env.CAM_URL     || 'http://192.168.1.102/capture',
  camTimeout: parseInt(process.env.CAM_TIMEOUT || '7000', 10),

  // Fallback
  fallbackWindowMs: parseInt(process.env.FALLBACK_WINDOW_MS || '1800000', 10),

  // Température (ASHRAE TC 9.9 Classe A1)
  dangerTemp    : parseFloat(process.env.DANGER_TEMP   || '32'),
  dangerReset   : parseFloat(process.env.DANGER_RESET  || '30'),
  warningTemp   : parseFloat(process.env.WARNING_TEMP  || '27'),
  warningReset  : parseFloat(process.env.WARNING_RESET || '26'),
  salleMax      : parseFloat(process.env.SALLE_MAX     || '32'),
  salleWarning  : parseFloat(process.env.SALLE_WARNING || '27'),
  spikeDelta    : parseFloat(process.env.SPIKE_DELTA   || '5'),
  risingSlope   : parseFloat(process.env.RISING_SLOPE  || '0.5'),
  predConfidence: parseFloat(process.env.PRED_CONFIDENCE || '0.65'),

  // Humidité (ASHRAE / TIA-942-B)
  humidityDanger   : parseFloat(process.env.HUMIDITY_DANGER     || '70'),
  humidityDangerLow: parseFloat(process.env.HUMIDITY_DANGER_LOW || '30'),
  humidityMax      : parseFloat(process.env.HUMIDITY_MAX        || '60'),
  humidityMaxReset : parseFloat(process.env.HUMIDITY_MAX_RESET  || '58'),
  humidityMin      : parseFloat(process.env.HUMIDITY_MIN        || '40'),
  humidityMinReset : parseFloat(process.env.HUMIDITY_MIN_RESET  || '42'),
  humidityDebounce : parseInt(process.env.HUMIDITY_DEBOUNCE     || '3', 10),
  humidityWindow   : parseInt(process.env.HUMIDITY_WINDOW       || '5', 10),

  // Gaz (IEC 60079 / EN 54-5)
  gasThreshold : parseInt(process.env.GAS_THRESHOLD   || '1500', 10),
  gasDanger    : parseInt(process.env.GAS_DANGER      || '3000', 10),
  gasRisingRate: parseInt(process.env.GAS_RISING_RATE || '100',  10),
  gasCooldown  : parseInt(process.env.GAS_COOLDOWN    || '60',   10),

  // Condensat (TIA-942-B)
  rainWarnMinutes: parseInt(process.env.RAIN_WARN_MINUTES || '5',  10),
  rainDangMinutes: parseInt(process.env.RAIN_DANG_MINUTES || '15', 10),
  rainDryConfirm : parseInt(process.env.RAIN_DRY_CONFIRM  || '3',  10),

  // Régression polynomiale
  historySize        : parseInt(process.env.HISTORY_SIZE       || '20',     10),
  predictAhead       : parseInt(process.env.PREDICT_AHEAD      || '20',     10),
  readInterval       : parseInt(process.env.READ_INTERVAL      || '5',      10),
  maWindow           : parseInt(process.env.MA_WINDOW          || '5',      10),
  predAlertCooldownMs: parseInt(process.env.PRED_ALERT_COOLDOWN || '120000', 10),

  // Reconnaissance faciale
  faceThreshold    : parseFloat(process.env.FACE_THRESHOLD      || '0.55'),
  faceConfidenceMin: parseFloat(process.env.FACE_CONFIDENCE_MIN || '0.60'),

  // Fichiers
  modelsDir    : path.join(__dirname, 'models'),
  visagesDir   : path.join(__dirname, 'visages_autorises'),
  intrusionsDir: path.join(__dirname, 'photos_intrusions'),
  csvFile      : path.join(__dirname, 'temperature_data.csv'),
  logFile      : path.join(__dirname, 'access_log.json'),

  logLevel: process.env.LOG_LEVEL || 'INFO',
};

if (!CONFIG.hmacKey)  { console.error('[FATAL] MQTT_HMAC_KEY manquant'); process.exit(1); }
if (!CONFIG.apiKey)   { console.error('[FATAL] API_KEY manquant');        process.exit(1); }
if (!CONFIG.mqttHost) { console.error('[FATAL] MQTT_HOST manquant');      process.exit(1); }

const TOPICS = {
  temperature: `iot/${CONFIG.location}/${CONFIG.deviceId}/temperature`,
  humidity   : `iot/${CONFIG.location}/${CONFIG.deviceId}/humidity`,
  gas        : `iot/${CONFIG.location}/${CONFIG.deviceId}/gas`,
  rain       : `iot/${CONFIG.location}/${CONFIG.deviceId}/rain`,
  gasAlert   : `iot/${CONFIG.location}/${CONFIG.deviceId}/gas/alert`,
  rainAlert  : `iot/${CONFIG.location}/${CONFIG.deviceId}/rain/alert`,
  wildcard   : `iot/${CONFIG.location}/${CONFIG.deviceId}/#`,
};

// ─────────────────────────────────────────────
//  LOGGER
// ─────────────────────────────────────────────
const LEVELS  = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const MIN_LVL = LEVELS[CONFIG.logLevel.toUpperCase()] ?? 1;
const CLR     = {
  DEBUG: '\x1b[90m', INFO: '\x1b[37m',
  WARN:  '\x1b[33m', ERROR:'\x1b[31m', RESET:'\x1b[0m',
};

function log(level, message, data = null) {
  if ((LEVELS[level] ?? 0) < MIN_LVL) return;
  const ts  = new Date().toISOString();
  const col = CLR[level] || '';
  console.log(`${col}[${ts}] [${level.padEnd(5)}] ${message}${CLR.RESET}`);
  if (data) console.dir(data, { depth: 3 });
}

// ─────────────────────────────────────────────
//  CANVAS MONKEY-PATCH
// ─────────────────────────────────────────────
const { Canvas, Image, ImageData } = canvas;
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

// ─────────────────────────────────────────────
//  MONGODB — 8 COLLECTIONS
// ─────────────────────────────────────────────
mongoose.connect(CONFIG.mongoUri)
  .then(() => log('INFO', `✅ MongoDB connecté → ${CONFIG.mongoUri}`))
  .catch(err => log('ERROR', `MongoDB erreur : ${err.message}`));

const baseFields = {
  device_id     : { type: String, default: 'esp32_01' },
  location      : { type: String, default: 'salle' },
  classification: { type: String, enum: ['NORMAL', 'WARNING', 'DANGER'], default: 'NORMAL' },
  timestamp     : { type: Date, default: Date.now, index: true },
};

// ── Températures ──────────────────────────────
const tempSchema = new mongoose.Schema({
  ...baseFields,
  temperature     : { type: Number, required: true },
  avg_temp        : Number,
  predicted_temp  : Number,
  minutes_warning : Number,
  minutes_danger  : Number,
  prediction_alert: { type: String, enum: ['NORMAL', 'WARNING', 'DANGER'] },
  pred_confidence : Number,
  reason          : String,
});
tempSchema.index({ classification: 1, timestamp: -1 });
const TempReading = mongoose.model('Temperature', tempSchema, 'temperatures');

// ── Humidités ─────────────────────────────────
const humidSchema = new mongoose.Schema({
  ...baseFields,
  humidity      : { type: Number, required: true },
  avg_humidity  : Number,
  humidity_trend: Number,
  debounce_count: Number,
});
humidSchema.index({ classification: 1, timestamp: -1 });
const HumidReading = mongoose.model('Humidite', humidSchema, 'humidites');

// ── Gaz ───────────────────────────────────────
const gazSchema = new mongoose.Schema({
  ...baseFields,
  adc_raw        : { type: Number, required: true },
  voltage        : Number,
  adc_ema        : Number,
  gas_rising_rate: Number,
  alert_raw      : Boolean,
});
gazSchema.index({ classification: 1, timestamp: -1 });
const GazReading = mongoose.model('Gaz', gazSchema, 'gaz');

// ── Eaux ──────────────────────────────────────
const eauSchema = new mongoose.Schema({
  ...baseFields,
  raining          : { type: Boolean, required: true },
  rain_status      : String,
  rain_duration_min: Number,
  dry_count        : Number,
});
eauSchema.index({ raining: 1, timestamp: -1 });
const EauReading = mongoose.model('Eau', eauSchema, 'eaux');

// ── Alertes ───────────────────────────────────
const alertSchema = new mongoose.Schema({
  device_id    : { type: String, default: 'esp32_01' },
  location     : { type: String, default: 'salle' },
  sensor       : { type: String, enum: ['temperature', 'humidity', 'gas', 'rain', 'visage', 'acces'], required: true },
  niveau       : { type: String, enum: ['INFO', 'WARNING', 'DANGER'], required: true },
  source       : { type: String, enum: ['mesure', 'prediction'], default: 'mesure' },
  message      : { type: String, required: true },
  valeur       : Number,
  seuil        : Number,
  unit         : { type: String, default: null },
  norm_ref     : { type: String, default: null },
  minutes_avant: Number,
  confidence   : Number,
  timestamp    : { type: Date, default: Date.now, index: true },
  resolue      : { type: Boolean, default: false },
  resolue_at   : { type: Date, default: null },
});
alertSchema.index({ niveau: 1, timestamp: -1 });
alertSchema.index({ sensor: 1, timestamp: -1 });
const Alert = mongoose.model('Alert', alertSchema, 'alerts');

// ── Accès ─────────────────────────────────────
const accessSchema = new mongoose.Schema({
  uid            : { type: String,  required: true, index: true },
  authorized     : { type: Boolean, required: true },
  datetime       : String,
  rfid_status    : { type: String, enum: ['autorisé', 'refusé'], default: 'refusé' },
  face_result    : { type: String, enum: ['reconnu', 'inconnu', 'aucun_visage', 'erreur', 'non_analysé'], default: 'non_analysé' },
  face_name      : { type: String, default: null },
  face_confidence: { type: String, default: null },
  decision       : { type: String, enum: ['AUTORISÉ', 'DOUBLE_AUTORISÉ', 'AUTORISÉ_FALLBACK', 'REFUSÉ_RFID', 'REFUSÉ_VISAGE', 'REFUSÉ_FALLBACK'], default: 'REFUSÉ_RFID' },
  fallback       : { type: Boolean, default: false },
  has_photo      : { type: Boolean, default: false },
  timestamp      : { type: Date, default: Date.now, index: true },
});
accessSchema.index({ authorized: 1, timestamp: -1 });
accessSchema.index({ decision:   1, timestamp: -1 });
const Access = mongoose.model('Access', accessSchema, 'accesses');

// ── [ENCODING-1] Encodages faciaux ────────────
const faceEncodingSchema = new mongoose.Schema({
  name        : { type: String, required: true, unique: true, index: true },
  descriptors : { type: [[Number]], required: true },
  image_count : { type: Number, default: 0 },
  last_updated: { type: Date, default: Date.now },
  created_at  : { type: Date, default: Date.now },
});
const FaceEncoding = mongoose.model('FaceEncoding', faceEncodingSchema, 'face_encodings');

// ── [PHOTO-1] Photos d'accès ──────────────────
const accessPhotoSchema = new mongoose.Schema({
  access_id   : { type: mongoose.Schema.Types.ObjectId, ref: 'Access', index: true },
  uid         : { type: String, required: true, index: true },
  face_name   : { type: String, default: null },
  decision    : { type: String, required: true },
  photo_buffer: { type: Buffer, required: true },
  photo_size  : { type: Number, default: 0 },
  mime_type   : { type: String, default: 'image/jpeg' },
  timestamp   : { type: Date, default: Date.now, index: true },
});
accessPhotoSchema.index({ uid: 1, timestamp: -1 });
accessPhotoSchema.index({ decision: 1, timestamp: -1 });
const AccessPhoto = mongoose.model('AccessPhoto', accessPhotoSchema, 'access_photos');

// ─────────────────────────────────────────────
//  ÉTAT EN MÉMOIRE
// ─────────────────────────────────────────────
const tempBuffer = [];
const tempState  = { level: 'NORMAL' };

const humidityState = {
  level        : 'NORMAL',
  debounceCount: 0,
  window       : [],
};

const gasState = {
  lastAlert    : false,
  alertCooldown: 0,
  prevEma      : null,
};

const rainState = {
  raining      : null,
  rainStartTime: null,
  dryCount     : 0,
  lastLevel    : 'NORMAL',
};

const liveData = {
  temperature: null,
  humidity   : null,
  gas        : null,
  rain       : null,
  prediction : null,
  lastUpdate : null,
};

// [FALLBACK] État fallback par UID
const fallbackState = new Map();

let lastPredAlertTs = 0;

// ─────────────────────────────────────────────
//  [WS-1] WEBSOCKET SERVER
//  Même port que Express — partagé via http.Server
// ─────────────────────────────────────────────
let wss = null;   // initialisé dans start()

/**
 * [WS-2] Broadcaster un message JSON à tous les clients WS connectés
 */
function wsBroadcast(message) {
  if (!wss) return;
  const payload = JSON.stringify(message);
  let   count   = 0;
  wss.clients.forEach(client => {
    if (client.readyState === OPEN) {
      client.send(payload);
      count++;
    }
  });
  if (count > 0) log('DEBUG', `[WS] Broadcast → ${count} client(s) | type="${message.type}"`);
}

/**
 * [WS-1] Créer le WebSocketServer attaché au serveur HTTP Express
 */
function createWebSocketServer(httpServer) {
  const server = new WebSocketServer({ server: httpServer });

  server.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    log('INFO', `🔌 [WS] Nouveau client connecté — ${ip}`);

    // Envoyer immédiatement toutes les données live au client qui vient de se connecter
    ws.send(JSON.stringify({ type: 'connected', message: 'WebSocket IoT Salle Réseau v12.1' }));
    ws.send(JSON.stringify({ type: 'live_data',  data: liveData }));

    // [WS-4] Gérer les pings/pongs pour détecter les clients morts
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        // Le client peut demander les données live à tout moment
        if (msg.type === 'get_live_data') {
          ws.send(JSON.stringify({ type: 'live_data', data: liveData }));
        }
      } catch (_) {}
    });

    ws.on('close', () => log('INFO', `🔌 [WS] Client déconnecté — ${ip}`));
    ws.on('error', err => log('ERROR', `[WS] Erreur client : ${err.message}`));
  });

  // [WS-4] Ping/pong keepalive toutes les 30 secondes pour éviter les connexions zombies
  const pingInterval = setInterval(() => {
    server.clients.forEach(ws => {
      if (!ws.isAlive) {
        log('DEBUG', '[WS] Client zombie détecté — fermeture');
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30_000);

  server.on('close', () => clearInterval(pingInterval));

  log('INFO', `✅ [WS] WebSocket Server prêt — ws://0.0.0.0:${CONFIG.port}`);
  return server;
}

// ─────────────────────────────────────────────
//  HMAC-SHA256
// ─────────────────────────────────────────────
function verifyHmac(payload) {
  if (!payload.hmac) {
    log('WARN', '[HMAC] Payload sans signature — rejeté');
    return false;
  }
  const receivedHmac = payload.hmac;
  const { hmac: _, ...dataWithoutHmac } = payload;
  const sorted = Object.keys(dataWithoutHmac).sort().reduce((acc, k) => {
    acc[k] = dataWithoutHmac[k];
    return acc;
  }, {});
  const dataStr      = JSON.stringify(sorted);
  const expectedHmac = crypto
    .createHmac('sha256', CONFIG.hmacKey)
    .update(dataStr)
    .digest('hex');
  try {
    const valid = crypto.timingSafeEqual(
      Buffer.from(receivedHmac, 'hex'),
      Buffer.from(expectedHmac, 'hex')
    );
    if (!valid) log('WARN', '[HMAC] Signature invalide');
    return valid;
  } catch {
    log('WARN', '[HMAC] Format invalide');
    return false;
  }
}

// ─────────────────────────────────────────────
//  MIDDLEWARE API KEY
// ─────────────────────────────────────────────
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key)                  return res.status(401).json({ error: 'API key manquante' });
  if (key !== CONFIG.apiKey) return res.status(403).json({ error: 'API key invalide' });
  next();
}

// ─────────────────────────────────────────────
//  saveAlert — avec broadcast WebSocket [WS-2]
// ─────────────────────────────────────────────
async function saveAlert(sensor, niveau, message, source = 'mesure', valeur = null, seuil = null, minutesAvant = null, confidence = null, unit = null, normRef = null) {
  try {
    const alert = await Alert.create({
      device_id: CONFIG.deviceId, location: CONFIG.location,
      sensor, niveau, source, message, valeur, seuil,
      unit, norm_ref: normRef, minutes_avant: minutesAvant, confidence,
    });

    const icon = niveau === 'DANGER' ? '🚨' : niveau === 'WARNING' ? '⚠️' : 'ℹ️';
    log('WARN', `${icon} ALERT [${niveau}][${sensor}] ${message}`);

    // [WS-2] Broadcaster l'alerte en temps réel à tous les clients Flutter connectés
    wsBroadcast({
      type : 'alert',
      alert: {
        _id          : alert._id.toString(),
        sensor,
        niveau,
        source,
        message,
        valeur       : valeur ?? null,
        seuil        : seuil  ?? null,
        unit         : unit   ?? null,
        minutes_avant: minutesAvant ?? null,
        confidence   : confidence   ?? null,
        timestamp    : alert.timestamp.toISOString(),
      },
    });

  } catch (err) {
    log('ERROR', `saveAlert : ${err.message}`);
  }
}

// ─────────────────────────────────────────────
//  CSV / LOG
// ─────────────────────────────────────────────
function initCSV() {
  if (!fs.existsSync(CONFIG.csvFile)) {
    fs.writeFileSync(CONFIG.csvFile,
      'timestamp,device_id,temperature,avg_temp,classification,' +
      'predicted_temp,minutes_warning,minutes_danger,prediction_alert,confidence\n');
    log('INFO', 'CSV initialisé');
  }
}

function saveToCSV(temperature, avgTemp, classification, predictedTemp, minutesWarning, minutesDanger, predAlert, confidence) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  fs.appendFileSync(CONFIG.csvFile,
    `${ts},${CONFIG.deviceId},${temperature},${avgTemp ?? ''},${classification},` +
    `${predictedTemp ?? ''},${minutesWarning ?? ''},${minutesDanger ?? ''},${predAlert ?? ''},${confidence ?? ''}\n`);
}

function initAccessLog() {
  if (fs.existsSync(CONFIG.logFile))
    log('INFO', 'Ancien access_log.json détecté — nouvelles entrées dans MongoDB uniquement');
}

// ─────────────────────────────────────────────
//  TEMPÉRATURE — CLASSIFICATION
// ─────────────────────────────────────────────
function classifyNow(temperature) {
  if (tempBuffer.length >= 2) {
    const delta = temperature - tempBuffer[tempBuffer.length - 2];
    if (Math.abs(delta) >= CONFIG.spikeDelta) {
      tempState.level = 'DANGER';
      const dir = delta > 0 ? `+${delta.toFixed(1)}` : delta.toFixed(1);
      return { classification: 'DANGER', reason: `Spike thermique ${dir}°C/lecture`, isAlert: true };
    }
  }
  const prev = tempState.level;
  if (prev === 'NORMAL') {
    if      (temperature >= CONFIG.dangerTemp)  tempState.level = 'DANGER';
    else if (temperature >= CONFIG.warningTemp) tempState.level = 'WARNING';
  } else if (prev === 'WARNING') {
    if      (temperature >= CONFIG.dangerTemp)  tempState.level = 'DANGER';
    else if (temperature < CONFIG.warningReset) tempState.level = 'NORMAL';
  } else if (prev === 'DANGER') {
    if      (temperature < CONFIG.warningReset) tempState.level = 'NORMAL';
    else if (temperature < CONFIG.dangerReset)  tempState.level = 'WARNING';
  }
  if (tempState.level === 'NORMAL' && tempBuffer.length >= CONFIG.maWindow) {
    const slice = tempBuffer.slice(-CONFIG.maWindow);
    const slope = (slice[slice.length - 1] - slice[0]) / slice.length;
    if (slope >= CONFIG.risingSlope) {
      return {
        classification: 'WARNING',
        reason        : `Tendance croissante +${slope.toFixed(2)}°C/lecture`,
        isAlert       : prev === 'NORMAL',
      };
    }
  }
  const isAlert = tempState.level !== 'NORMAL' && prev !== tempState.level;
  return { classification: tempState.level, reason: buildTempReason(temperature, tempState.level), isAlert };
}

function buildTempReason(temperature, level) {
  switch (level) {
    case 'WARNING': return `Température ${temperature.toFixed(1)}°C ≥ ${CONFIG.warningTemp}°C — ASHRAE A1 dépassée`;
    case 'DANGER':  return `Température ${temperature.toFixed(1)}°C ≥ ${CONFIG.dangerTemp}°C — limite critique ASHRAE A1`;
    default:        return `Température ${temperature.toFixed(1)}°C — zone normale ASHRAE A1`;
  }
}

// ─────────────────────────────────────────────
//  TEMPÉRATURE — PRÉDICTION POLYNOMIALE
// ─────────────────────────────────────────────
async function predictTemperature(temperature) {
  tempBuffer.push(parseFloat(temperature));
  if (tempBuffer.length > CONFIG.historySize) tempBuffer.shift();

  if (tempBuffer.length < 6) {
    return {
      temperatureActuelle: temperature, temperaturePrediteA20: null,
      minutesAvantWarning: null, minutesAvantDanger: null,
      alerte: 'NORMAL', confidence: 0,
      message  : `⏳ Collecte en cours (${tempBuffer.length}/6)`,
      timestamp: new Date().toLocaleString(),
    };
  }

  const trend = tempBuffer[tempBuffer.length - 1] - tempBuffer[0];
  if (trend <= 0) {
    const result = {
      temperatureActuelle: temperature, temperaturePrediteA20: null,
      minutesAvantWarning: null, minutesAvantDanger: null,
      alerte: 'NORMAL', confidence: 0.95,
      message  : '✅ Tendance stable ou décroissante',
      timestamp: new Date().toLocaleString(),
    };
    liveData.prediction = result;
    return result;
  }

  const x      = tempBuffer.map((_, i) => i);
  const degree = Math.min(2, tempBuffer.length - 1);
  const reg    = new PolynomialRegression(x, tempBuffer, degree);

  const MAX_STEPS    = (60 * 60) / CONFIG.readInterval;
  const stepsAt20min = Math.round((CONFIG.predictAhead * 60) / CONFIG.readInterval);

  let minutesAvantWarning = null;
  let minutesAvantDanger  = null;
  let predictedAt20min    = null;

  for (let step = 1; step <= MAX_STEPS; step++) {
    let predicted = reg.predict(tempBuffer.length - 1 + step);
    predicted     = Math.min(Math.max(predicted, temperature - 2, 10.0), temperature + 25);
    const minutes = +((step * CONFIG.readInterval) / 60).toFixed(1);
    if (step === stepsAt20min)                                    predictedAt20min    = +predicted.toFixed(1);
    if (!minutesAvantWarning && predicted >= CONFIG.salleWarning) minutesAvantWarning = minutes;
    if (!minutesAvantDanger  && predicted >= CONFIG.salleMax)     { minutesAvantDanger = minutes; break; }
  }

  const baseConf        = Math.min(0.95, 0.5 + (tempBuffer.length / CONFIG.historySize) * 0.45);
  const deltas          = tempBuffer.slice(1).map((v, i) => Math.abs(v - tempBuffer[i]));
  const avgVariance     = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const variancePenalty = Math.min(avgVariance / 10, 0.3);
  const confidence      = +(baseConf * (1 - variancePenalty)).toFixed(2);

  const nowMs      = Date.now();
  const cooldownOk = (nowMs - lastPredAlertTs) >= CONFIG.predAlertCooldownMs;

  let alerte  = 'NORMAL';
  let message = '✅ Aucun dépassement prévu dans les 60 prochaines minutes';

  if (minutesAvantDanger !== null && confidence >= CONFIG.predConfidence) {
    alerte  = minutesAvantDanger <= 10 ? 'DANGER' : 'WARNING';
    message = `🚨 Seuil DANGER (${CONFIG.salleMax}°C) dans ${minutesAvantDanger} min (conf=${confidence})`;
    if (cooldownOk) {
      await saveAlert('temperature', alerte, message, 'prediction',
        temperature, CONFIG.salleMax, minutesAvantDanger, confidence, '°C', 'ASHRAE TC 9.9 A1 §6.3');
      lastPredAlertTs = nowMs;
    }
  } else if (minutesAvantWarning !== null && confidence >= CONFIG.predConfidence) {
    alerte  = 'WARNING';
    message = `⚠️ Seuil WARNING (${CONFIG.salleWarning}°C) dans ${minutesAvantWarning} min (conf=${confidence})`;
    if (cooldownOk) {
      await saveAlert('temperature', 'WARNING', message, 'prediction',
        temperature, CONFIG.salleWarning, minutesAvantWarning, confidence, '°C', 'ASHRAE TC 9.9 A1 §6.3');
      lastPredAlertTs = nowMs;
    }
  }

  const result = {
    temperatureActuelle: temperature, temperaturePrediteA20: predictedAt20min,
    minutesAvantWarning, minutesAvantDanger,
    dansMinutes: CONFIG.predictAhead, confidence, alerte, message,
    timestamp  : new Date().toLocaleString(),
  };
  liveData.prediction = result;
  return result;
}

// ─────────────────────────────────────────────
//  HANDLER TEMPÉRATURE — broadcast live [WS-3]
// ─────────────────────────────────────────────
async function handleTemperature(payload) {
  const temperature = parseFloat(payload.temperature);
  if (isNaN(temperature)) { log('WARN', 'temperature invalide'); return; }
  const avgTemp = parseFloat(payload.avg_temp ?? temperature);

  const now     = classifyNow(temperature);
  const predict = await predictTemperature(temperature);

  const icon = { NORMAL: '✅', WARNING: '⚠️', DANGER: '🚨' }[now.classification];
  log('INFO', `${icon} Temp: ${temperature.toFixed(1)}°C | ${now.classification} | Pred: ${predict.alerte}`);

  saveToCSV(temperature, avgTemp, now.classification,
    predict.temperaturePrediteA20, predict.minutesAvantWarning,
    predict.minutesAvantDanger, predict.alerte, predict.confidence);

  await TempReading.create({
    device_id: CONFIG.deviceId, location: CONFIG.location,
    classification  : now.classification,
    temperature, avg_temp: avgTemp,
    predicted_temp  : predict.temperaturePrediteA20,
    minutes_warning : predict.minutesAvantWarning,
    minutes_danger  : predict.minutesAvantDanger,
    prediction_alert: predict.alerte,
    pred_confidence : predict.confidence,
    reason          : now.reason,
  }).catch(err => log('ERROR', `MongoDB temperatures : ${err.message}`));

  if (now.isAlert) {
    const seuil = now.classification === 'DANGER' ? CONFIG.dangerTemp : CONFIG.warningTemp;
    await saveAlert('temperature', now.classification, now.reason, 'mesure',
      temperature, seuil, null, null, '°C', 'ASHRAE TC 9.9 A1 §6.3');
  }

  liveData.temperature = {
    temperature, avg_temp: avgTemp,
    classification: now.classification, reason: now.reason,
    prediction: predict,
  };
  liveData.lastUpdate = new Date().toLocaleString();

  // [WS-3] Broadcaster les données live à chaque mesure capteur
  wsBroadcast({ type: 'live_data', data: liveData });
}

// ─────────────────────────────────────────────
//  HANDLER HUMIDITÉ — broadcast live [WS-3]
// ─────────────────────────────────────────────
async function handleHumidity(payload) {
  const humidity    = parseFloat(payload.humidity);
  const avgHumidity = parseFloat(payload.avg_humidity ?? humidity);
  if (isNaN(humidity)) { log('WARN', 'humidity invalide'); return; }

  humidityState.window.push(humidity);
  if (humidityState.window.length > CONFIG.humidityWindow) humidityState.window.shift();

  const trend = humidityState.window.length >= 3
    ? humidityState.window[humidityState.window.length - 1] - humidityState.window[0]
    : 0;

  let targetLevel = 'NORMAL';
  let riskType    = null;

  if      (humidity > CONFIG.humidityDanger)    { targetLevel = 'DANGER';  riskType = 'condensation'; }
  else if (humidity < CONFIG.humidityDangerLow) { targetLevel = 'DANGER';  riskType = 'esd_severe'; }
  else if (humidity > CONFIG.humidityMax)        { targetLevel = 'WARNING'; riskType = 'warning_haut'; }
  else if (humidity < CONFIG.humidityMin)        { targetLevel = 'WARNING'; riskType = 'warning_bas'; }
  else if (trend > 8)                            { targetLevel = 'WARNING'; riskType = 'tendance'; }

  if (targetLevel !== 'NORMAL') {
    humidityState.debounceCount = Math.min(humidityState.debounceCount + 1, CONFIG.humidityDebounce);
  } else {
    if (humidity <= CONFIG.humidityMaxReset && humidity >= CONFIG.humidityMinReset)
      humidityState.debounceCount = Math.max(0, humidityState.debounceCount - 1);
  }

  const confirmed      = humidityState.debounceCount >= CONFIG.humidityDebounce;
  const classification = confirmed ? targetLevel : 'NORMAL';
  const wasNormal      = humidityState.level === 'NORMAL';

  if (confirmed && wasNormal && riskType) {
    const alertMsg = buildHumidityAlertMessage(humidity, riskType, trend);
    const seuil    =
      riskType === 'condensation' ? CONFIG.humidityDanger    :
      riskType === 'esd_severe'   ? CONFIG.humidityDangerLow :
      riskType === 'warning_haut' ? CONFIG.humidityMax       :
      riskType === 'warning_bas'  ? CONFIG.humidityMin       : CONFIG.humidityMax;
    await saveAlert('humidity', targetLevel, alertMsg, 'mesure',
      humidity, seuil, null, null, '%HR', 'ASHRAE TC 9.9 / TIA-942-B §6.5');
  }

  if (!confirmed && !wasNormal && humidityState.debounceCount === 0) {
    await saveAlert('humidity', 'INFO',
      `✅ Humidité revenue normale : ${humidity.toFixed(1)}%HR`,
      'mesure', humidity, null, null, null, '%HR', 'ASHRAE TC 9.9 A1');
  }

  humidityState.level = classification;

  const icon = { NORMAL: '✅', WARNING: '⚠️', DANGER: '🚨' }[classification];
  log('INFO',
    `${icon} Humid: ${humidity.toFixed(1)}%HR` +
    ` | trend:${trend > 0 ? '+' : ''}${trend.toFixed(1)}%` +
    ` | debounce:${humidityState.debounceCount}/${CONFIG.humidityDebounce}` +
    ` → ${classification}`);

  await HumidReading.create({
    device_id: CONFIG.deviceId, location: CONFIG.location,
    classification, humidity,
    avg_humidity  : avgHumidity,
    humidity_trend: +trend.toFixed(2),
    debounce_count: humidityState.debounceCount,
  }).catch(err => log('ERROR', `MongoDB humidites : ${err.message}`));

  liveData.humidity = {
    humidity, avg_humidity: avgHumidity, classification,
    trend: +trend.toFixed(2), debounce: humidityState.debounceCount, risk_type: riskType,
  };
  liveData.lastUpdate = new Date().toLocaleString();

  // [WS-3] Broadcaster les données live
  wsBroadcast({ type: 'live_data', data: liveData });
}

function buildHumidityAlertMessage(humidity, riskType, trend) {
  switch (riskType) {
    case 'condensation': return `🚨 DANGER humidité : ${humidity.toFixed(1)}%HR > ${CONFIG.humidityDanger}%HR — Risque condensation (TIA-942-B §6.5)`;
    case 'esd_severe':   return `🚨 DANGER humidité basse : ${humidity.toFixed(1)}%HR < ${CONFIG.humidityDangerLow}%HR — Risque ESD sévère`;
    case 'warning_haut': return `⚠️ WARNING humidité élevée : ${humidity.toFixed(1)}%HR > ${CONFIG.humidityMax}%HR`;
    case 'warning_bas':  return `⚠️ WARNING humidité basse : ${humidity.toFixed(1)}%HR < ${CONFIG.humidityMin}%HR`;
    case 'tendance':     return `⚠️ WARNING tendance humidité : +${trend.toFixed(1)}% sur ${CONFIG.humidityWindow} lectures`;
    default:             return `⚠️ WARNING humidité : ${humidity.toFixed(1)}%HR hors zone optimale`;
  }
}

// ─────────────────────────────────────────────
//  HANDLER GAZ — broadcast live [WS-3]
// ─────────────────────────────────────────────
async function handleGas(payload) {
  const adcRaw  = parseInt(payload.adc_raw);
  const voltage = parseFloat(payload.voltage);
  const adcEma  = parseFloat(payload.adc_ema);
  const alert   = payload.alert === true || payload.alert === 'true';
  if (isNaN(adcRaw)) { log('WARN', 'adc_raw invalide'); return; }

  const risingRate     = gasState.prevEma !== null ? +(adcEma - gasState.prevEma).toFixed(1) : 0;
  gasState.prevEma     = adcEma;

  let classification   = 'NORMAL';
  const now            = Date.now();
  const inCooldown     = now < gasState.alertCooldown;

  if      (adcEma >= CONFIG.gasDanger || alert)                              classification = 'DANGER';
  else if (adcEma >= CONFIG.gasThreshold || risingRate >= CONFIG.gasRisingRate) classification = 'WARNING';

  const wasAlert = gasState.lastAlert;

  if (classification === 'DANGER' && !wasAlert) {
    await saveAlert('gas', 'DANGER', buildGasAlertMessage('DANGER', adcEma, adcRaw, risingRate),
      'mesure', adcRaw, CONFIG.gasDanger, null, null, 'ADC', 'IEC 60079 / EN 54-5');
    gasState.lastAlert     = true;
    gasState.alertCooldown = now + CONFIG.gasCooldown * 1000;
  } else if (classification === 'WARNING' && !wasAlert) {
    await saveAlert('gas', 'WARNING', buildGasAlertMessage('WARNING', adcEma, adcRaw, risingRate),
      'mesure', adcRaw, CONFIG.gasThreshold, null, null, 'ADC', 'IEC 60079 / EN 54-5');
  } else if (classification === 'NORMAL' && wasAlert && !inCooldown) {
    await saveAlert('gas', 'INFO',
      `✅ Gaz revenue normale : EMA=${adcEma} ADC`,
      'mesure', adcRaw, null, null, null, 'ADC', 'IEC 60079');
    gasState.lastAlert = false;
  } else if (classification === 'NORMAL' && wasAlert && inCooldown) {
    classification = 'DANGER';
  }

  const icon = { NORMAL: '✅', WARNING: '⚠️', DANGER: '🚨' }[classification];
  log('INFO', `${icon} Gaz: ADC=${adcRaw} | EMA=${adcEma} | rate=${risingRate > 0 ? '+' : ''}${risingRate} → ${classification}`);

  await GazReading.create({
    device_id: CONFIG.deviceId, location: CONFIG.location,
    classification, adc_raw: adcRaw, voltage,
    adc_ema: adcEma, gas_rising_rate: risingRate, alert_raw: alert,
  }).catch(err => log('ERROR', `MongoDB gaz : ${err.message}`));

  liveData.gas        = { adc_raw: adcRaw, voltage, adc_ema: adcEma, rising_rate: risingRate, alert, classification };
  liveData.lastUpdate = new Date().toLocaleString();

  // [WS-3] Broadcaster les données live
  wsBroadcast({ type: 'live_data', data: liveData });
}

function buildGasAlertMessage(level, adcEma, adcRaw, risingRate) {
  const pctSeuil = Math.round((adcEma / CONFIG.gasDanger) * 100);
  if (level === 'DANGER')
    return `🚨 DANGER gaz : EMA=${adcEma} ADC (${pctSeuil}% du seuil critique) — IEC 60079 / EN 54-5`;
  if (risingRate >= CONFIG.gasRisingRate)
    return `⚠️ WARNING gaz — montée rapide : +${risingRate} ADC/lecture, EMA=${adcEma}`;
  return `⚠️ WARNING gaz : EMA=${adcEma} ADC ≥ ${CONFIG.gasThreshold} ADC`;
}

// ─────────────────────────────────────────────
//  HANDLER PLUIE — broadcast live [WS-3]
// ─────────────────────────────────────────────
async function handleRain(payload) {
  const raining    = payload.raining === true || payload.raining === 'true';
  const rainStatus = payload.status ?? (raining ? 'rain' : 'dry');
  const now        = Date.now();

  let classification  = 'NORMAL';
  let rainDurationMin = null;

  if (raining) {
    rainState.dryCount = 0;
    if (!rainState.raining) {
      rainState.raining       = true;
      rainState.rainStartTime = now;
    }
    rainDurationMin = +((now - rainState.rainStartTime) / 60000).toFixed(1);
    classification  = rainDurationMin >= CONFIG.rainDangMinutes ? 'DANGER' : 'WARNING';
  } else {
    if (rainState.raining) {
      rainState.dryCount++;
      if (rainState.dryCount >= CONFIG.rainDryConfirm) {
        rainState.raining       = false;
        rainState.rainStartTime = null;
        rainState.dryCount      = 0;
      } else {
        classification  = 'WARNING';
        rainDurationMin = rainState.rainStartTime
          ? +((now - rainState.rainStartTime) / 60000).toFixed(1) : null;
      }
    }
  }

  const prevLevel = rainState.lastLevel;

  if (raining && prevLevel === 'NORMAL') {
    await saveAlert('rain', 'WARNING',
      `⚠️ Fuite condensat détectée — TIA-942-B §6.6`,
      'mesure', null, null, null, null, 'min', 'TIA-942-B §6.6');
  } else if (raining && rainDurationMin !== null && rainDurationMin >= CONFIG.rainDangMinutes && prevLevel !== 'DANGER') {
    await saveAlert('rain', 'DANGER',
      `🚨 DANGER fuite prolongée : ${rainDurationMin} min — TIA-942-B §6.6`,
      'mesure', rainDurationMin, CONFIG.rainDangMinutes, null, null, 'min', 'TIA-942-B §6.6');
  } else if (!raining && rainState.dryCount === 0 && prevLevel !== 'NORMAL') {
    await saveAlert('rain', 'INFO',
      `✅ Fuite terminée — retour sec confirmé`,
      'mesure', null, null, null, null, 'min', 'TIA-942-B §6.6');
  }

  rainState.lastLevel = classification;

  const icon = { NORMAL: '✅', WARNING: '⚠️', DANGER: '🚨' }[classification];
  log('INFO', `${icon} Eau: ${raining ? 'CONDENSAT' : 'sec'} | ${rainDurationMin ?? '—'}min → ${classification}`);

  await EauReading.create({
    device_id: CONFIG.deviceId, location: CONFIG.location,
    classification, raining,
    rain_status      : rainStatus,
    rain_duration_min: rainDurationMin,
    dry_count        : rainState.dryCount,
  }).catch(err => log('ERROR', `MongoDB eaux : ${err.message}`));

  liveData.rain       = { raining, status: rainStatus, classification, duration_min: rainDurationMin, dry_count: rainState.dryCount };
  liveData.lastUpdate = new Date().toLocaleString();

  // [WS-3] Broadcaster les données live
  wsBroadcast({ type: 'live_data', data: liveData });
}

// ─────────────────────────────────────────────
//  MQTT
// ─────────────────────────────────────────────
function connectMQTT() {
  log('INFO', `🔄 MQTT → mqtts://${CONFIG.mqttHost}:${CONFIG.mqttPort}`);
  const client = mqtt.connect(`mqtts://${CONFIG.mqttHost}:${CONFIG.mqttPort}`, {
    username: CONFIG.mqttUser, password: CONFIG.mqttPassword,
    clientId: `iot-backend-${Math.random().toString(16).slice(2, 8)}`,
    clean: true, reconnectPeriod: 3000, connectTimeout: 10000,
    keepalive: 60, rejectUnauthorized: true,
  });

  client.on('connect', () => {
    log('INFO', '✅ MQTT connecté');
    client.subscribe(TOPICS.wildcard, { qos: 1 }, (err) => {
      if (err) log('ERROR', `Subscribe : ${err.message}`);
      else     log('INFO',  `📡 Abonné à "${TOPICS.wildcard}"`);
    });
  });

  client.on('message', async (topic, rawMsg) => {
    let payload;
    try { payload = JSON.parse(rawMsg.toString()); }
    catch { log('WARN', `JSON invalide [${topic}]`); return; }

    if (!verifyHmac(payload)) {
      log('WARN', `[SEC] Message rejeté [${topic}]`);
      return;
    }

    try {
      if      (topic === TOPICS.temperature) await handleTemperature(payload);
      else if (topic === TOPICS.humidity)    await handleHumidity(payload);
      else if (topic === TOPICS.gas)         await handleGas(payload);
      else if (topic === TOPICS.rain)        await handleRain(payload);
      else if (topic === TOPICS.gasAlert)    log('INFO', `📨 Gas alert : ${JSON.stringify(payload)}`);
      else if (topic === TOPICS.rainAlert)   log('INFO', `📨 Rain alert : ${JSON.stringify(payload)}`);
    } catch (err) {
      log('ERROR', `Handler [${topic}] : ${err.message}`);
    }
  });

  client.on('error',     err => log('ERROR', `MQTT : ${err.message}`));
  client.on('offline',   ()  => log('WARN',  'MQTT hors-ligne...'));
  client.on('reconnect', ()  => log('INFO',  'MQTT reconnexion...'));
  return client;
}

// ─────────────────────────────────────────────
//  FACE-API — chargement modèles TF
// ─────────────────────────────────────────────
async function loadFaceModels() {
  await tf.setBackend('wasm');
  await tf.ready();
  log('INFO', '✅ TensorFlow WASM prêt');
  await faceapi.nets.ssdMobilenetv1.loadFromDisk(CONFIG.modelsDir);
  await faceapi.nets.faceLandmark68Net.loadFromDisk(CONFIG.modelsDir);
  await faceapi.nets.faceRecognitionNet.loadFromDisk(CONFIG.modelsDir);
  log('INFO', '✅ Modèles face-api chargés');
}

// ─────────────────────────────────────────────
//  [ENCODING-2] Charger encodages depuis MongoDB
// ─────────────────────────────────────────────
async function loadEncodingsFromDB() {
  try {
    const docs = await FaceEncoding.find({});
    if (docs.length === 0) return null;

    const labeled = docs.map(doc => {
      const descriptors = doc.descriptors.map(d => new Float32Array(d));
      return new faceapi.LabeledFaceDescriptors(doc.name, descriptors);
    });

    log('INFO', `⚡ [DB] ${labeled.length} encodage(s) chargé(s) depuis MongoDB`);
    return labeled;
  } catch (err) {
    log('ERROR', `loadEncodingsFromDB : ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────
//  Charger visages depuis disque et encoder
// ─────────────────────────────────────────────
async function loadAuthorizedFaces() {
  const labeled = [];
  if (!fs.existsSync(CONFIG.visagesDir)) {
    log('WARN', `⚠️ Dossier visages introuvable : ${CONFIG.visagesDir}`);
    return labeled;
  }

  const persons = fs.readdirSync(CONFIG.visagesDir);
  log('INFO', `📂 ${persons.length} personne(s) dans visages_autorises`);

  for (const person of persons) {
    const personPath = path.join(CONFIG.visagesDir, person);
    if (!fs.lstatSync(personPath).isDirectory()) continue;

    const imgs = fs.readdirSync(personPath).filter(f => /\.(jpg|jpeg|png)$/i.test(f));
    if (imgs.length === 0) { log('WARN', `⚠️ Aucune image pour ${person}`); continue; }

    const descs = [];
    let   errors = 0;

    for (const file of imgs) {
      try {
        const img    = await canvas.loadImage(path.join(personPath, file));
        const detect = await faceapi.detectSingleFace(img).withFaceLandmarks().withFaceDescriptor();
        if (detect) {
          descs.push(detect.descriptor);
        } else {
          log('WARN', `⚠️ Aucun visage dans ${person}/${file}`);
          errors++;
        }
      } catch (e) {
        log('ERROR', `Erreur ${person}/${file} : ${e.message}`);
        errors++;
      }
    }

    if (descs.length > 0) {
      labeled.push(new faceapi.LabeledFaceDescriptors(person, descs));
      log('INFO', `✅ ${person} : ${descs.length}/${imgs.length} image(s)${errors > 0 ? ` (${errors} erreur(s))` : ''}`);
    } else {
      log('WARN', `❌ ${person} : aucun visage valide`);
    }
  }

  log('INFO', `🎭 ${labeled.length} personne(s) chargée(s) depuis disque`);
  return labeled;
}

// ─────────────────────────────────────────────
//  [ENCODING-3] Sauvegarder encodages en MongoDB
// ─────────────────────────────────────────────
async function saveEncodingsToDB(labeledFaces) {
  if (!labeledFaces || labeledFaces.length === 0) return;

  for (const labeled of labeledFaces) {
    const descriptors = labeled.descriptors.map(d => Array.from(d));
    await FaceEncoding.findOneAndUpdate(
      { name: labeled.label },
      {
        name        : labeled.label,
        descriptors,
        image_count : descriptors.length,
        last_updated: new Date(),
      },
      { upsert: true, new: true }
    );
    log('INFO', `💾 [DB] Encodages sauvegardés : ${labeled.label} (${descriptors.length} descripteur(s))`);
  }
}

// ─────────────────────────────────────────────
//  [ENCODING-3] Stratégie de chargement
// ─────────────────────────────────────────────
async function initializeFaceEncodings() {
  const fromDB = await loadEncodingsFromDB();

  const diskPersons = fs.existsSync(CONFIG.visagesDir)
    ? fs.readdirSync(CONFIG.visagesDir)
        .filter(f => fs.lstatSync(path.join(CONFIG.visagesDir, f)).isDirectory())
    : [];

  const dbNames    = fromDB ? fromDB.map(l => l.label) : [];
  const newPersons = diskPersons.filter(p => !dbNames.includes(p));

  if (fromDB && newPersons.length === 0) {
    log('INFO', `⚡ Chargement rapide MongoDB — ${fromDB.length} personne(s), aucune nouvelle sur disque`);
    return fromDB;
  }

  if (fromDB && newPersons.length > 0) {
    log('INFO', `🆕 ${newPersons.length} nouvelle(s) personne(s) sur disque — encodage en cours...`);
    const allLabeled = await loadAuthorizedFaces();
    await saveEncodingsToDB(allLabeled);
    return allLabeled;
  }

  log('INFO', '📂 MongoDB vide — chargement initial depuis disque...');
  const fromDisk = await loadAuthorizedFaces();
  if (fromDisk.length > 0) await saveEncodingsToDB(fromDisk);
  return fromDisk;
}

// ─────────────────────────────────────────────
//  Analyser photo depuis buffer
// ─────────────────────────────────────────────
async function analyzeFaceFromBuffer(buffer, authorizedFaces) {
  if (!authorizedFaces || authorizedFaces.length === 0)
    return { status: 'error', message: 'Base de visages vide' };

  const img       = await canvas.loadImage(buffer);
  const detection = await faceapi
    .detectSingleFace(img)
    .withFaceLandmarks()
    .withFaceDescriptor();

  if (!detection)
    return { status: 'no_face', message: 'Aucun visage détecté' };

  const matcher   = new faceapi.FaceMatcher(authorizedFaces, CONFIG.faceThreshold);
  const match     = matcher.findBestMatch(detection.descriptor);
  const confiance = +((1 - match.distance) * 100).toFixed(1);

  if (match.label !== 'unknown' && confiance >= CONFIG.faceConfidenceMin * 100) {
    log('INFO', `✅ Visage reconnu : ${match.label} (${confiance}% — dist=${match.distance.toFixed(3)})`);
    return {
      status    : 'authorized',
      name      : match.label,
      confidence: `${confiance}%`,
      distance  : match.distance.toFixed(3),
    };
  }

  log('WARN', `❌ Visage inconnu (meilleur : ${match.label} à ${confiance}%)`);
  return {
    status      : 'unauthorized',
    message     : 'Visage non reconnu',
    best_attempt: match.label,
    confidence  : `${confiance}%`,
  };
}

// ─────────────────────────────────────────────
//  Appeler ESP32-CAM
// ─────────────────────────────────────────────
async function fetchCamPhoto() {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), CONFIG.camTimeout);

  try {
    const camResp = await fetch(CONFIG.camUrl, {
      method: 'GET',
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!camResp.ok) throw new Error(`CAM HTTP ${camResp.status}`);

    const camJson = await camResp.json();
    return { success: true, camJson, photoBuffer: null };

  } catch (err) {
    clearTimeout(timer);
    log('WARN', `CAM indisponible : ${err.message}`);
    return { success: false, camJson: null, photoBuffer: null };
  }
}

// ─────────────────────────────────────────────
//  EXPRESS
// ─────────────────────────────────────────────
const app    = express();
// 1️⃣ CORS en premier
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use('/api/auth', authRoutes); 
app.use('/api/chat', chatRoutes); 
app.use('/api/rfid', rfidRoutes);  
app.use((req, _res, next) => { log('DEBUG', `HTTP ${req.method} ${req.path}`); next(); });


// ── Route POST /analyze ──────────────────────
app.post('/analyze', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Aucune photo reçue' });

    log('INFO', `📸 /analyze — photo reçue : ${req.file.size} octets`);

    const result = await analyzeFaceFromBuffer(req.file.buffer, app.locals.authorizedFaces);

    const photoKey = `photo_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    app.locals.pendingPhotos = app.locals.pendingPhotos || new Map();
    app.locals.pendingPhotos.set(photoKey, {
      buffer   : req.file.buffer,
      faceName : result.name || null,
      status   : result.status,
      expiresAt: Date.now() + 30000,
    });

    for (const [k, v] of app.locals.pendingPhotos.entries()) {
      if (Date.now() > v.expiresAt) app.locals.pendingPhotos.delete(k);
    }

    if (result.status === 'unauthorized') {
      try {
        const filename = `intrusion_${Date.now()}.jpg`;
        fs.writeFileSync(path.join(CONFIG.intrusionsDir, filename), req.file.buffer);
        log('WARN', `📁 Photo intrusion disque : ${filename}`);
        result.photo_saved = filename;
      } catch (e) {
        log('ERROR', `Sauvegarde intrusion disque : ${e.message}`);
      }
      await saveAlert('visage', 'DANGER',
        `🚨 Tentative accès — visage non reconnu (meilleur : ${result.best_attempt} à ${result.confidence})`,
        'mesure', null, null, null, null, null, 'TIA-942-B §5.3');
    }

    res.json({ ...result, photo_key: photoKey });

  } catch (err) {
    log('ERROR', `/analyze : ${err.message}`);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── Route POST /access ───────────────────────
app.post('/access', async (req, res) => {
  const { uid, authorized, datetime } = req.body;
  if (!uid) return res.status(400).json({ error: 'UID manquant' });

  const rfidOk = authorized === true || authorized === 'true';
  const now    = Date.now();

  if (!rfidOk) {
    await Access.create({
      uid,
      authorized  : false,
      datetime    : datetime || new Date().toLocaleString(),
      rfid_status : 'refusé',
      face_result : 'non_analysé',
      decision    : 'REFUSÉ_RFID',
      fallback    : false,
      has_photo   : false,
    }).catch(err => log('ERROR', `MongoDB accesses : ${err.message}`));

    await saveAlert('acces', 'WARNING',
      `⚠️ Accès refusé — Badge UID inconnu : ${uid}`,
      'mesure', null, null, null, null, null, 'TIA-942-B §5.3');

    log('INFO', `❌ REFUSÉ_RFID [${uid}]`);
    return res.json({ status: 'ok', decision: 'REFUSÉ_RFID', uid, message: '❌ Badge inconnu' });
  }

  const fb = fallbackState.get(uid);
  if (fb && fb.usedFallback && (now - fb.timestamp) < CONFIG.fallbackWindowMs) {
    log('WARN', `⛔ Fallback déjà consommé pour [${uid}]`);

    await Access.create({
      uid,
      authorized  : true,
      datetime    : datetime || new Date().toLocaleString(),
      rfid_status : 'autorisé',
      face_result : 'non_analysé',
      decision    : 'REFUSÉ_FALLBACK',
      fallback    : true,
      has_photo   : false,
    }).catch(err => log('ERROR', `MongoDB accesses : ${err.message}`));

    await saveAlert('acces', 'DANGER',
      `🚨 Fallback déjà consommé — UID: ${uid}. Accès bloqué. Intervention requise.`,
      'mesure', null, null, null, null, null, 'TIA-942-B §5.3');

    return res.json({
      status  : 'ok',
      decision: 'REFUSÉ_FALLBACK',
      uid,
      message : '❌ Accès unique secours déjà utilisé',
    });
  }

  let faceResult     = 'non_analysé';
  let faceName       = null;
  let faceConfidence = null;
  let decision       = 'AUTORISÉ';
  let usedFallback   = false;
  let photoBuffer    = null;

  const { success, camJson } = await fetchCamPhoto();

  if (!success) {
    usedFallback = true;
    decision     = 'AUTORISÉ_FALLBACK';
    faceResult   = 'non_analysé';

    fallbackState.set(uid, { usedFallback: true, timestamp: now });

    await saveAlert('acces', 'WARNING',
      `⚠️ Accès FALLBACK — CAM hors ligne. UID: ${uid}. Accès unique consommé. Surveillance manuelle requise.`,
      'mesure', null, null, null, null, null, 'TIA-942-B §5.3');

    log('WARN', `⚠️ FALLBACK accordé [${uid}]`);

  } else {
    const status = camJson?.status || 'error';
    faceConfidence = camJson?.confidence || null;

    if (status === 'authorized') {
      faceName   = camJson.name || null;
      faceResult = 'reconnu';
      decision   = 'DOUBLE_AUTORISÉ';
      fallbackState.delete(uid);
      log('INFO', `✅✅ DOUBLE_AUTORISÉ [${uid}] — ${faceName} (${faceConfidence})`);

    } else if (status === 'unauthorized') {
      faceResult = 'inconnu';
      decision   = 'REFUSÉ_VISAGE';
      await saveAlert('acces', 'DANGER',
        `🚨 BADGE OK mais VISAGE REFUSÉ — UID: ${uid}. Possible usurpation de badge !`,
        'mesure', null, null, null, null, null, 'TIA-942-B §5.3');
      log('WARN', `🚨 REFUSÉ_VISAGE [${uid}]`);

    } else if (status === 'no_face') {
      faceResult = 'aucun_visage';
      decision   = 'REFUSÉ_VISAGE';
      await saveAlert('acces', 'WARNING',
        `⚠️ Aucun visage détecté — badge autorisé UID: ${uid}. Accès refusé.`,
        'mesure', null, null, null, null, null, 'TIA-942-B §5.3');
      log('WARN', `⚠️ Aucun visage [${uid}]`);

    } else {
      usedFallback = true;
      decision     = 'AUTORISÉ_FALLBACK';
      faceResult   = 'erreur';
      fallbackState.set(uid, { usedFallback: true, timestamp: now });
      await saveAlert('acces', 'WARNING',
        `⚠️ Erreur analyse IA — FALLBACK accordé pour UID: ${uid}. Accès unique consommé.`,
        'mesure', null, null, null, null, null, 'TIA-942-B §5.3');
      log('WARN', `⚠️ Erreur IA — FALLBACK [${uid}]`);
    }
  }

  if (app.locals.pendingPhotos) {
    for (const [key, pending] of app.locals.pendingPhotos.entries()) {
      if (Date.now() <= pending.expiresAt) {
        photoBuffer = pending.buffer;
        app.locals.pendingPhotos.delete(key);
        log('INFO', `📷 Photo récupérée depuis pendingPhotos pour [${uid}]`);
        break;
      }
    }
  }

  const accessDoc = await Access.create({
    uid,
    authorized     : true,
    datetime       : datetime || new Date().toLocaleString(),
    rfid_status    : 'autorisé',
    face_result    : faceResult,
    face_name      : faceName,
    face_confidence: faceConfidence,
    decision,
    fallback       : usedFallback,
    has_photo      : photoBuffer !== null,
  }).catch(err => { log('ERROR', `MongoDB accesses : ${err.message}`); return null; });

  if (photoBuffer && accessDoc) {
    try {
      await AccessPhoto.create({
        access_id   : accessDoc._id,
        uid,
        face_name   : faceName,
        decision,
        photo_buffer: photoBuffer,
        photo_size  : photoBuffer.length,
        mime_type   : 'image/jpeg',
      });
      log('INFO', `📷 [DB] Photo stockée — access_id: ${accessDoc._id} | ${photoBuffer.length} octets`);
    } catch (err) {
      log('ERROR', `Stockage photo MongoDB : ${err.message}`);
    }
  }

  const icons = {
    'DOUBLE_AUTORISÉ'   : '✅✅',
    'AUTORISÉ'          : '✅',
    'AUTORISÉ_FALLBACK' : '⚠️',
    'REFUSÉ_VISAGE'     : '❌',
    'REFUSÉ_RFID'       : '❌',
    'REFUSÉ_FALLBACK'   : '⛔',
  };

  const accessGranted = ['DOUBLE_AUTORISÉ', 'AUTORISÉ', 'AUTORISÉ_FALLBACK'].includes(decision);
  log('INFO', `${icons[decision] || '❌'} [${uid}] → ${decision} | Visage: ${faceResult} | Photo: ${photoBuffer ? 'oui' : 'non'}`);

  res.json({
    status   : 'ok',
    decision,
    name     : faceName,
    uid,
    fallback : usedFallback,
    message  : accessGranted ? `✅ Accès accordé — ${decision}` : '❌ Accès refusé',
    timestamp: new Date().toISOString(),
  });
});

// ── Routes données temps réel ────────────────
app.get('/donnees',    (req, res) => res.json(liveData));
app.get('/prediction', (req, res) => res.json(liveData.prediction || { message: 'En attente...' }));

// ── Route status complète ─────────────────────
app.get('/status', (req, res) => res.json({
  status     : 'running',
  version    : 'v12.1',
  uptime     : Math.round(process.uptime()) + 's',
  device     : CONFIG.deviceId,
  location   : CONFIG.location,
  topics     : TOPICS,
  bufferSize : tempBuffer.length,
  websocket  : {                                              // [WS-1] Info WS dans /status
    enabled : true,
    url     : `ws://0.0.0.0:${CONFIG.port}`,
    clients : wss ? wss.clients.size : 0,
  },
  collections: ['temperatures', 'humidites', 'gaz', 'eaux', 'alerts', 'accesses', 'face_encodings', 'access_photos'],
  normes: {
    temperature: 'ASHRAE TC 9.9 Classe A1 §6.3',
    humidite   : 'ASHRAE TC 9.9 / ANSI/TIA-942-B §6.5',
    gaz        : 'IEC 60079 / EN 54-5',
    condensat  : 'TIA-942-B §6.6',
    acces      : 'TIA-942-B §5.3',
  },
  seuils: {
    temperature: { normal: `< ${CONFIG.warningTemp}°C`, warning: `${CONFIG.warningTemp}–${CONFIG.dangerTemp}°C`, danger: `≥ ${CONFIG.dangerTemp}°C` },
    humidite   : { normal: `${CONFIG.humidityMin}–${CONFIG.humidityMax}%HR`, danger_haut: `> ${CONFIG.humidityDanger}%HR`, danger_bas: `< ${CONFIG.humidityDangerLow}%HR` },
    gaz        : { normal: `< ${CONFIG.gasThreshold} ADC`, warning: `${CONFIG.gasThreshold}–${CONFIG.gasDanger} ADC`, danger: `≥ ${CONFIG.gasDanger} ADC` },
    condensat  : { warning: 'Dès la 1ère détection', danger: `≥ ${CONFIG.rainDangMinutes} min` },
  },
  reconnaissance_faciale: {
    personnes_autorisees: app.locals.authorizedFaces?.length ?? 0,
    seuil_distance      : CONFIG.faceThreshold,
    confiance_min       : `${CONFIG.faceConfidenceMin * 100}%`,
    dossier             : CONFIG.visagesDir,
    intrusions_dir      : CONFIG.intrusionsDir,
  },
  fallback: {
    uids_en_fallback: fallbackState.size,
    fenetre_ms      : CONFIG.fallbackWindowMs,
  },
  security: { hmacEnabled: true, apiKeyRequired: '/db/* et /logs', tlsMqtt: true },
  states: {
    temperature: { level: tempState.level },
    humidity   : { level: humidityState.level, debounce: humidityState.debounceCount },
    gas        : { lastAlert: gasState.lastAlert, cooldownMs: Math.max(0, gasState.alertCooldown - Date.now()) },
    rain       : { raining: rainState.raining, dryCount: rainState.dryCount },
  },
  liveData,
}));

// ── Routes protégées ─────────────────────────
app.get('/logs', requireApiKey, async (req, res) => {
  try {
    const logs = await Access.find().sort({ timestamp: -1 }).limit(20);
    res.json({ total: await Access.countDocuments(), logs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Températures
app.get('/db/temperatures',             requireApiKey, async (_, res) => { try { res.json(await TempReading.find().sort({ timestamp: -1 }).limit(50)); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/db/temperatures/anomalies',   requireApiKey, async (_, res) => { try { res.json(await TempReading.find({ classification: { $ne: 'NORMAL' } }).sort({ timestamp: -1 }).limit(50)); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/db/temperatures/danger',      requireApiKey, async (_, res) => { try { res.json(await TempReading.find({ classification: 'DANGER'  }).sort({ timestamp: -1 }).limit(50)); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/db/temperatures/warning',     requireApiKey, async (_, res) => { try { res.json(await TempReading.find({ classification: 'WARNING' }).sort({ timestamp: -1 }).limit(50)); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/db/temperatures/predictions', requireApiKey, async (_, res) => { try { res.json(await TempReading.find({ prediction_alert: { $ne: 'NORMAL' } }).sort({ timestamp: -1 }).limit(50)); } catch (e) { res.status(500).json({ error: e.message }); } });

// Humidités
app.get('/db/humidites',           requireApiKey, async (_, res) => { try { res.json(await HumidReading.find().sort({ timestamp: -1 }).limit(50)); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/db/humidites/anomalies', requireApiKey, async (_, res) => { try { res.json(await HumidReading.find({ classification: { $ne: 'NORMAL' } }).sort({ timestamp: -1 }).limit(50)); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/db/humidites/danger',    requireApiKey, async (_, res) => { try { res.json(await HumidReading.find({ classification: 'DANGER'  }).sort({ timestamp: -1 }).limit(50)); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/db/humidites/warning',   requireApiKey, async (_, res) => { try { res.json(await HumidReading.find({ classification: 'WARNING' }).sort({ timestamp: -1 }).limit(50)); } catch (e) { res.status(500).json({ error: e.message }); } });

// Gaz
app.get('/db/gaz',           requireApiKey, async (_, res) => { try { res.json(await GazReading.find().sort({ timestamp: -1 }).limit(50)); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/db/gaz/anomalies', requireApiKey, async (_, res) => { try { res.json(await GazReading.find({ classification: { $ne: 'NORMAL' } }).sort({ timestamp: -1 }).limit(50)); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/db/gaz/danger',    requireApiKey, async (_, res) => { try { res.json(await GazReading.find({ classification: 'DANGER'  }).sort({ timestamp: -1 }).limit(50)); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/db/gaz/warning',   requireApiKey, async (_, res) => { try { res.json(await GazReading.find({ classification: 'WARNING' }).sort({ timestamp: -1 }).limit(50)); } catch (e) { res.status(500).json({ error: e.message }); } });

// Eaux
app.get('/db/eaux',           requireApiKey, async (_, res) => { try { res.json(await EauReading.find().sort({ timestamp: -1 }).limit(50)); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/db/eaux/anomalies', requireApiKey, async (_, res) => { try { res.json(await EauReading.find({ classification: { $ne: 'NORMAL' } }).sort({ timestamp: -1 }).limit(50)); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/db/eaux/danger',    requireApiKey, async (_, res) => { try { res.json(await EauReading.find({ classification: 'DANGER'  }).sort({ timestamp: -1 }).limit(50)); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/db/eaux/warning',   requireApiKey, async (_, res) => { try { res.json(await EauReading.find({ classification: 'WARNING' }).sort({ timestamp: -1 }).limit(50)); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/db/eaux/pluie',     requireApiKey, async (_, res) => { try { res.json(await EauReading.find({ raining: true }).sort({ timestamp: -1 }).limit(50)); } catch (e) { res.status(500).json({ error: e.message }); } });

// Alertes
app.get('/db/alerts',            requireApiKey, async (_, res)   => { try { res.json(await Alert.find().sort({ timestamp: -1 }).limit(50)); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/db/alerts/danger',     requireApiKey, async (_, res)   => { try { res.json(await Alert.find({ niveau: 'DANGER'     }).sort({ timestamp: -1 }).limit(50)); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/db/alerts/warning',    requireApiKey, async (_, res)   => { try { res.json(await Alert.find({ niveau: 'WARNING'    }).sort({ timestamp: -1 }).limit(50)); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/db/alerts/info',       requireApiKey, async (_, res)   => { try { res.json(await Alert.find({ niveau: 'INFO'       }).sort({ timestamp: -1 }).limit(50)); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/db/alerts/mesure',     requireApiKey, async (_, res)   => { try { res.json(await Alert.find({ source: 'mesure'     }).sort({ timestamp: -1 }).limit(50)); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/db/alerts/prediction', requireApiKey, async (_, res)   => { try { res.json(await Alert.find({ source: 'prediction' }).sort({ timestamp: -1 }).limit(50)); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/db/alerts/:sensor',    requireApiKey, async (req, res) => { try { res.json(await Alert.find({ sensor: req.params.sensor }).sort({ timestamp: -1 }).limit(50)); } catch (e) { res.status(500).json({ error: e.message }); } });

// Accès
app.get('/db/accesses',               requireApiKey, async (_, res) => { try { res.json(await Access.find().sort({ timestamp: -1 }).limit(50)); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/db/accesses/autorises',     requireApiKey, async (_, res) => { try { res.json(await Access.find({ authorized: true  }).sort({ timestamp: -1 }).limit(50)); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/db/accesses/refuses',       requireApiKey, async (_, res) => { try { res.json(await Access.find({ authorized: false }).sort({ timestamp: -1 }).limit(50)); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/db/accesses/double',        requireApiKey, async (_, res) => { try { res.json(await Access.find({ decision: 'DOUBLE_AUTORISÉ'  }).sort({ timestamp: -1 }).limit(50)); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/db/accesses/fallback',      requireApiKey, async (_, res) => { try { res.json(await Access.find({ fallback: true              }).sort({ timestamp: -1 }).limit(50)); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/db/accesses/visage-refuse', requireApiKey, async (_, res) => { try { res.json(await Access.find({ decision: 'REFUSÉ_VISAGE'   }).sort({ timestamp: -1 }).limit(50)); } catch (e) { res.status(500).json({ error: e.message }); } });

// Photos
app.get('/db/photos', requireApiKey, async (_, res) => {
  try {
    const photos = await AccessPhoto.find({}, { photo_buffer: 0 }).sort({ timestamp: -1 }).limit(50);
    res.json(photos);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/db/photos/:access_id', requireApiKey, async (req, res) => {
  try {
    const photo = await AccessPhoto.findOne({ access_id: req.params.access_id });
    if (!photo) return res.status(404).json({ error: 'Photo non trouvée' });
    res.set('Content-Type', photo.mime_type);
    res.set('Content-Disposition', `inline; filename="access_${photo.access_id}.jpg"`);
    res.send(photo.photo_buffer);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/db/photos/uid/:uid', requireApiKey, async (req, res) => {
  try {
    const photos = await AccessPhoto.find({ uid: req.params.uid }, { photo_buffer: 0 }).sort({ timestamp: -1 }).limit(20);
    res.json(photos);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Encodages faciaux
app.get('/db/encodings', requireApiKey, async (_, res) => {
  try {
    const encs = await FaceEncoding.find({}, { descriptors: 0 });
    res.json(encs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/faces/reload', requireApiKey, async (_, res) => {
  try {
    log('INFO', '🔄 Rechargement forcé encodages depuis disque...');
    const labeled = await loadAuthorizedFaces();
    if (labeled.length > 0) {
      await saveEncodingsToDB(labeled);
      app.locals.authorizedFaces = labeled;
    }
    res.json({
      status  : 'ok',
      message : `✅ ${labeled.length} personne(s) rechargée(s) et sauvegardées en DB`,
      persons : labeled.map(l => ({ name: l.label, descriptors: l.descriptors.length })),
    });
  } catch (e) {
    log('ERROR', `/faces/reload : ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
//  ROUTES API FLUTTER — publiques (sans x-api-key)
// ============================================================

// ── [API-1] Alertes ───────────────────────────────────────────
// GET /api/alertes?limite=50&type=temperature&resolue=false
app.get('/api/alertes', async (req, res) => {
  try {
    const limite  = parseInt(req.query.limite) || 50;
    const type    = req.query.type    || null;
    const resolue = req.query.resolue !== undefined
      ? req.query.resolue === 'true'
      : null;

    const filter = {};
    if (type)            filter.sensor  = type;
    if (resolue !== null) filter.resolue = resolue;

    const alertes = await Alert
      .find(filter)
      .sort({ timestamp: -1 })
      .limit(limite)
      .lean();

    const normalized = alertes.map(a => ({
      _id          : a._id.toString(),
      type         : a.sensor,
      niveau       : a.niveau,
      source       : a.source,
      message      : a.message,
      valeur       : a.valeur    ?? null,
      seuil        : a.seuil     ?? null,
      unit         : a.unit      ?? null,
      horodatage   : a.timestamp,
      resolue      : a.resolue   ?? false,
      minutes_avant: a.minutes_avant ?? null,
      confidence   : a.confidence    ?? null,
    }));

    res.json({ alertes: normalized, total: normalized.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── [API-2] Stats alertes ─────────────────────────────────────
// GET /api/alertes/stats
app.get('/api/alertes/stats', async (req, res) => {
  try {
    const now   = new Date();
    const il24h = new Date(now - 24 * 60 * 60 * 1000);

    const [total, nonResolues, critiques, dernieres24h] = await Promise.all([
      Alert.countDocuments(),
      Alert.countDocuments({ resolue: { $ne: true }, niveau: { $in: ['DANGER', 'WARNING'] } }),
      Alert.countDocuments({ niveau: 'DANGER', resolue: { $ne: true } }),
      Alert.countDocuments({ timestamp: { $gte: il24h } }),
    ]);

    res.json({ total, nonResolues, critiques, dernieres24h });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── [API-3] Résoudre une alerte ───────────────────────────────
// PUT /api/alertes/:id/resoudre
app.put('/api/alertes/:id/resoudre', async (req, res) => {
  try {
    const alerte = await Alert.findByIdAndUpdate(
      req.params.id,
      { resolue: true, resolue_at: new Date() },
      { new: true }
    );
    if (!alerte) return res.status(404).json({ error: 'Alerte non trouvée' });
    res.json({ success: true, alerte });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── [API-4] Journaux d'accès ──────────────────────────────────
// GET /api/journaux?limite=5&statut=autorise
app.get('/api/journaux', async (req, res) => {
  try {
    const limite = parseInt(req.query.limite) || 50;
    const statut = req.query.statut || null;

    const filter = {};
    if (statut === 'autorise') filter.authorized = true;
    if (statut === 'refuse')   filter.authorized = false;

    const journaux = await Access
      .find(filter)
      .sort({ timestamp: -1 })
      .limit(limite)
      .lean();

    const normalized = journaux.map(j => ({
      _id      : j._id.toString(),
      uid      : j.uid,
      prenom   : j.face_name?.split(' ')[0] ?? 'Inconnu',
      nom      : j.face_name?.split(' ').slice(1).join(' ') ?? '',
      statut   : j.authorized ? 'autorise' : 'refuse',
      typeAcces: j.decision ?? 'RFID',
      decision : j.decision,
      fallback : j.fallback,
      has_photo: j.has_photo,
      horodatage: j.timestamp,
    }));

    res.json({ journaux: normalized, total: normalized.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── [API-5] Stats journaux ────────────────────────────────────
// GET /api/journaux/stats
app.get('/api/journaux/stats', async (req, res) => {
  try {
    const now   = new Date();
    const il24h = new Date(now - 24 * 60 * 60 * 1000);

    const [total, autorises, refuses, dernieres24h] = await Promise.all([
      Access.countDocuments(),
      Access.countDocuments({ authorized: true }),
      Access.countDocuments({ authorized: false }),
      Access.countDocuments({ timestamp: { $gte: il24h } }),
    ]);

    res.json({ total, autorises, refuse: refuses, dernieres24h });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── [API-6] RFID ──────────────────────────────────────────────
// GET /api/rfid
app.get('/api/rfid', async (req, res) => {
  try {
    const rfids = await Access
      .find({ authorized: true })
      .distinct('uid');
    res.json({ rfids: rfids.map(uid => ({ uid, actif: true })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── [API-7] Historique températures ──────────────────────────
// GET /api/historique?limite=200
app.get('/api/historique', async (req, res) => {
  try {
    const limite = parseInt(req.query.limite) || 200;
    const data   = await TempReading
      .find()
      .sort({ timestamp: -1 })
      .limit(limite)
      .lean();
    res.json({ historique: data, total: data.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── [API-8] Stats historique ──────────────────────────────────
// GET /api/historique/stats
app.get('/api/historique/stats', async (req, res) => {
  try {
    const [total, danger, warning] = await Promise.all([
      TempReading.countDocuments(),
      TempReading.countDocuments({ classification: 'DANGER'  }),
      TempReading.countDocuments({ classification: 'WARNING' }),
    ]);
    res.json({ total, danger, warning, normal: total - danger - warning });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 404 ───────────────────────────────────────────────────────

// GET /api/visages — Liste les visages (admin)
// ── Gestion des visages (admin) ────────────────────────────
// ============================================================
// GESTION DES VISAGES (admin)
// ============================================================

// Liste tous les visages en parcourant les sous-dossiers de visages_autorises
app.get("/api/visages", auth, isAdmin, (req, res) => {
  try {
    const visagesDir = CONFIG.visagesDir;
    if (!fs.existsSync(visagesDir)) {
      return res.json({ visages: [] });
    }

    const dossiers = fs.readdirSync(visagesDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);

    const visages = [];
    for (const dossier of dossiers) {
      const dirPath = path.join(visagesDir, dossier);
      const fichiers = fs.readdirSync(dirPath).filter(f => /\.(jpg|jpeg|png)$/i.test(f));
      if (fichiers.length > 0) {
        visages.push({
          nom: dossier,
          fichier: fichiers[0],
          count: fichiers.length,
          chemin: `/api/visages/photo/${dossier}/${fichiers[0]}`,
        });
      }
    }
    res.json({ total: visages.length, visages });
  } catch (err) {
    console.error("❌ GET /api/visages ERROR:", err);
    res.status(500).json({ message: "Erreur serveur" });
  }
});

// Sert la photo d’un visage
app.get("/api/visages/photo/:person/:filename", auth, isAdmin, (req, res) => {
  const { person, filename } = req.params;
  const filePath = path.join(CONFIG.visagesDir, person, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ message: "Photo introuvable" });
  }
  res.sendFile(filePath);
});
app.use((req, res) => res.status(404).json({ error: `Route inconnue : ${req.method} ${req.path}` }));
// ─────────────────────────────────────────────
//  DIAGNOSTICS toutes les 60 secondes
// ─────────────────────────────────────────────
setInterval(() => {
  const cooldownS = Math.max(0, Math.ceil((gasState.alertCooldown - Date.now()) / 1000));
  log('INFO', '── Diagnostics v12.1 ────────────────────────────────────────────');
  log('INFO', `  [temp     ] ${liveData.temperature?.temperature ?? 'N/A'}°C → ${tempState.level}`);
  log('INFO', `  [pred     ] +20min=${liveData.prediction?.temperaturePrediteA20 ?? '?'}°C | conf=${liveData.prediction?.confidence ?? 'N/A'} → ${liveData.prediction?.alerte ?? 'N/A'}`);
  log('INFO', `  [humid    ] ${liveData.humidity?.humidity ?? 'N/A'}%HR → ${humidityState.level} | debounce:${humidityState.debounceCount}`);
  log('INFO', `  [gaz      ] ADC=${liveData.gas?.adc_raw ?? 'N/A'} | EMA=${liveData.gas?.adc_ema ?? 'N/A'} | cooldown:${cooldownS}s → ${liveData.gas?.classification ?? 'N/A'}`);
  log('INFO', `  [condensat] ${liveData.rain?.raining ? 'FUITE' : 'sec'} | ${liveData.rain?.duration_min ?? '—'}min → ${liveData.rain?.classification ?? 'N/A'}`);
  log('INFO', `  [visages  ] ${app.locals.authorizedFaces?.length ?? 0} personne(s) | seuil=${CONFIG.faceThreshold}`);
  log('INFO', `  [fallback ] ${fallbackState.size} UID(s) en mode secours`);
  log('INFO', `  [websocket] ${wss ? wss.clients.size : 0} client(s) connecté(s)`);
  log('INFO', '─────────────────────────────────────────────────────────────────');
}, 60_000);

// ─────────────────────────────────────────────
//  DÉMARRAGE
// ─────────────────────────────────────────────
async function start() {
  fs.mkdirSync(CONFIG.modelsDir,     { recursive: true });
  fs.mkdirSync(CONFIG.visagesDir,    { recursive: true });
  fs.mkdirSync(CONFIG.intrusionsDir, { recursive: true });
  initCSV();
  initAccessLog();

  await loadFaceModels();
  app.locals.authorizedFaces = await initializeFaceEncodings();
  app.locals.pendingPhotos   = new Map();

  const mqttClient = connectMQTT();

  // [WS-1] Créer le serveur HTTP (Express + WebSocket partagent le même port)
  const httpServer = http.createServer(app);
  wss = createWebSocketServer(httpServer);                   // [WS-1] Initialisation WS

  httpServer.listen(CONFIG.port, '0.0.0.0', () => {
    log('INFO', `\n🚀 Serveur IoT Salle Réseau v12.1 — port ${CONFIG.port}`);
    log('INFO', `🔒 Sécurité : HMAC-SHA256=ON | API_KEY=ON | TLS_MQTT=ON`);
    log('INFO', `🔌 WebSocket : ws://0.0.0.0:${CONFIG.port}  ← NOUVEAU v12.1`);
    log('INFO', ``);
    log('INFO', `📋 Routes principales :`);
    log('INFO', `   POST /analyze              ← ESP32-CAM envoie photo`);
    log('INFO', `   POST /access               ← ESP32 RFID envoie UID`);
    log('INFO', `   POST /faces/reload         ← Recharger encodages depuis disque`);
    log('INFO', `   GET  /db/photos            ← Liste photos accès (sans binaire)`);
    log('INFO', `   GET  /db/photos/:id        ← Photo JPEG brute par access_id`);
    log('INFO', `   GET  /db/photos/uid/:u     ← Photos par UID`);
    log('INFO', `   GET  /db/encodings         ← Liste encodages faciaux`);
    log('INFO', `   GET  /donnees              ← Données temps réel (HTTP polling)`);
    log('INFO', `   GET  /status               ← État complet`);
    log('INFO', `   WS   ws://<ip>:${CONFIG.port}       ← Alertes + live_data temps réel`);
    log('INFO', ``);
    log('INFO', `📱 Routes Flutter (publiques) :`);
    log('INFO', `   GET  /api/alertes          ← Alertes avec filtres (type, resolue, limite)`);
    log('INFO', `   GET  /api/alertes/stats    ← Stats alertes (total, critiques, 24h)`);
    log('INFO', `   PUT  /api/alertes/:id/resoudre ← Marquer alerte comme résolue`);
    log('INFO', `   GET  /api/journaux         ← Journaux d'accès avec filtres`);
    log('INFO', `   GET  /api/journaux/stats   ← Stats accès (total, autorises, refuses)`);
    log('INFO', `   GET  /api/rfid             ← Liste UIDs autorisés`);
    log('INFO', `   GET  /api/historique       ← Historique températures`);
    log('INFO', `   GET  /api/historique/stats ← Stats classifications températures`);
    log('INFO', ``);
    log('INFO', `🎭 Visages : ${app.locals.authorizedFaces?.length ?? 0} personne(s)`);
    log('INFO', `📷 CAM URL : ${CONFIG.camUrl}`);
    log('INFO', `🔄 Fallback fenêtre : ${CONFIG.fallbackWindowMs / 60000} min`);
  });

  const shutdown = async (sig) => {
    log('INFO', `${sig} — arrêt propre...`);
    try {
      // [WS-1] Fermer le WebSocket Server proprement
      await new Promise(resolve => wss.close(resolve));
      await new Promise(resolve => mqttClient.end(true, {}, resolve));
      await mongoose.connection.close();
      log('INFO', 'Serveur arrêté. 👋');
      process.exit(0);
    } catch (err) {
      log('ERROR', `Shutdown : ${err.message}`);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('uncaughtException',  (err)    => { log('ERROR', `[FATAL] ${err.message}\n${err.stack}`); process.exit(1); });
  process.on('unhandledRejection', (reason) => { log('ERROR', `[FATAL] Promise : ${reason}`);          process.exit(1); });
}

start().catch(err => { log('ERROR', `Démarrage : ${err.message}`); process.exit(1); });