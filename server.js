// ============================================================
//  Node.js Backend — Salle Réseau Informatique
//  ✅ IA Reconnaissance Visage
//  ✅ MQTT HiveMQ — Capteurs
//  ✅ CSV — Collecte données
//  ✅ Linear Regression — Prédiction surchauffe CORRIGÉE
//
//  npm install express multer canvas @tensorflow/tfjs
//  npm install @tensorflow/tfjs-backend-wasm @vladmandic/face-api
//  npm install mqtt ml-regression
//
//  Lancer : node server.js
// ============================================================

const tf         = require("@tensorflow/tfjs");
require("@tensorflow/tfjs-backend-wasm");
const faceapi    = require("@vladmandic/face-api/dist/face-api.node-wasm.js");
const canvas     = require("canvas");
const express    = require("express");
const multer     = require("multer");
const path       = require("path");
const fs         = require("fs");
const mqtt       = require("mqtt");
const { SimpleLinearRegression } = require("ml-regression");

const app    = express();
const upload = multer({ storage: multer.memoryStorage() });

// ============================================================
//  CONFIGURATION
// ============================================================
const PORT        = 3000;
const MODELS_DIR  = path.join(__dirname, "models");
const VISAGES_DIR = path.join(__dirname, "visages_autorises");
const CSV_FILE    = path.join(__dirname, "temperature_data.csv");

// Normes TIA-942
const TEMP_MAX      = 27.0;  // °C maximum TIA-942
const TEMP_WARNING  = 25.0;  // °C seuil avertissement
const PREDICT_AHEAD = 20;    // minutes de prédiction
const HISTORY_SIZE  = 20;    // nombre de lectures

// Patch face-api
const { Canvas, Image, ImageData } = canvas;
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

// ============================================================
//  MQTT HiveMQ
// ============================================================
const MQTT_HOST = "d4a47e0829894cd09c0111dc12ad7dd5.s1.eu.hivemq.cloud";
const MQTT_PORT = 8883;
const MQTT_USER = "esp32user";
const MQTT_PASS = "Esp32pass123";

const TOPIC_TEMP  = "salle/temperature";
const TOPIC_HUMID = "salle/humidite";
const TOPIC_GAZ   = "salle/gaz";
const TOPIC_EAU   = "salle/eau";

// ============================================================
//  STOCKAGE DONNÉES
// ============================================================
let dernieresDonnees = {
  temperature : null,
  humidite    : null,
  gaz         : null,
  eau         : null,
  prediction  : null,
  lastUpdate  : null
};

let historiqueTemp = [];

// ============================================================
//  INITIALISER CSV
// ============================================================
function initCSV() {
  if (!fs.existsSync(CSV_FILE)) {
    fs.writeFileSync(CSV_FILE, "timestamp,temperature,statut\n");
    console.log("✅ Fichier CSV créé");
  } else {
    const lines = fs.readFileSync(CSV_FILE, "utf8").split("\n").length - 2;
    console.log(`✅ CSV existant — ${lines} lignes`);
  }
}

// ============================================================
//  SAUVEGARDER CSV
// ============================================================
function saveToCSV(temperature, statut) {
  const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19);
  fs.appendFileSync(CSV_FILE, `${timestamp},${temperature},${statut}\n`);
  const count = fs.readFileSync(CSV_FILE, "utf8").split("\n").length - 2;
  console.log(`💾 CSV — Total : ${count} lignes`);
}

// ============================================================
//  🧠 LINEAR REGRESSION CORRIGÉE
// ============================================================
function predictTemperature(temperature) {
  historiqueTemp.push(parseFloat(temperature));
  if (historiqueTemp.length > HISTORY_SIZE) historiqueTemp.shift();

  // Besoin minimum 5 lectures
  if (historiqueTemp.length < 5) {
    console.log(`🧠 AI — En attente (${historiqueTemp.length}/${HISTORY_SIZE})`);
    return null;
  }

  // ============================================================
  //  قاعدة 1 — تحقق إذا الترند صاعد أو نازل
  // ============================================================
  const premiere = historiqueTemp[0];
  const derniere = historiqueTemp[historiqueTemp.length - 1];
  const trend    = derniere - premiere;

  console.log(`\n🧠 LINEAR REGRESSION :`);
  console.log(`   Historique  : [${historiqueTemp.join(", ")}]`);
  console.log(`   Actuelle    : ${temperature}°C`);
  console.log(`   Trend       : ${trend > 0 ? "↗️ Montante" : trend < 0 ? "↘️ Descendante" : "→ Stable"} (${trend.toFixed(1)}°C)`);

  // ============================================================
  //  قاعدة 2 — إذا نازلة أو مستقرة = مش خطر
  // ============================================================
  if (trend <= 0) {
    console.log(`   📉 Température stable ou en baisse — aucun risque`);

    dernieresDonnees.prediction = {
      temperatureActuelle : temperature,
      temperaturePredite  : null,
      trend               : "BAISSE_OU_STABLE",
      dansMinutes         : PREDICT_AHEAD,
      alerte              : "NORMAL",
      message             : "Température stable ou en baisse ✅",
      timestamp           : new Date().toLocaleString()
    };
    return dernieresDonnees.prediction;
  }

  // ============================================================
  //  قاعدة 3 — إذا صاعدة → نحسب التنبؤ
  // ============================================================
  const x = historiqueTemp.map((_, i) => i);
  const y = historiqueTemp;

  const regression  = new SimpleLinearRegression(x, y);
  const futureStep  = (PREDICT_AHEAD * 60) / 5;
  const predicted   = regression.predict(historiqueTemp.length - 1 + futureStep);

  // ============================================================
  //  قاعدة 4 — التنبؤ لا يكون أقل من درجة الحرارة الحالية
  //           ولا أقل من 10°C
  // ============================================================
  const predictedFinal = Math.max(
    parseFloat(predicted.toFixed(1)),
    temperature,   // لا يكون أقل من الحالية
    10.0           // لا يكون أقل من 10°C
  );

  console.log(`   Prédiction dans ${PREDICT_AHEAD} min : ${predictedFinal}°C`);

  // ============================================================
  //  تحديد مستوى الخطر
  // ============================================================
  let alerteIA = "NORMAL";
  let message  = "";

  if (predictedFinal >= TEMP_MAX) {
    alerteIA = "DANGER";
    message  = `🚨 DANGER — Surchauffe prévue dans ${PREDICT_AHEAD} min ! (${predictedFinal}°C ≥ ${TEMP_MAX}°C)`;
    console.log(`   🚨 DANGER — Surchauffe prévue !`);
    console.log(`   🚨 ${predictedFinal}°C ≥ ${TEMP_MAX}°C TIA-942 !`);
    console.log(`   ⚡ Action immédiate requise !`);

  } else if (predictedFinal >= TEMP_WARNING) {
    alerteIA = "AVERTISSEMENT";
    message  = `⚠️ AVERTISSEMENT — Température critique prévue (${predictedFinal}°C)`;
    console.log(`   ⚠️  AVERTISSEMENT — ${predictedFinal}°C proche de ${TEMP_MAX}°C !`);

  } else {
    alerteIA = "NORMAL";
    message  = `✅ Température sous contrôle — prédiction ${predictedFinal}°C`;
    console.log(`   ✅ Pas de risque — prédiction ${predictedFinal}°C`);
  }

  dernieresDonnees.prediction = {
    temperatureActuelle : temperature,
    temperaturePredite  : predictedFinal,
    trend               : "MONTANTE",
    dansMinutes         : PREDICT_AHEAD,
    alerte              : alerteIA,
    message             : message,
    timestamp           : new Date().toLocaleString()
  };

  return dernieresDonnees.prediction;
}

// ============================================================
//  CONNEXION MQTT
// ============================================================
function connectMQTT() {
  console.log("🔄 Connexion HiveMQ MQTT...");

  const mqttClient = mqtt.connect(`mqtts://${MQTT_HOST}:${MQTT_PORT}`, {
    username           : MQTT_USER,
    password           : MQTT_PASS,
    rejectUnauthorized : false
  });

  mqttClient.on("connect", () => {
    console.log("✅ HiveMQ connecté !");
    mqttClient.subscribe(TOPIC_TEMP,  () => console.log(`📡 Subscribed : ${TOPIC_TEMP}`));
    mqttClient.subscribe(TOPIC_HUMID, () => console.log(`📡 Subscribed : ${TOPIC_HUMID}`));
    mqttClient.subscribe(TOPIC_GAZ,   () => console.log(`📡 Subscribed : ${TOPIC_GAZ}`));
    mqttClient.subscribe(TOPIC_EAU,   () => console.log(`📡 Subscribed : ${TOPIC_EAU}`));
  });

  mqttClient.on("message", (topic, message) => {
    try {
      const data = JSON.parse(message.toString());
      dernieresDonnees.lastUpdate = new Date().toLocaleString();

      console.log(`\n📨 [${topic}] : ${message.toString()}`);

      if (topic === TOPIC_TEMP) {
        dernieresDonnees.temperature = data;
        saveToCSV(data.temperature, data.statut);
        predictTemperature(data.temperature);

        if      (data.statut === "TROP_CHAUD") console.log("🚨 ALERTE — Température trop élevée !");
        else if (data.statut === "TROP_FROID") console.log("🔵 ALERTE — Température trop basse !");
        else                                   console.log(`✅ Température : ${data.temperature}°C — Normal`);
      }

      else if (topic === TOPIC_HUMID) {
        dernieresDonnees.humidite = data;
        if      (data.statut === "TROP_HUMIDE") console.log("🚨 ALERTE — Humidité trop élevée !");
        else if (data.statut === "TROP_SEC")    console.log("⚠️  ALERTE — Air trop sec !");
        else                                    console.log(`✅ Humidité : ${data.humidite}% — Normal`);
      }

      else if (topic === TOPIC_GAZ) {
        dernieresDonnees.gaz = data;
        if (data.statut === "ALERTE")    console.log("🚨 ALERTE — Gaz détecté !");
        else if (data.statut === "ATTENTION") console.log("⚠️  Attention — niveau gaz élevé !");
        else                             console.log(`✅ Gaz : Normal`);
      }

      else if (topic === TOPIC_EAU) {
        dernieresDonnees.eau = data;
        if (data.statut === "FUITE") console.log("🚨 ALERTE — Fuite eau climatiseur !");
        else                         console.log(`✅ Eau : Pas de fuite`);
      }

    } catch (err) {
      console.error("❌ Erreur parsing MQTT :", err.message);
    }
  });

  mqttClient.on("error", (err) => {
    console.error("❌ Erreur MQTT :", err.message);
  });
}

// ============================================================
//  CHARGER MODÈLES IA VISAGE
// ============================================================
async function loadModels() {
  console.log("⏳ Initialisation TensorFlow WASM...");
  await tf.setBackend("wasm");
  await tf.ready();
  console.log("✅ TensorFlow prêt !");

  console.log("⏳ Chargement modèles IA visage...");
  await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODELS_DIR);
  await faceapi.nets.faceLandmark68Net.loadFromDisk(MODELS_DIR);
  await faceapi.nets.faceRecognitionNet.loadFromDisk(MODELS_DIR);
  console.log("✅ Modèles IA chargés !");
}

// ============================================================
//  CHARGER VISAGES AUTORISÉS
// ============================================================
async function loadAuthorizedFaces() {
  const labeledDescriptors = [];
  const files = fs.readdirSync(VISAGES_DIR).filter(f =>
    f.endsWith(".jpg") || f.endsWith(".png")
  );

  console.log(`⏳ Chargement de ${files.length} visage(s)...`);

  for (const file of files) {
    const name    = path.parse(file).name;
    const imgPath = path.join(VISAGES_DIR, file);
    const img     = await canvas.loadImage(imgPath);
    const detect  = await faceapi.detectSingleFace(img).withFaceLandmarks().withFaceDescriptor();

    if (detect) {
      labeledDescriptors.push(new faceapi.LabeledFaceDescriptors(name, [detect.descriptor]));
      console.log(`  ✅ Visage : ${name}`);
    } else {
      console.log(`  ⚠️  Pas de visage dans : ${file}`);
    }
  }

  console.log(`✅ ${labeledDescriptors.length} visage(s) prêt(s)`);
  return labeledDescriptors;
}

// ============================================================
//  ENDPOINT POST /analyze — IA Visage
// ============================================================
app.post("/analyze", upload.single("photo"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Aucune photo reçue" });

    console.log("\n📷 Photo reçue — analyse visage...");
    const img       = await canvas.loadImage(req.file.buffer);
    const detection = await faceapi.detectSingleFace(img).withFaceLandmarks().withFaceDescriptor();

    if (!detection) {
      console.log("⚠️  Aucun visage détecté");
      return res.json({ status: "no_face", message: "Aucun visage détecté" });
    }

    const faceMatcher = new faceapi.FaceMatcher(app.locals.authorizedFaces, 0.65);
    const match       = faceMatcher.findBestMatch(detection.descriptor);

    if (match.label !== "unknown") {
      const confiance = ((1 - match.distance) * 100).toFixed(1);
      console.log(`✅ Visage reconnu : ${match.label} (${confiance}%)`);
      return res.json({ status: "authorized", name: match.label, confidence: `${confiance}%`, message: `✅ ${match.label}` });
    } else {
      console.log("🚨 Visage inconnu !");
      return res.json({ status: "unauthorized", message: "❌ Visage inconnu !" });
    }

  } catch (err) {
    console.error("❌ Erreur :", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ENDPOINT GET /status
// ============================================================
app.get("/status", (req, res) => {
  res.json({
    status           : "running",
    visages          : app.locals.authorizedFaces.length,
    dernieresDonnees : dernieresDonnees,
    message          : "Serveur IA + MQTT + Prédiction ✅"
  });
});

// ============================================================
//  ENDPOINT GET /donnees
// ============================================================
app.get("/donnees", (req, res) => {
  res.json(dernieresDonnees);
});

// ============================================================
//  ENDPOINT GET /prediction
// ============================================================
app.get("/prediction", (req, res) => {
  if (!dernieresDonnees.prediction) {
    return res.json({ message: "En attente de données..." });
  }
  res.json(dernieresDonnees.prediction);
});

// ============================================================
//  ENDPOINT GET /csv
// ============================================================
app.get("/csv", (req, res) => {
  if (!fs.existsSync(CSV_FILE)) return res.json({ lignes: 0 });
  const lignes = fs.readFileSync(CSV_FILE, "utf8").split("\n").length - 2;
  res.json({
    lignes  : lignes,
    message : `${lignes} lignes collectées`,
    pret    : lignes >= 1000 ? "✅ Prêt pour LSTM !" : `⏳ ${1000 - lignes} lignes manquantes`
  });
});

// ============================================================
//  DÉMARRAGE
// ============================================================
async function start() {
  fs.mkdirSync(MODELS_DIR,  { recursive: true });
  fs.mkdirSync(VISAGES_DIR, { recursive: true });

  initCSV();
  
  await loadModels();
  app.locals.authorizedFaces = await loadAuthorizedFaces();
  connectMQTT();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n🚀 Serveur Salle Réseau démarré !`);
    console.log(`   → POST  :${PORT}/analyze    (IA visage)`);
    console.log(`   → GET   :${PORT}/status     (statut général)`);
    console.log(`   → GET   :${PORT}/donnees    (capteurs)`);
    console.log(`   → GET   :${PORT}/prediction (🧠 AI prédiction)`);
    console.log(`   → GET   :${PORT}/csv        (données collectées)`);
  });
}

start();