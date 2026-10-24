// js/analyze.js (the overlay's analyzer, a browser script) in node: it runs as is in
// a sandbox whose page (document, storage...) answers anything and does nothing,
// stops before drawing the page, and hands out its own board functions. Used by
// local/lanterna.js, so the Lanterna's board is the one the overlay builds, and by
// local/lanterna-paridade.js. Loaded again when analyze.js changes (an update).
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILE = path.join(__dirname, '..', 'js', 'analyze.js');
let sig = '';
let api = null;
let engine = null;

function load(T, S) {
  const st = fs.statSync(FILE);
  const now = `${st.size}:${st.mtimeMs}`;
  // A reloaded engine (an update) needs analyze.js run on it again.
  if (api && now === sig && engine === T) return api;
  const text = fs.readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n');
  const at = text.lastIndexOf('\n  buildBoard();');
  if (at < 0) throw new Error('analyze.js mudou: sem buildBoard() no fim');
  const code = `${text.slice(0, at)}\n  window.__az = { buildState, modelFrom, blankModel };\n})();`;
  const stub = new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : stub), apply: () => stub, construct: () => stub, set: () => true });
  const window = { Tartarus: T, TartarusSolver: S, TartarusBoard: stub, TartarusLive: null };
  const sandbox = { window, document: stub, localStorage: { getItem: () => null, setItem() {} }, navigator: stub, location: stub, performance, console, setTimeout, clearTimeout, setInterval, clearInterval, Worker: stub, Blob: stub, URL: stub, fetch: stub, requestAnimationFrame: () => 0, addEventListener() {}, getComputedStyle: stub, matchMedia: stub, Image: stub, alert() {}, confirm: () => false, prompt: () => null };
  window.window = window;
  Object.assign(window, sandbox);
  vm.runInNewContext(code, sandbox, { filename: 'analyze.js' });
  if (!window.__az || typeof window.__az.buildState !== 'function') throw new Error('analyze.js mudou: sem buildState');
  api = window.__az;
  sig = now;
  engine = T;
  return api;
}

module.exports = { load };
