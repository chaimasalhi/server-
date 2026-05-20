require('dotenv').config();
const crypto = require('crypto');

const data = '{"avg_temp":20.62,"device_id":"esp32_01","dropped_count":0,"location":"salle","temperature":20.62,"timestamp":1776590849,"ts_reliable":true}';
const received = '87aa1e4060bdd484feb27a7670cc2b567057d6519aaeb073418561446b66fcbc';

const hmac = crypto.createHmac('sha256', process.env.MQTT_HMAC_KEY).update(data).digest('hex');

console.log('calculé:', hmac);
console.log('reçu:   ', received);
console.log('match:  ', hmac === received);