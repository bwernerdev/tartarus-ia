// The Lanterna's advice (..\..\lanterna, beside this simulator): its
// screen reader posts what it read to POST /lanterna/advise, and this answers
// with the move the overlay's analyzer would advise for that board: the
// strategy's instant pick (js/solver.js), checked by the same Monte Carlo
// playouts, with the analyzer's lite limits (the game is open).
// GET /lanterna/ping answers "ok" (the Lanterna starts the server if not).
'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');

// The trained strategy lands in js/ (local/apply-results.js) while the server
// runs: when those files change, they're loaded again and the workers restart,
// so the Lanterna plays the new training without a server restart.
// The screen reader's files too: an update of the author's site brings new art.
// analyze.js too: its check's numbers (below) are read from it.
const AI_FILES = ['engine.js', 'tool-combos.js', 'solver.js', 'scan.js', 'scan-data.js', 'pick-data.js', 'analyze.js'].map((f) => path.join(__dirname, '..', 'js', f));
const ANALYZE = AI_FILES[AI_FILES.length - 1];
let T = null;
let S = null;
let aiSig = '';
let pool = null;
let active = null;
// The Tartarus reader's worker (scanFrame()).
let scanWorker = null;
let scanId = 0;
let scanWaiting = null;
// The checks already asked for, by board (start()).
const plans = new Map();

// js/analyze.js's local build (not the friend's lite one): the same check as the
// user's own overlay, so the Lanterna's advice is the overlay's. The numbers are read
// from analyze.js itself, so an update or a retune there reaches the Lanterna too;
// these are the fallback when the file's shape changes (the log says so).
let TUNING = { budget: 40000, maxPer: 6000, ms: 3000, switchMin: 0.02 };
let LIVE_MIN = 150;
const LANTERNA_MS = Number(process.env.LANTERNA_MS) || 1200;
// The cap for a close call (see check()): more playouts only where they can change the advice.
const LANTERNA_MS_DIFICIL = Number(process.env.LANTERNA_MS_DIFICIL) || 2500;
let CLEAR_SE = 3;
function analyzeNumbers() {
  try {
    const src = fs.readFileSync(ANALYZE, 'utf8');
    const local = /LITE \? \{[^}]*\} : (\{[^}]*\})/.exec(src);
    const liveMin = /const LIVE_MIN = (\d+(?:\.\d+)?);/.exec(src);
    const clearSe = /const CLEAR_SE = (\d+(?:\.\d+)?);/.exec(src);
    if (!local || !liveMin || !clearSe) throw new Error('shape changed');
    const tuning = JSON.parse(local[1].replace(/(\w+):/g, '"$1":'));
    for (const k of ['budget', 'maxPer', 'ms', 'switchMin']) if (!Number.isFinite(tuning[k])) throw new Error(`no ${k}`);
    TUNING = tuning;
    LIVE_MIN = Number(liveMin[1]);
    CLEAR_SE = Number(clearSe[1]);
  } catch (e) {
    console.log(`lanterna: analyze.js numbers not read (${e.message}); using ${JSON.stringify(TUNING)}`);
  }
}

function loadAi() {
  const sig = AI_FILES.map((f) => {
    try {
      const st = fs.statSync(f);
      return `${st.size}:${st.mtimeMs}`;
    } catch (e) {
      return '';
    }
  }).join('|');
  if (sig === aiSig) return;
  for (const f of AI_FILES) delete require.cache[require.resolve(f)];
  T = require('../js/engine.js');
  S = require('../js/solver.js');
  aiSig = sig;
  // The reader's worker loads the new art.
  scanStop();
  plans.clear();
  analyzeNumbers();
  if (pool) {
    if (active) active.finish();
    for (const w of pool) w.terminate();
    pool = null;
  }
  // The C# engine reads solver.js and tool-combos.js at start (and checks engine.js): a new one.
  if (motorPool || motor.off) {
    if (active && active.motor) active.finish();
    motorPool = null;
    motor.restart(T, S, motorFailed);
  }
}
// The C# engine (local/lanterna-motor.js): the check's playouts, ~14x faster; JS workers when
// it's off (missing, refused, failed).
const motor = require('./lanterna-motor.js');
let motorPool = null;
function motorFailed() {
  motorPool = null;
  if (active && active.motor) active.finish();
}
loadAi();

// Two thirds of the cores, as the overlay's analyzer in its local build ("Balanced",
// analyze.js setCores: 8 of 12), below normal priority: the game and the frame's reader keep
// the rest (with every core but one, the reader took 2.5 s and more with the game open).
// LANTERNA_WORKERS overrides it (tests with the game open use 1).
const WORKERS = Number(process.env.LANTERNA_WORKERS) || Math.max(1, Math.round((os.cpus().length * 2) / 3));
const TOP_TIER = T.SUPREME;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const int = (v, d) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : d);

// Instrument names as the game shows them (the Lanterna's NomesFerramentas, plus the ones it lacks).
const TOOL_NAMES = [
  ['Muzzle', 'muzzle'], ['Ring of Keys', 'keys'], ['Iron Box', 'ironbox'], ['Avenger', 'revenge'], ['Noose', 'rope'],
  ['Axe', 'axe'], ['Collar', 'collar'], ['Hook', 'hook'], ['Long-Chained', 'shackles'], ['Long Chained', 'shackles'],
  ['Saw', 'saw'], ['Rat Heads', 'skewer'], ['Forged Key', 'forged'], ['Branding', 'fire'], ['Burning Stake', 'stake'],
  ['Dog Tag', 'dogtag'], ['Beastcage', 'cage'], ['Iron Maiden', 'maiden'], ['Ravenous Chains', 'ravenous'],
  ['Barbed Whip', 'whip'], ['Short-Chained', 'shortchain'], ['Short Chained', 'shortchain'], ['Blacklist', 'blacklist'],
  ['Scapegoat', 'scapegoat'], ["Kin's Coin", 'coin'], ['Iron Crown', 'crown'], ['Maul', 'maul'], ['Filthy Claws', 'claws'],
  ['Tongs', 'tongs'], ['Scales', 'scales'], ['Fanged Guillotine', 'guillotine'], ['Pestle', 'pestle'], ['Blood-Stained Trap', 'trap'],
  ['Blood Stained Trap', 'trap'],
];
function toolId(name) {
  if (T.TOOLS[name]) return name;
  const s = String(name || '').toLowerCase();
  const hit = TOOL_NAMES.find(([part]) => s.includes(part.toLowerCase()));
  return hit && T.TOOLS[hit[1]] ? hit[1] : null;
}
const OBJECTIVES = { Rei: 'king', Caminhada: 'walk', Sobrevivencia: 'consume', Correntezas: 'incident', Portas: 'doors' };
const START_CARDS = { 'cage fight': 'cagefight', 'iron law': 'ironlaw', tyranny: 'tyranny', opulence: 'opulence' };

// The Tartarus reader (js/scan.js) on the Lanterna's own frame: what the
// Lanterna's reader can't tell (rat nests, doors showing a rarity, scratched by
// the Filthy Claws or not, prey marks, the meals framed on a meal pick, the
// cells framed on the Hunt's pick). Its cache keeps the board's place between
// frames, as the analyzer's reader worker does.
//
// It runs in its own worker (local/lanterna-scan-worker.js): on the main thread a read
// held up the check (a 6 s read left it with no playouts at all). A read past SCAN_MS
// is left out (the advice goes without the extras), the worker still finishing it. The worker
// is kept otherwise: its cache (where the board is) makes the next reads quick. A frame
// that comes while it reads waits its turn, and only the newest waits.
const SCAN_MS = 1500;
let scanQueued = null;
function scanLoad() {
  if (scanWorker) return scanWorker;
  scanWorker = new Worker(path.join(__dirname, 'lanterna-scan-worker.js'));
  scanWorker.on('message', (m) => {
    if (scanWaiting && m.id === scanWaiting.id) scanWaiting.done(m.result);
  });
  scanWorker.on('error', (e) => {
    console.log(`lanterna scan failed: ${e.message}`);
    scanStop();
  });
  scanWorker.unref();
  return scanWorker;
}
function scanStop() {
  const waiting = scanWaiting;
  scanWaiting = null;
  if (scanWorker) scanWorker.terminate();
  scanWorker = null;
  if (waiting) waiting.done(null);
}
function scanFrame(img) {
  const data = new Uint8ClampedArray(img.data);
  return new Promise((resolve) => {
    const job = { width: img.width, height: img.height, data, resolve };
    // Past SCAN_MS (its wait for a turn included) the advice goes on without this read; the
    // worker still finishes it, so its cache learns the board's place.
    job.late = setTimeout(() => {
      console.log(`lanterna scan over ${SCAN_MS} ms: the advice goes without it`);
      resolve(null);
    }, SCAN_MS);
    if (scanWaiting) {
      if (scanQueued) {
        clearTimeout(scanQueued.late);
        scanQueued.resolve(null);
      }
      scanQueued = job;
    } else scanRun(job);
  });
}
function scanRun(job) {
  const w = scanLoad();
  const id = ++scanId;
  // Only a worker stuck for long is started over.
  const timer = setTimeout(scanStop, 15000);
  scanWaiting = {
    id,
    done(result) {
      clearTimeout(job.late);
      clearTimeout(timer);
      if (scanWaiting && scanWaiting.id === id) scanWaiting = null;
      job.resolve(result);
      // The newest frame that waited.
      const next = scanQueued;
      scanQueued = null;
      if (next) scanRun(next);
    },
  };
  w.postMessage({ id, width: job.width, height: job.height, buffer: job.data.buffer }, [job.data.buffer]);
}

// The engine state for a Lanterna reading (js/analyze.js buildState, from the
// screen's terms), with the Tartarus reader's extras (`scan`, or null).
// Returns { st, problem }.
// The phases where the Tartarus reader corrects a beast or rarity (stateFrom), and what it corrected last.
const SCAN_FIRST = ['destino', 'cela', 'caca', 'sala', 'decisao'];
let scanFixes = [];
// previous: the scan is an earlier frame's (adviseNow's first board): its extras only, since the
// warden may have moved since and a replaced inmate would get the old one's beast or rarity.
function stateFrom(r, scan, previous) {
  const fixes = (scanFixes = []);
  // The two readers on one frame: the extras count only where they agree on the warden.
  const sc = scan && scan.cells && (previous || !scan.warden || scan.warden.cell === int(r.diretor, -1)) ? scan : null;
  const maxDays = clamp(int(r.maxDias, T.DEFAULT_PARAMS.drillDays), 5, 60);
  const st = T.newGame({ params: { rewards: true, drillDays: maxDays }, seed: 'LANTERNA' });
  st.rng = (Math.random() * 4294967296) >>> 0;
  st.log = [];
  st.day = clamp(int(r.dia, 1), 1, st.maxDays);
  st.nextId = 1;
  const make = (beast, tier) => ({ id: st.nextId++, beast: T.BEASTS.includes(beast) ? beast : 'mammoth', tier: clamp(int(tier, 0), 0, TOP_TIER) });
  const read = new Map((r.celas || []).map((c) => [int(c.n, -1), c]));
  st.cells = Array.from({ length: T.CELL_COUNT }, (_, n) => {
    const cell = { n, sealed: n !== T.OFFICE, inmate: null, hidden: null, known: 0, scratch: false, nest: null, event: null, ivory: false };
    if (n === T.OFFICE) return cell;
    let c = read.get(n);
    // A door with an event mark: its kind isn't read, so the solver re-rolls it.
    const setEvent = () => {
      cell.seen = !!(c && c.evento);
      if (c && c.evento) {
        cell.event = 'chain';
        cell.eventKnown = false;
      }
    };
    const s = sc ? sc.cells[n] : null;
    if (!c || c.lacrada || !c.ocupada) {
      if (c && !c.lacrada) cell.sealed = false;
      cell.atLeast = 0;
      if (cell.sealed && s && s.kind === 'locked') {
        if (s.nest) {
          // A nest due today hatched this morning, so a sealed one is due later.
          cell.nest = { due: st.day + 1 };
        } else if (s.shown) {
          // The rarity shows; the beast stays hidden (re-rolled by the solver).
          cell.known = 1;
          cell.scratch = !!s.shown.scratch;
          cell.hidden = make(T.BEASTS[Math.floor(Math.random() * 4)], s.shown.tier);
        }
      }
      setEvent();
      return cell;
    }
    cell.sealed = false;
    // Where the two readers see an inmate and differ on its beast or rarity, the Tartarus
    // reader's counts: it finds the board in the frame, while the Lanterna's reads fixed
    // spots (a frame with 8 px of the title bar on top read Magic and Rare as Normal and a
    // Lion as a Mammoth; on frames in place the two agreed on every cell). Not on the meal
    // screens: there the Tartarus reader sees the dimmed inmates as Normal.
    const fix = sc && !previous && SCAN_FIRST.includes(r.fase) && s && s.kind === 'inmate' && s.conf >= 0.6 && T.BEASTS.includes(s.beast) && Number.isFinite(s.tier) && s.tier <= TOP_TIER ? s : null;
    if (fix && Number.isFinite(c.nivel) && (fix.beast !== c.fera || fix.tier !== c.nivel)) {
      fixes.push(`c${n + 1} ${c.fera}${c.nivel}>${fix.beast}${fix.tier}`);
      c = Object.assign({}, c, { fera: fix.beast, nivel: fix.tier });
    }
    // Rainbows leave for the vault: the Lanterna's board keeps Normal to Supreme.
    if (Number.isFinite(c.nivel) && c.nivel <= TOP_TIER && T.BEASTS.includes(c.fera)) {
      cell.inmate = make(c.fera, c.nivel);
      if (s && s.kind === 'inmate' && s.prey) cell.inmate.marked = true;
    }
    setEvent();
    return cell;
  });
  st.prey = [];
  st.vault = Array.from({ length: clamp(int(r.cofre, 0), 0, T.VAULT_SLOTS || 99) }, () => ({ id: st.nextId++, beast: 'mammoth', day: 1 }));
  st.cache = st.vault.length;
  const tools = (r.instrumentos || []).map(toolId).filter(Boolean);
  st.tools = T.TOOL_IDS.filter((id) => tools.includes(id));
  st.position = clamp(int(r.diretor, 0), 0, T.CELL_COUNT - 1);
  st.chain = false;
  const objId = (r.objetivo && OBJECTIVES[r.objetivo.id]) || 'other';
  const need = (T.OBJECTIVES[objId] && T.OBJECTIVES[objId].need) || 0;
  // "Completed" on the panel is the whole need, whatever count was read (2026-10-24: Behind Cell
  // Doors read 9/10 when done; st.milestone already kept it from paying twice).
  st.objective = { id: objId, progress: need ? (r.objetivo && r.objetivo.cumprido ? need : clamp(int(r.objetivo.feito, 0), 0, need)) : 0 };
  const card = START_CARDS[String(r.carta || '').toLowerCase()];
  st.startEvent = card && T.START_EVENTS && T.START_EVENTS[card] ? card : null;
  st.milestone = !!(r.objetivo && r.objetivo.cumprido) || (need > 0 && st.objective.progress >= need);
  st.stats.best = Math.max(0, ...st.cells.filter((c) => c.inmate).map((c) => c.inmate.tier), st.vault.length ? T.RAINBOW : 0);
  st.destinations = [];
  st.event = null;
  st.pending = [];
  st.phase = 'manage';
  const botoes = r.botoes || [];
  // A Hunt marks an inmate the Lion could consume, so it's offered only beside
  // a Consume card (analyze.js): its own card when the reader tells it.
  const usedToday = (extra) => {
    st.used = Object.assign({ swap: 0, devour: 0, devourAfterSwap: botoes.includes('Consume'), noSwap: !botoes.includes('Replace'), noDevour: !botoes.includes('Consume'), noHunt: !(botoes.includes('Hunt') || botoes.includes('Consume')), huntOnly: null, officeOnly: null, mealOnly: null }, extra || {});
  };
  usedToday();
  // The meals a meal pick frames: the Tartarus reader's, else the open cells the Lanterna saw.
  const meals = () => {
    const framed = sc && sc.chain ? sc.chain.targets : r.refeicoes || [];
    const list = framed.map((n) => int(n, -1)).filter((n) => n > 0 && n < T.CELL_COUNT && n !== st.position);
    return list.length ? list : null;
  };
  let problem = null;
  switch (r.fase) {
    case 'destino':
      st.phase = 'patrol';
      // The day's cards come after the patrol: nothing is ruled out yet (analyze.js's patrol step).
      st.used = { swap: 0, devour: 0 };
      // Doors are always among the cells just ahead of the warden, clockwise: one
      // outside them is a misread card (the mouse over "Go to Cell 11" reads "1").
      st.destinations = [...new Set((r.destinos || []).map((n) => int(n, -1)))]
        .filter((n) => n >= 0 && n < T.CELL_COUNT && n !== st.position)
        .filter((n) => T.stepsBetween(st.position, n) >= 1 && T.stepsBetween(st.position, n) <= st.params.patrolRange)
        .sort((a, b) => T.stepsBetween(st.position, a) - T.stepsBetween(st.position, b));
      if (!st.destinations.length) problem = 'sem portas';
      break;
    case 'cela':
      st.phase = 'patrol';
      st.ratway = true;
      st.used = { swap: 0, devour: 0 };
      st.destinations = st.cells.filter((c) => c.n !== T.OFFICE).map((c) => c.n);
      break;
    case 'sala':
      st.phase = 'office';
      usedToday({ officeOnly: botoes.includes('Instigate') && !botoes.includes('Bestow') ? 'instigate' : !botoes.includes('Instigate') && botoes.includes('Bestow') ? 'bestow' : null });
      break;
    case 'decisao':
      break;
    case 'consumir':
      // The day's first meal pick: a meal or Cancel. Only the framed meals can be eaten.
      usedToday({ noSwap: true, noDevour: false, noHunt: true, devourAfterSwap: true, mealOnly: meals() });
      break;
    case 'corrente': {
      // The warden's inmate has eaten and has a meal again: the game asks which
      // to eat, even with only one, and its Cancel stops the chain.
      usedToday({ devour: 1, noSwap: true, noHunt: true, mealOnly: meals() });
      const here = st.cells[st.position];
      if (!here || !here.inmate) problem = 'corrente sem o preso do diretor';
      else st.chaining = { eater: here.inmate.id, at: 0, bites: [] };
      break;
    }
    case 'caca': {
      // The Blood-Stained Trap's Hunt: "Select an Objective" frames the inmates
      // the Lion here can mark. Only the Hunt is open now.
      const framed = sc && sc.decision && Array.isArray(sc.decision.framed) && sc.decision.framed.length < 14 ? sc.decision.framed : null;
      usedToday({ noSwap: true, noDevour: true, noHunt: false, huntOnly: framed });
      break;
    }
    case 'instrumento': {
      const options = [...new Set((r.cartas || []).map(toolId).filter((id) => id && !st.tools.includes(id)))];
      if (!options.length) problem = 'cartas não lidas';
      st.pending = [{ kind: 'tool', options, rerolls: clamp(int(r.refreshes, 0), 0, 9) }];
      break;
    }
    case 'presente':
      // The Treasure's picks waiting, this one included (3 a Treasure with Opulence): the advice weighs them all.
      st.pending = Array.from({ length: clamp(int(r.presentes, 1), 1, 30) }, () => ({ kind: 'gift', options: T.GIFT_IDS.slice(), rerolls: 0 }));
      break;
    default:
      problem = `fase ${r.fase}`;
  }
  return { st, problem };
}

// ---------- The check (js/analyze.js ask/startCheck/merge/bestMove) ----------
let jobId = 0;
function workers() {
  // The C# engine once it said hello (it starts with the first check or warm()); the same
  // number of streams as workers, each on its own thread, below normal.
  motor.start(T, S, motorFailed);
  if (motor.ready) {
    if (!motorPool) {
      motorPool = motor.pool(WORKERS);
      motorPool.forEach((w, k) => w.on('message', (m) => active && active.onShare(k, m)));
    }
    return motorPool;
  }
  if (pool) return pool;
  // The game is open: these playouts yield to it.
  try {
    os.setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch (e) {}
  pool = Array.from({ length: WORKERS }, (_, k) => {
    const w = new Worker(path.join(__dirname, 'lanterna-worker.js'));
    w.on('message', (m) => active && active.onShare(k, m));
    w.on('error', (e) => {
      console.log(`lanterna worker failed: ${e.message}`);
      pool = null;
      if (active) active.finish();
    });
    w.unref();
    return w;
  });
  return pool;
}

// wait: the frame's scan, under way (adviseNow). Until it ends only half the workers play: the scan
// shares the cores with them, and the advice waits for it (with the game open, 15 board frames
// read in 598 ms p50 alone, 877 beside 4 playout workers, 1560 beside 8; 2026-10-24).
function check(st, rollouts, pick, cells, wait) {
  // A check cut short by another board's: its partial answer is never reused.
  if (active) {
    active.cut = true;
    active.finish();
  }
  const id = ++jobId;
  const ws = workers();
  const viaMotor = !!(ws[0] && ws[0].motor);
  const state = JSON.parse(JSON.stringify(st));
  const shares = ws.map((_, k) => ({ target: Math.floor(rollouts / ws.length) + (k < rollouts % ws.length ? 1 : 0), rounds: 0, done: false, rows: null }));
  let meta = null;
  let result = null;
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const job = {
      motor: viaMotor,
      onShare(k, m) {
        if (m.id !== id) return;
        const share = shares[k];
        if (m.meta && !meta) meta = m.meta;
        if (!share.rows) share.rows = m.rows.map(() => ({ vals: [], best: 0 }));
        m.rows.forEach((r, i) => {
          for (const v of r.vals) share.rows[i].vals.push(v);
          share.rows[i].best = r.best;
        });
        share.rounds = m.rounds;
        share.done = m.done;
        merge();
        if (result && (result.done || settled())) job.finish();
      },
      finish() {
        if (active !== job) return;
        active = null;
        clearTimeout(timer);
        for (const w of ws) w.postMessage({ stop: true, id });
        if (result && job.cut) result.cut = true;
        resolve(result);
      },
    };
    const merge = () => {
      if (!meta) return;
      const rows = meta.map((mt, i) => {
        const row = Object.assign({ vals: [], best: 0 }, mt);
        for (const s of shares) {
          const r = s.rows && s.rows[i];
          if (!r) continue;
          for (const v of r.vals) row.vals.push(v);
          row.best += r.best;
        }
        return row;
      });
      const rounds = shares.reduce((sum, s) => sum + s.rounds, 0);
      result = Object.assign(S.summarize(rows, rounds, rollouts), { done: shares.every((s) => s.done), motor: viaMotor ? 'cs' : 'js' });
    };
    const settled = () => {
      if (result.options.length <= 1) return true;
      const [top, ...rest] = result.options;
      if (result.rounds < LIVE_MIN) return false;
      if (rest.every((o) => o.gapSe > 0 && top.mean - o.mean > CLEAR_SE * o.gapSe)) return true;
      // analyze.js settled(), local build: the strategy's pick leads and no other move can
      // get ahead of it by more than switchMin: more playouts can't change the advice.
      return !!pick && S.sameAction(top.action, pick.action) && rest.every((o) => top.mean - o.mean >= CLEAR_SE * o.gapSe - TUNING.switchMin);
    };
    // The Lanterna's cap (LANTERNA_MS, 1.2 s): the overlay's 3 s was most of the wait on
    // every screen. Past it the check stops once it has LIVE_MIN playouts (best() then lets it
    // lead), and at TUNING.ms in any case. With fewer playouts the margins are wider, so the
    // strategy's pick holds more often: the advice is still the AI's. A check whose pace
    // can't reach LIVE_MIN by TUNING.ms stops at the cap: at 3 s it would give the same
    // strategy's pick (a cell pick, 16 options, had 92 playouts in 3 s).
    let timer;
    const cap = () => {
      const spent = Date.now() - startedAt;
      if (result && result.rounds < LIVE_MIN && spent < TUNING.ms && result.rounds + (result.rounds / spent) * (TUNING.ms - spent) >= LIVE_MIN) {
        timer = setTimeout(cap, 50);
        return;
      }
      // A close call (2026-10-25): past the cap, a move still within 2 standard errors of the
      // leader, with errors that big enough to matter (over switchMin), keeps the check going
      // up to LANTERNA_MS_DIFICIL or until it settles. Plain ties (gaps under switchMin, as 15
      // locked doors) don't wait.
      if (result && result.rounds >= LIVE_MIN && spent < Math.min(LANTERNA_MS_DIFICIL, TUNING.ms) && !settled() && close()) {
        result.extra = true;
        timer = setTimeout(cap, 50);
        return;
      }
      if (result) result.early = !result.done;
      job.finish();
    };
    const close = () => {
      const [top, ...rest] = result.options;
      return rest.some((o) => o.gapSe > TUNING.switchMin / 2 && top.mean - o.mean < 2 * o.gapSe);
    };
    timer = setTimeout(cap, Math.min(LANTERNA_MS, TUNING.ms));
    active = job;
    const go = (k) => ws[k].postMessage({ id, state, rollouts: shares[k].target, stream: k, cells });
    const first = wait ? Math.max(1, Math.ceil(ws.length / 2)) : ws.length;
    for (let k = 0; k < first; k++) go(k);
    if (first < ws.length) {
      wait.then(() => {
        if (active !== job) return;
        for (let k = first; k < ws.length; k++) go(k);
      });
    }
  });
}

// The strategy's pick, unless the check found a clearly better move (bestMove()).
function best(pick, r) {
  const ranked = r ? r.options : [];
  // As bestMove(): a check cut short by the time cap leads only with LIVE_MIN playouts each.
  const live = r && ranked.length > 1 && ((r.done && !r.early) || r.rounds >= LIVE_MIN) ? ranked[0] : null;
  const mine = pick && ranked.find((o) => S.sameAction(o.action, pick.action));
  if (!live) return pick ? { action: pick.action, label: pick.label, why: pick.why, live: false } : ranked.length === 1 ? { action: ranked[0].action, label: ranked[0].label, why: 'It’s the only move here.', live: true } : null;
  if (mine && (mine === live || live.mean - mine.mean <= Math.max(1.96 * mine.gapSe, TUNING.switchMin))) return { action: pick.action, label: mine.label, why: pick.why, live: true, mean: mine.mean };
  return { action: live.action, label: live.label, why: 'The playouts found a better move than the strategy’s quick pick.', live: true, mean: live.mean };
}

// The Lanterna's runs, as the overlay records its own (records/<run>/record.jsonl,
// "advice" lines with the analyzer's board model), so the studies of the
// user's runs (local/jobs.js USER_TOOLS, diagnostico.js) count them too.
const RECORDS = path.join(__dirname, 'lanterna-records');
function boardModel(st, reading) {
  const cell = (c) => {
    if (c.n === T.OFFICE) return { kind: 'office' };
    if (c.inmate) return { kind: 'inmate', event: c.event ? 'unknown' : null, beast: c.inmate.beast, tier: c.inmate.tier, ivory: !!c.ivory, prey: null, marked: !!c.inmate.marked };
    if (!c.sealed) return { kind: 'empty' };
    if (c.nest) return { kind: 'nest', due: c.nest.due };
    if (c.known && c.hidden) return { kind: c.scratch ? 'scratch' : 'revealed', tier: c.hidden.tier, event: c.event ? 'unknown' : null };
    return { kind: 'sealed', event: c.event ? 'unknown' : null };
  };
  return {
    v: 1,
    mode: 'drill',
    rewards: true,
    day: st.day,
    maxDays: st.maxDays,
    step: { destino: 'patrol', cela: 'ratway', sala: 'office', corrente: 'chain', instrumento: 'choice', presente: 'choice' }[reading.fase] || 'manage',
    warden: st.position,
    dest: st.destinations.slice(),
    choice: st.pending.length ? { kind: st.pending[0].kind, options: st.pending[0].options.slice(), rerolls: st.pending[0].rerolls || 0, picks: st.pending.length } : undefined,
    objective: st.objective.id,
    startEvent: st.startEvent || 'none',
    walkTiles: st.objective.progress,
    milestone: !!st.milestone,
    tools: st.tools.slice(),
    vault: st.vault.map((v) => v.beast),
    cells: st.cells.map(cell),
  };
}
// LANTERNA_SEM_REGISTRO=1 (o teste do atualizador do Lanterna, os demos): nada vai para as runs
// nem para o lanterna-tempos.log, que contam só as jogadas de verdade.
const NO_RECORD = !!process.env.LANTERNA_SEM_REGISTRO;
function record(st, reading, out) {
  if (NO_RECORD) return;
  try {
    const now = new Date();
    // One folder a run: a new run starts on day 1's instrument pick or when the days go back.
    const day = st.day;
    if (!record.run || day < record.day || (reading.fase === 'instrumento' && day === 1 && record.day > 1)) record.run = now.toISOString().slice(0, 19).replace(/:/g, '-');
    record.day = day;
    const dir = path.join(RECORDS, record.run);
    fs.mkdirSync(dir, { recursive: true });
    const line = { at: now.toISOString(), type: 'advice', source: 'lanterna', board: boardModel(st, reading), advice: { move: out.label, why: out.why, live: !!out.live, mean: out.mean } };
    fs.appendFileSync(path.join(dir, 'record.jsonl'), `${JSON.stringify(line)}\n`);
  } catch (e) {
    console.log(`lanterna record failed: ${e.message}`);
  }
}

// The last frame's scan, by the Lanterna's key for its screen: the quick
// answer reads the frame, the checked one that follows reuses it.
let lastScan = { key: null, scan: null };

async function advise(reading, img) {
  // LANTERNA_LOG=<file>: each reading and its advice, one JSON line each (to compare boards).
  const logTo = process.env.LANTERNA_LOG;
  const out = await adviseNow(reading, img);
  if (logTo) fs.appendFileSync(logTo, `${JSON.stringify({ reading, out })}\n`);
  return out;
}

// The board the overlay builds for this reading: the Lanterna's board goes through
// js/analyze.js's own modelFrom and buildState (local/analyze-node.js), so the AI plays
// the overlay's board, and a board the overlay refuses is refused with its message.
// local/lanterna-paridade.js checks that nothing read is lost on the way.
const analyzeNode = require('./analyze-node.js');
function overlayBoard(mine) {
  if (mine.problem) return mine;
  let az;
  try {
    az = analyzeNode.load(T, S);
  } catch (e) {
    console.log(`lanterna: analyze.js not loaded (${e.message}); playing the Lanterna's own board`);
    return mine;
  }
  const model = az.modelFrom(mine.st, az.blankModel());
  // The overlay's reader marks the office step when it sees Instigate or Bestow;
  // modelFrom leaves it to the reader.
  if (mine.st.phase === 'office') model.step = 'office';
  const built = az.buildState(model);
  if (built.problems && built.problems.length) return { st: null, problem: built.problems[0] };
  built.st.rng = mine.st.rng;
  return { st: built.st, problem: null };
}
function boardFrom(reading, scan, previous) {
  return overlayBoard(stateFrom(reading, scan, previous));
}
// A board for comparing: the dice and a shown door's beast (drawn at random, the solver
// re-rolls it) aren't the board.
function boardKey(st) {
  return JSON.stringify(Object.assign({}, st, { rng: 0, cells: st.cells.map((c) => (c.hidden ? Object.assign({}, c, { hidden: { tier: c.hidden.tier } }) : c)) }));
}

// reading.previa: the Lanterna's first read of a new screen, sent one read before the one that
// confirms it (Orquestrador.Antecipar). Its scan and check start then; the confirmed request for
// the same screen joins them: the check by its board (start()), the scan by previewKey. The
// advice is the same, one read sooner. A preview is answered at once and never recorded.
const PREVIEW_MS = 5000;
let preview = null;
function previewKey(r) {
  const o = Object.assign({}, r);
  for (const k of ['chave', 'rapido', 'previa', 'quadro']) delete o[k];
  return JSON.stringify(o);
}

// reading.rapido: the strategy's own pick at once (no playouts), as the
// overlay's "likely move"; the Lanterna asks again for the checked one.
async function adviseNow(reading, img) {
  const t0 = Date.now();
  loadAi();
  let scan = !img && reading.chave && lastScan.key === reading.chave ? lastScan.scan : null;
  // With a frame: the playouts start while the frame is scanned (the scan takes about a
  // second), on the reading plus the last frame's extras (a shown door's rarity, a nest, prey
  // marks: they stay from screen to screen), and start over only when this frame's scan
  // changes the board. On the reading alone, about 1 in 7 destination and decision screens
  // started over for those extras (+1.4 s; 2026-10-24's runs).
  // The instrument and gift picks cover the board: the reader finds nothing there to add,
  // and its second or two was all the wait (the check had already settled).
  const scanned = !!img && reading.fase !== 'instrumento' && reading.fase !== 'presente';
  // Not on the meal screens: there the reader sees the dimmed inmates otherwise, and a
  // board from the last frame's extras started over more often (consumir 4 > 10 restarts).
  const previous = scanned && SCAN_FIRST.includes(reading.fase) && !scan && !!lastScan.scan;
  let { st, problem } = boardFrom(reading, previous ? lastScan.scan : scan, previous);
  // The scan starts first: the check plays on half the workers until it ends (check()).
  // A preview's scan (the same screen read once before) is this request's: scanning the frame
  // again would wait for it in the worker's queue.
  const pk = previewKey(reading);
  const joined = scanned && !reading.previa && preview && preview.key === pk && Date.now() - preview.at < PREVIEW_MS ? preview.scanning : null;
  const scanning = scanned ? joined || scanFrame(img) : null;
  if (reading.previa && scanning) preview = { key: pk, scanning, at: Date.now() };
  let plan = problem ? null : start(st, reading.rapido, scanning);
  let tScan = 0;
  let fixed = [];
  if (scanned) {
    scan = await scanning;
    tScan = Date.now() - t0;
  }
  // A scan past SCAN_MS (null) keeps the first board: the last frame's extras beat none.
  if (scan && scanned) {
    lastScan = { key: reading.chave || null, scan };
    const again = boardFrom(reading, scan);
    fixed = scanFixes.slice();
    if (again.problem || problem || boardKey(again.st) !== boardKey(st)) {
      if (!problem && !again.problem && !reading.rapido) console.log(`lanterna: the scan changed the ${reading.fase} board; the check starts over`);
      ({ st, problem } = again);
      plan = problem ? null : start(st, reading.rapido);
    }
  }
  if (problem) return { problema: problem };
  if (!plan.options) return { problema: 'nenhuma jogada' };
  const { pick } = plan;
  if (reading.rapido) {
    if (!pick) return { problema: 'sem conselho rápido' };
    return { action: pick.action, label: pick.label, why: pick.why, live: false, rapido: true, rounds: 0 };
  }
  const r = await plan.check;
  const rec = best(pick, r);
  if (!rec) return { problema: 'sem conselho' };
  const out = Object.assign(rec, { rounds: r ? r.rounds : 0, ms: Date.now() - t0, msScan: tScan, cut: !!(r && r.cut), extra: !!(r && r.extra), fixed, motor: r ? r.motor : null });
  if (!reading.previa) tempo(reading, out);
  // A cut check's answer goes to a screen the Lanterna has left: not a move of the run.
  if (!out.cut && !reading.previa) record(st, reading, out);
  return out;
}

// The strategy's pick and the playouts' check for a board (check() drops any check still running).
// The same board asked again (the Lanterna asks anew when its key for the screen changes, and
// the board often doesn't) joins the check under way, or takes the answer of one that ended
// in the last minutes (a look at the board by the eye and back, a screen read again), instead
// of starting over: starting over cut the first one short, and the advice came only after both.
// A new AI (training, update) clears them (loadAi).
const REUSE_MS = 5 * 60 * 1000;
const PLANS_MAX = 40;
// The free cell pick (Ratway: any of 15 doors): split over every door the check got 92-153
// rounds in 1.2-3 s, and 3 of 8 stayed under LIVE_MIN (the strategy's pick, unchecked). It plays
// only the strategy's best TOP_CELLS doors (patrolScores) and its pick: on the 7 such boards in
// the records, 400 rounds on all 15 doors found the best one inside its top 5 every time (2nd on
// 2 of them, where the strategy picked another). null: every option is played.
const TOP_CELLS = 5;
function focus(st, pick) {
  const doors = S.candidates(st).filter((c) => c.action.type === 'patrol');
  if (doors.length <= TOP_CELLS) return null;
  try {
    const cells = S.patrolScores(st, S.context(st, S.paramsFor(st))).slice(0, TOP_CELLS).map((s) => s.cell);
    if (pick && pick.action.type === 'patrol' && !cells.includes(pick.action.cell)) cells.push(pick.action.cell);
    return cells.length ? cells : null;
  } catch (e) {
    return null;
  }
}
function start(st, rapido, wait) {
  const key = rapido ? null : boardKey(st);
  const seen = key && plans.get(key);
  if (seen && (seen.running || Date.now() - seen.at < REUSE_MS)) return seen.plan;
  let pick = null;
  try {
    pick = S.instant(st);
  } catch (e) {}
  const cells = focus(st, pick);
  const options = cells ? S.candidates(st).filter((c) => c.action.type !== 'patrol' || cells.includes(c.action.cell)).length : S.candidates(st).length;
  const rollouts = clamp(Math.round(TUNING.budget / Math.max(1, options)), 400, TUNING.maxPer);
  const run = !rapido && options > 1 ? check(st, rollouts, pick, cells, wait) : Promise.resolve(null);
  const plan = { pick, options, check: run };
  if (key) {
    const entry = { plan, running: true, at: Date.now() };
    plans.delete(key);
    plans.set(key, entry);
    // The oldest go first (a Map keeps the order they came in).
    while (plans.size > PLANS_MAX) plans.delete(plans.keys().next().value);
    run.then((r) => {
      entry.running = false;
      entry.at = Date.now();
      if (r && r.cut && plans.get(key) === entry) plans.delete(key);
    });
  }
  return plan;
}

// One line a request in local/lanterna-tempos.log (2 MB, then .1),
// to tell where a slow answer's time went.
// LANTERNA_TEMPOS=<file>: another file (tests), written even with LANTERNA_SEM_REGISTRO.
const TEMPOS = process.env.LANTERNA_TEMPOS || path.join(__dirname, 'lanterna-tempos.log');
let lastAsked = null;
function tempo(reading, out) {
  if (NO_RECORD && !process.env.LANTERNA_TEMPOS) return;
  try {
    // What changed since the request before on the same kind of screen (why one screen was asked twice).
    const changed = lastAsked && lastAsked.fase === reading.fase ? Object.keys(reading).filter((k) => k !== 'chave' && k !== 'quadro' && JSON.stringify(reading[k]) !== JSON.stringify(lastAsked[k])) : [];
    const lastSeen = lastAsked;
    lastAsked = reading;
    // A list of the same length: only the items that changed (a cell read differently).
    const diff = (k) => {
      const a = reading[k];
      const b = lastSeen[k];
      if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) return a.map((v, i) => (JSON.stringify(v) !== JSON.stringify(b[i]) ? `${k}[${i}]=${JSON.stringify(v)}` : null)).filter(Boolean).join(' ');
      return `${k}=${JSON.stringify(a).slice(0, 80)}`;
    };
    const what = changed.map(diff).join(' ');
    const line = `${new Date().toISOString()} ${reading.fase} chave=${reading.chave} ms=${out.ms} scan=${out.msScan} rounds=${out.rounds} live=${!!out.live} ${out.motor ? `motor=${out.motor} ` : ''}${out.cut ? 'cortada ' : ''}${out.extra ? 'dificil ' : ''}${out.fixed && out.fixed.length ? `leitor do Tartarus: ${out.fixed.join(' ')} ` : ''}${what ? `mudou: ${what} ` : ''}${out.label || out.problema || ''}\n`;
    if (fs.existsSync(TEMPOS) && fs.statSync(TEMPOS).size > 2 * 1024 * 1024) fs.renameSync(TEMPOS, `${TEMPOS}.1`);
    fs.appendFileSync(TEMPOS, line);
  } catch (e) {}
}

// Wired into local/serve.js: true when it took the request.
function handle(req, res) {
  if (!req.url.startsWith('/lanterna/')) return false;
  // The Lanterna pings first: the C# engine starts then, ready before the first check (a
  // server started without --update has no warm()).
  motor.start(T, S, motorFailed);
  const reply = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'GET' && req.url === '/lanterna/ping') {
    reply(200, { ok: true });
    return true;
  }
  // The Lanterna's "Atualizar agora": the server closes, and the Lanterna starts it again
  // with the updated code (a new AI alone loadAi would take, but not this file or serve.js).
  if (req.method === 'POST' && req.url === '/lanterna/sair') {
    reply(200, { ok: true });
    console.log('lanterna: asked to close (Atualizar agora)');
    setTimeout(() => process.exit(0), 100);
    return true;
  }
  if (req.method !== 'POST' || req.url !== '/lanterna/advise') {
    reply(404, { problema: 'não existe' });
    return true;
  }
  // The body is the reading's JSON, or, as application/octet-stream, a 4-byte
  // little-endian length, that JSON, and the frame's RGBA pixels
  // (reading.quadro = { w, h }) for the Tartarus reader.
  const parts = [];
  let size = 0;
  req.on('data', (d) => {
    parts.push(d);
    size += d.length;
    if (size > 64e6) req.destroy();
  });
  req.on('end', () => {
    const body = Buffer.concat(parts);
    let reading;
    let img = null;
    try {
      if (String(req.headers['content-type'] || '').startsWith('application/octet-stream')) {
        const n = body.readUInt32LE(0);
        reading = JSON.parse(body.subarray(4, 4 + n).toString('utf8'));
        const q = reading.quadro;
        const px = body.subarray(4 + n);
        if (q && px.length === q.w * q.h * 4) img = { width: q.w, height: q.h, data: new Uint8ClampedArray(px.buffer, px.byteOffset, px.length) };
      } else reading = JSON.parse(body.toString('utf8'));
    } catch (e) {
      reply(400, { problema: 'pedido inválido' });
      return;
    }
    // A preview: answered at once, its scan and check go on for the confirmed request.
    if (reading.previa) {
      reply(202, { previa: true });
      advise(reading, img).catch(() => {});
      return;
    }
    advise(reading, img).then(
      (out) => reply(200, out),
      (e) => reply(500, { problema: e.message }),
    );
  });
  return true;
}

// The server started by the Lanterna (serve.js --update) gets everything ready at once: the
// reader's art, the overlay's analyzer, the workers, and a short check that warms their code,
// so the first screen of a session isn't the slow one.
function warm() {
  try {
    loadAi();
    motor.start(T, S, motorFailed);
    scanLoad();
    const { st } = boardFrom({ fase: 'destino', dia: 1, maxDias: 20, diretor: 0, celas: [], destinos: [1, 2, 3] }, null);
    // With the C# engine's hello first, so the warm-up doesn't start the JS workers.
    if (st) motor.whenReady(3000).then(() => check(st, 60, null)).then(() => console.log('lanterna: ready'));
  } catch (e) {
    console.log(`lanterna warm-up failed: ${e.message}`);
  }
}

module.exports = { warm, handle, advise, stateFrom, boardFrom, boardModel, toolId, focus };
