import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../src/engine.mjs';
import { createDebugStore } from '../src/debug.mjs';
import { DecisionError } from '../src/decision.mjs';

const decision = (action = 'demo', confidence = 0.97) => ({ action, confidence, source: 'openai', decisionMs: 21 });
async function fixture(decide = async () => decision()) {
  let time = 1700000000000;
  const engine = createEngine({ apiKey: 'secret-key-must-not-be-logged', decide, now: () => time });
  await engine.configure({ provider: 'openai' }); engine.arm(true);
  return { engine, advance: ms => { time += ms; } };
}

test('inspector separates the transcript, request context, model result, policy and dispatch', async () => {
  const { engine } = await fixture(async text => text === 'Here is an application.' ? decision('none') : decision());
  await engine.cue('Here is an application.');
  const proposed = await engine.cue('Let us try it now');
  let trace = proposed.debug.turns[0];
  assert.equal(trace.transcript.final, 'Let us try it now');
  assert.deepEqual(trace.context.recentUtterances, ['Here is an application.']);
  assert.equal(trace.request.input.at(-1).content[0].text, 'Let us try it now');
  assert.equal(trace.request.model, 'gpt-6-luna');
  assert.equal(trace.decision.action, 'demo');
  assert.equal(trace.route.status, 'awaiting_confirmation');
  assert.equal(trace.output.status, 'not_sent');
  assert.equal(trace.timings.decisionMs, 21);
  await engine.confirm(proposed.pending.id);
  trace = engine.snapshot().debug.turns[0];
  assert.equal(trace.route.status, 'executed');
  assert.match(trace.route.reason, /Presenter confirmed/);
  assert.equal(trace.output.status, 'simulated');
  assert.equal(trace.output.scene, 'Demo');
  assert.ok(Number.isFinite(trace.timings.dispatchMs));
  assert.equal(JSON.stringify(engine.snapshot()).includes('secret-key-must-not-be-logged'), false);
});

test('debug explains the actual no-action and confidence branches', async () => {
  for (const [action, confidence, mode, status, reason] of [
    ['none', 0.99, 'auto', 'ignored', /selected none/],
    ['demo', 0.39, 'auto', 'ignored', /below the 60%/],
    ['demo', 0.7, 'auto', 'awaiting_confirmation', /below the 85%/],
    ['demo', 0.99, 'ask', 'awaiting_confirmation', /Ask first/],
  ]) {
    const { engine } = await fixture(async () => decision(action, confidence));
    await engine.configure({ mode });
    const { debug, history } = await engine.cue('sample cue');
    assert.equal(debug.turns[0].route.status, status);
    assert.match(debug.turns[0].route.reason, reason);
    assert.equal(debug.turns[0].decision.confidence, confidence);
    assert.equal(debug.turns[0].output.status, 'not_sent');
    if (status === 'ignored') {
      assert.match(history[0].message, reason);
      assert.match(history[0].message, /Nothing changed/);
    }
  }
});

test('debug follows confirmation expiry and dismissal', async () => {
  const { engine, advance } = await fixture();
  await engine.cue('show the demo');
  advance(15000);
  assert.equal(engine.snapshot().debug.turns[0].route.status, 'expired');
  await engine.cue('show the demo');
  await engine.cancel();
  assert.equal(engine.snapshot().debug.turns[0].route.status, 'cancelled');
});

test('a late result after Stop cannot replace the cancelled debug outcome', async () => {
  let resolve;
  const { engine } = await fixture(() => new Promise(done => { resolve = done; }));
  const pending = engine.cue('show the demo');
  assert.equal(engine.snapshot().debug.turns[0].route.status, 'processing');
  await engine.stop(); resolve(decision()); await pending;
  const trace = engine.snapshot().debug.turns[0];
  assert.equal(trace.route.status, 'cancelled');
  assert.equal(trace.decision, null);
  assert.equal(trace.output.status, 'not_sent');
});

test('clearing debug does not cancel a pending action or resurrect cleared traces', async () => {
  let resolve;
  const { engine } = await fixture(() => new Promise(done => { resolve = done; }));
  const work = engine.cue('show the demo');
  engine.clearDebug();
  assert.equal(engine.snapshot().busy, true);
  resolve(decision());
  const pending = await work;
  assert.equal(pending.debug.turns.length, 0);
  await engine.confirm(pending.pending.id);
  assert.equal(engine.snapshot().currentScene, 'Demo');
  assert.equal(engine.snapshot().debug.turns.length, 0);
});

test('errors and offline/manual inputs are labelled without claiming an AI result', async () => {
  const { engine } = await fixture(async () => { throw new DecisionError('TIMEOUT'); });
  await assert.rejects(engine.cue('show the demo'));
  assert.equal(engine.snapshot().debug.turns[0].decision.code, 'TIMEOUT');
  assert.equal(engine.snapshot().debug.turns[0].route.status, 'error');
  await engine.configure({ provider: 'rehearsal' }); engine.arm(true);
  await engine.cue('show the demo');
  let trace = engine.snapshot().debug.turns[0];
  assert.equal(trace.request, null);
  assert.equal(trace.context, null);
  assert.equal(trace.decision.source, 'rehearsal');
  await engine.manual('slides');
  trace = engine.snapshot().debug.turns[0];
  assert.equal(trace.input.kind, 'manual');
  assert.equal(trace.decision, null);
  assert.equal(trace.output.status, 'simulated');
});

test('trace storage is bounded and snapshots cannot mutate it', () => {
  const debug = createDebugStore();
  const first = debug.begin({ text: 'first' });
  for (let i = 0; i < 30; i++) debug.begin({ text: `cue ${i}` });
  const snapshot = debug.snapshot();
  assert.equal(snapshot.turns.length, 20);
  debug.update(first, { route: { status: 'executed' } });
  assert.equal(debug.snapshot().turns.length, 20);
  snapshot.turns[0].transcript.final = 'tampered';
  assert.equal(debug.snapshot().turns[0].transcript.final, 'cue 29');
});

test('queued and in-flight dispatch traces both reflect Stop without late success', async () => {
  let finish;
  let began;
  const started = new Promise(resolve => { began = resolve; });
  const engine = createEngine({
    apiKey: 'test-key', decide: async () => decision(),
    obs: { status: () => ({connected:true}), stop: async () => {}, execute: () => { began(); return new Promise(resolve => { finish = resolve; }); } },
  });
  await engine.configure({provider:'openai',target:'obs',mode:'auto'}); engine.arm(true);
  const first = engine.cue('first');
  await started;
  const second = engine.cue('second');
  await new Promise(resolve => setImmediate(resolve));
  await engine.stop();
  finish();
  await Promise.all([first, second]);
  const traces = engine.snapshot().debug.turns;
  assert.equal(traces.length, 2);
  assert.ok(traces.every(trace => trace.route.status === 'cancelled'));
  assert.ok(traces.every(trace => trace.output.status !== 'acknowledged'));
});
