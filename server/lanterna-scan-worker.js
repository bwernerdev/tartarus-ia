// Worker of local/lanterna.js: the Tartarus reader (js/scan.js) on the Lanterna's frame,
// off the server's main thread, so the playouts' check keeps its pace (and its time cap)
// while a frame is read. Its cache keeps the board's place between frames, as the
// analyzer's reader worker does.
'use strict';
const { parentPort } = require('worker_threads');

require('../js/scan-data.js');
require('../js/pick-data.js');
const scanApi = require('../js/scan.js');
const scanRef = scanApi.withPanelIcons(globalThis.TARTARUS_SCAN, globalThis.TARTARUS_PICK);
const cache = {};

parentPort.on('message', (m) => {
  let result = null;
  try {
    const r = scanApi.scan({ width: m.width, height: m.height, data: new Uint8ClampedArray(m.buffer) }, scanRef, { cache, lang: 'en' });
    result = r && r.ok ? r : null;
  } catch (e) {
    result = null;
  }
  parentPort.postMessage({ id: m.id, result });
});
parentPort.postMessage({ ready: true });
