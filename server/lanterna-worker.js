// Worker of local/lanterna.js: plays the Lanterna's board out with the
// simulator's solver (as js/solver-worker.js does for the analyzer page) and
// streams each round's values back, so several run at once on their own dice.
'use strict';
const { parentPort } = require('worker_threads');
const S = require('../js/solver.js');

let current = 0;

parentPort.on('message', (m) => {
  if (m.stop) {
    if (m.id === current) current = 0;
    return;
  }
  const { id, state, rollouts, stream } = m;
  current = id;
  const job = S.solve(state, { rollouts, stream: stream || 0, seed: (id * 7919 + 1) >>> 0 });
  let sent = 0;
  const tick = () => {
    if (id !== current) return;
    const result = job.step(60);
    parentPort.postMessage({
      id,
      rounds: result.rounds,
      done: result.done,
      goal: result.goal,
      meta: sent === 0 ? job.rows.map((r) => ({ label: r.label, action: r.action, kind: r.kind, policy: r.policy })) : null,
      rows: job.rows.map((r) => ({ vals: r.vals.slice(sent), best: r.best })),
    });
    sent = result.rounds;
    if (!result.done) setImmediate(tick);
  };
  tick();
});
