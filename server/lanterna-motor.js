// The C# engine (TartarusMotor.exe, from ..\motor-cs): the playouts of lanterna-worker.js,
// the same dice and the same values round by round (motor-cs/teste/equivalencia.js), about
// 14 times faster a thread. One child process, JSON lines on stdin/stdout, stands in for the
// worker pool: pool(n) gives n "workers" with postMessage() and on('message'), each a stream
// k of the check, as lanterna.js's check() drives its worker_threads.
// At start the exe checks that js/engine.js and the code of js/solver.js (all but the lines
// the training rewrites, which it reads) are the ones it was ported from: if not (an update
// from the author), or the exe is missing or fails, lanterna.js goes on with its JS workers
// and the log says why. LANTERNA_MOTOR=js: always the JS.
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const EXE = path.join(__dirname, 'TartarusMotor.exe');
const JS_DIR = path.join(__dirname, '..', 'js');
// The engine.js/solver.js pairs local/motor-confere.js checked after an update (all equal).
const ACEITO = path.join(__dirname, 'motor-aceito.json');
const aceitoSig = () => {
  try {
    const st = fs.statSync(ACEITO);
    return `${st.size}:${st.mtimeMs}`;
  } catch (e) {
    return '';
  }
};
// motor-aceito.json as it was when the engine was refused: a new check there starts it again.
let offSig = null;

let proc = null;
let ready = false;
let off = '';
let said = '';
let onFail = null;
let S = null;
let T = null;
// Per check id: the rows' labels as the JS worker sends them (meta), and the kind of the pick.
const jobs = new Map();
// Per stream k: the check's message handler.
let handlers = [];
// whenReady()'s callers, told at hello or failure.
let waiters = [];
function wake() {
  const list = waiters;
  waiters = [];
  for (const f of list) f();
}

function say(text) {
  if (text === said) return;
  said = text;
  console.log(`lanterna: ${text}`);
}

function fail(why) {
  if (off) return;
  off = why;
  offSig = aceitoSig();
  ready = false;
  if (proc) {
    try {
      proc.kill();
    } catch (e) {}
  }
  proc = null;
  say(`motor C# desligado (${why}); as partidas seguem no JS`);
  wake();
  if (onFail) onFail();
}

function send(obj) {
  if (!proc) return;
  try {
    proc.stdin.write(`${JSON.stringify(obj)}\n`);
  } catch (e) {
    fail(`escrita: ${e.message}`);
  }
}

function onLine(line) {
  let m;
  try {
    m = JSON.parse(line);
  } catch (e) {
    return;
  }
  if (m.hello) {
    if (!m.ok) return fail(m.why || 'recusou os arquivos');
    ready = true;
    said = '';
    say(`motor C# pronto (${m.threads} núcleos)`);
    wake();
    return;
  }
  if (m.erro) return fail(`erro: ${m.erro}`);
  const job = jobs.get(m.id);
  if (!job) return;
  const k = m.k;
  if (m.acts) {
    // The C# rows must be the JS rows, in order: otherwise the values go to the wrong moves.
    const same = m.acts.length === job.meta.length && m.acts.every((a, i) => S.sameAction(job.meta[i].action, a.type === 'choose' ? { type: 'choose', id: job.ids[a.arg] } : a));
    if (!same) return fail('as opções do C# e do JS diferem');
  }
  const out = {
    id: m.id,
    rounds: m.rounds,
    done: m.done,
    goal: 'rainbows',
    meta: m.acts ? job.meta : null,
    rows: m.rows.map((r) => ({ vals: r.vals.map((x) => (x === null ? NaN : x)), best: r.best })),
  };
  if (handlers[k]) handlers[k](out);
}

// Starts the exe (if it's there and not refused); `ready` once it says hello.
function start(engine, solver, failed) {
  T = engine;
  S = solver;
  onFail = failed;
  if (off && offSig !== null && aceitoSig() !== offSig) {
    off = '';
    offSig = null;
  }
  if (proc || off) return;
  if (process.env.LANTERNA_MOTOR === 'js') {
    off = 'LANTERNA_MOTOR=js';
    return;
  }
  if (!fs.existsSync(EXE)) {
    off = 'sem local\\TartarusMotor.exe';
    say(`motor C# desligado (${off}); as partidas seguem no JS`);
    return;
  }
  try {
    proc = spawn(EXE, ['--abaixo', 'serve', JS_DIR, ACEITO], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  } catch (e) {
    proc = null;
    return fail(e.message);
  }
  const me = proc;
  readline.createInterface({ input: me.stdout }).on('line', onLine);
  me.stderr.on('data', (d) => console.log(`lanterna: motor C#: ${String(d).trim()}`));
  me.on('error', (e) => me === proc && fail(e.message));
  me.on('exit', (code) => me === proc && fail(`saiu (${code})`));
  me.stdin.on('error', () => {});
  me.unref();
  me.stdout.unref && me.stdout.unref();
  me.stderr.unref && me.stderr.unref();
}

// The AI's files changed (training, update): a new process reads them.
function restart(engine, solver, failed) {
  if (proc) {
    const old = proc;
    proc = null;
    try {
      old.kill();
    } catch (e) {}
  }
  ready = false;
  off = '';
  offSig = null;
  jobs.clear();
  start(engine, solver, failed);
}

// n workers for check(): postMessage({ id, state, rollouts, stream, cells }) or ({ stop, id }).
function pool(n) {
  handlers = new Array(n).fill(null);
  return Array.from({ length: n }, (_, k) => ({
    motor: true,
    on(event, fn) {
      if (event === 'message') handlers[k] = fn;
    },
    unref() {},
    terminate() {},
    postMessage(m) {
      if (m.stop) {
        send({ cmd: 'stop', id: m.id });
        jobs.delete(m.id);
        return;
      }
      if (!jobs.has(m.id)) {
        // The rows as lanterna-worker.js lists them (solve's candidates, the cells kept).
        const seed = (m.id * 7919 + 1) >>> 0;
        const job = S.solve(m.state, { rollouts: m.rollouts, stream: 0, seed });
        if (m.cells) for (let i = job.rows.length - 1; i >= 0; i--) if (job.rows[i].action.type === 'patrol' && !m.cells.includes(job.rows[i].action.cell)) job.rows.splice(i, 1);
        const pending = m.state.pending && m.state.pending[0];
        const ids = pending && pending.kind === 'gift' ? T.GIFT_IDS : T.TOOL_IDS;
        for (const old of jobs.keys()) if (old < m.id) jobs.delete(old);
        jobs.set(m.id, { meta: job.rows.map((r) => ({ label: r.label, action: r.action, kind: r.kind, policy: r.policy })), ids });
      }
      send({ cmd: 'start', id: m.id, k, state: m.state, rollouts: m.rollouts, stream: m.stream || 0, seed: (m.id * 7919 + 1) >>> 0, cells: m.cells || null });
    },
  }));
}

// Resolves once the engine said hello, failed, or `ms` passed.
function whenReady(ms) {
  if (ready || off || !proc) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    waiters.push(() => {
      clearTimeout(t);
      resolve();
    });
  });
}

module.exports = {
  start,
  whenReady,
  restart,
  pool,
  get ready() {
    return ready && !!proc;
  },
  get off() {
    return off;
  },
};
