// Serves this copy of the Tartarus Simulator on http://localhost:8787/ for the
// Tartarus Overlay app (started with --site=http://localhost:8787/).
// Usage: node local/serve.js [port]
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const lanterna = require('./lanterna.js');

// The analyzer page asks for its own address every 5 minutes (js/update.js):
// while it does, the overlay is up, whatever tasklist says (under the game's
// load it once missed it, the server stopped, and the analyzer fell back to
// its slow mode for the rest of the night).
const QUIET_MS = 15 * 60 * 1000;
let lastRequest = Date.now();
const PORT = Number(process.argv[2]) || 8787;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

// The asset tag (?v=) of each page gets a mark of the local changes (a hash
// of the scripts in js/), so a new local improvement (a training result, a
// fix) shows as a site update, as the author's do: the overlay reloads its
// pages by itself, at once with the game closed, or when the run ends.
const crypto = require('crypto');
let markSig = '';
let markHash = '';
function localMark(dirs) {
  const files = [];
  for (const d of dirs) {
    try {
      for (const n of fs.readdirSync(d)) if (n.endsWith('.js')) files.push(path.join(d, n));
    } catch (e) {
      // a folder that isn't there
    }
  }
  files.sort();
  const sig = files
    .map((f) => {
      try {
        const st = fs.statSync(f);
        return `${f}:${st.size}:${st.mtimeMs}`;
      } catch (e) {
        return f;
      }
    })
    .join('|');
  if (sig !== markSig) {
    const h = crypto.createHash('sha1');
    for (const f of files) {
      try {
        h.update(path.basename(f));
        h.update(fs.readFileSync(f));
      } catch (e) {
        // gone meanwhile
      }
    }
    markSig = sig;
    markHash = h.digest('hex').slice(0, 8);
  }
  return markHash;
}
const marked = (html, mark) => html.replace(/([?&]v=)([\w.]+)/g, `$1$2-${mark}`);

http
  .createServer((req, res) => {
    lastRequest = Date.now();
    // The Lanterna's screen reader asks here for the analyzer's advice (local/lanterna.js).
    if (lanterna.handle(req, res)) return;
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch (e) {
      res.writeHead(400).end();
      return;
    }
    let file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end();
      return;
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      if (path.extname(file).toLowerCase() === '.html') data = Buffer.from(marked(data.toString('utf8'), localMark([path.join(ROOT, 'js')])), 'utf8');
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  })
  .on('error', (e) => {
    // Already serving (the launcher was opened twice): that one keeps going.
    console.log(e.code === 'EADDRINUSE' ? `port ${PORT} already served; exiting` : `server error: ${e.message}`);
    process.exit(0);
  })
  .listen(PORT, '127.0.0.1', () => console.log(`Tartarus local: http://localhost:${PORT}/`));

// Closes itself once the Tartarus Overlay has been closed for a few minutes
// (it needs the server only while it runs). The first checks wait for the
// overlay to start.
const { execFile } = require('child_process');
const OVERLAY = process.env.TARTARUS_WATCH_EXE || 'Tartarus Overlay.exe';
const CHECK_MS = Number(process.env.TARTARUS_WATCH_MS) || 60 * 1000;
const GONE_CHECKS = 3;
let gone = 0;
let seen = false;
const startedAt = Date.now();
setInterval(() => {
  execFile('tasklist', ['/FI', `IMAGENAME eq ${OVERLAY}`, '/NH'], { windowsHide: true }, (err, out) => {
    if (err) return; // can't tell: keep serving
    if (String(out).toLowerCase().includes(OVERLAY.toLowerCase())) {
      seen = true;
      gone = 0;
      return;
    }
    if (!seen && Date.now() - startedAt < 5 * CHECK_MS) return;
    gone += 1;
    if (gone >= GONE_CHECKS && Date.now() - lastRequest >= QUIET_MS) {
      console.log('the overlay is closed; stopping the local server');
      process.exit(0);
    }
  });
}, CHECK_MS);

// A stray error never takes the server down.
process.on('uncaughtException', (e) => console.log(`server error: ${e.message}`));

// Every 30 minutes, the author's latest version merged under the local
// improvements (local/update.js). The pages notice a new asset tag by
// themselves (js/update.js) and offer a Reload.
const { spawn } = require('child_process');
const UPDATE_MS = 30 * 60 * 1000;
function runUpdate() {
  const child = spawn(process.execPath, [path.join(__dirname, 'update.js')], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
  child.on('error', (e) => console.log(`update failed to start: ${e.message}`));
}
// TARTARUS_SEM_UPDATE (the friend's Lanterna, see TartarusAI.exe): no git
// there; TartarusAI.exe brings the new versions in when it opens.
const NO_UPDATE = !!process.env.TARTARUS_SEM_UPDATE;
if (!NO_UPDATE) setInterval(runUpdate, UPDATE_MS);
// The Lanterna starts the server with --update: one check a minute after start,
// so an update of the author's site reaches it the same session.
if (process.argv.includes('--update') && !NO_UPDATE) setTimeout(runUpdate, 60 * 1000);
// ...and its Lanterna route ready before the first screen (local/lanterna.js warm()).
if (process.argv.includes('--update')) setImmediate(() => lanterna.warm());
