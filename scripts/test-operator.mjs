// Local E2E harness for the operator serverless function.
// Runs the REAL flow against live testnets using the wallet in .env:
//   start -> (wait for attestation) -> advance (submit batch proof) -> settle
//
// Usage:  node --env-file=.env --experimental-strip-types scripts/test-operator.mjs [DEVICE_NAME]
//   DEVICE_NAME must be new (on-chain uniqueness). Defaults to a random NODE-####.
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { default: handler } = await import(
  pathToFileURL(path.join(__dirname, '..', 'api', 'operator.ts')).href
);

function makeRes() {
  const out = { statusCode: 0, body: null };
  const res = {
    setHeader() {},
    status(c) { out.statusCode = c; return res; },
    json(b) { out.body = b; return res; },
    end() {},
  };
  return { res, out };
}

async function call(action, payload = {}) {
  const req = { method: 'POST', headers: { 'x-forwarded-for': 'local-test' }, body: { action, ...payload } };
  const { res, out } = makeRes();
  await handler(req, res);
  if (out.statusCode !== 200) {
    throw new Error(`${action} failed (${out.statusCode}): ${JSON.stringify(out.body)}`);
  }
  console.log(`\n[${action}] ${JSON.stringify(out.body, null, 2)}`);
  return out.body;
}

const name = process.argv[2] || `NODE-${Date.now().toString().slice(-4)}`;
console.log(`\n=== operator E2E — device "${name}" ===`);

const started = await call('start', {
  deviceName: name,
  requiredWindows: Number(process.argv[3] || 10), // brief demo = 10 windows
  minUptimeBps: 9800,
  collateralCTC: 100,
  rewardCTC: 40,
});
const { slaId } = started;

// Poll advance until the windows are proven (attestation can take minutes).
let state = null;
for (let i = 0; i < 60; i++) {
  state = await call('advance', { slaId });
  if (state.status === 'complete' || state.status === 'settled') break;
  if (state.status === 'idle') break;
  const wait = (state.retryIn ?? 15) * 1000;
  console.log(`  -> retrying in ${wait / 1000}s (attempt ${i + 1}/60)`);
  await new Promise((r) => setTimeout(r, wait));
}

if (state?.status !== 'complete' && state?.status !== 'settled') {
  console.log('\n[ABORT] did not reach complete:', JSON.stringify(state, null, 2));
  process.exit(1);
}

const settled = await call('settle', { slaId });
console.log(`\n=== DONE — ${name} ${settled.status} outcome=${settled.outcome} settleTx=${settled.settleTx || ''} ===`);
