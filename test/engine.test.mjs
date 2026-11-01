import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../src/engine.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const result = (action = 'demo', confidence = 0.97) => ({ action, confidence, source: 'openai', decisionMs: 12 });

async function harness({ decide = async () => result(), execute, stop } = {}) {
  let clock = 1_700_000_000_000;
  const calls = [];
  const obs = {
    status: () => ({ connected: true, scenes: ['Slides', 'Demo'] }),
    execute: async action => { calls.push(['execute', action]); await execute?.(action); },
    stop: async () => { calls.push(['stop']); await stop?.(); },
  };
  const engine = createEngine({ obs, decide, apiKey: 'test-api-key', now: () => clock });
  await engine.configure({ provider: 'openai', target: 'obs' });
  engine.arm(true);
  return { engine, calls, advance: milliseconds => { clock += milliseconds; } };
}

function executed(snapshot) {
  return snapshot.history.filter(event => event.type === 'executed');
}

test('Ask proposes a cue without output and a confirmation executes exactly once', async () => {
  const { engine, calls } = await harness();
  const proposed = await engine.cue("So let's see the demo");
  assert.equal(proposed.pending.action, 'demo');
  assert.equal(proposed.currentScene, 'Slides');
  assert.deepEqual(calls, []);
  const id = proposed.pending.id;
  const confirms = await Promise.allSettled([engine.confirm(id), engine.confirm(id)]);
  assert.equal(confirms.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(confirms.filter(item => item.status === 'rejected').length, 1);
  assert.deepEqual(calls, [['execute', 'demo']]);
  assert.equal(engine.snapshot().currentScene, 'Demo');
  assert.equal(engine.snapshot().pending, null);
  assert.equal(executed(engine.snapshot()).length, 1);
});

test('a stale confirmation cannot remove or execute a newer proposal', async () => {
  const { engine, calls } = await harness();
  const first = await engine.cue('show the demo');
  const second = await engine.cue('switch to demo');
  assert.notEqual(first.pending.id, second.pending.id);
  await assert.rejects(engine.confirm(first.pending.id), /expired or was cancelled/);
  assert.equal(engine.snapshot().pending?.id, second.pending.id);
  assert.deepEqual(calls, []);
  await engine.confirm(second.pending.id);
  assert.deepEqual(calls, [['execute', 'demo']]);
});

test('a proposal expires at 15 seconds and cannot execute', async () => {
  const { engine, calls, advance } = await harness();
  const proposal = await engine.cue('show the demo');
  advance(15_000);
  await assert.rejects(engine.confirm(proposal.pending.id), /expired or was cancelled/);
  assert.equal(engine.snapshot().pending, null);
  assert.deepEqual(calls, []);
  assert.equal(executed(engine.snapshot()).length, 0);
});

test('Stop aborts an outstanding decision and late success cannot propose or execute', async () => {
  const pending = deferred();
  let requestSignal;
  const { engine, calls } = await harness({ decide: (_text, { signal }) => { requestSignal = signal; return pending.promise; } });
  await engine.configure({ mode: 'auto' });
  const work = engine.cue('drop the beat');
  assert.equal(engine.snapshot().busy, true);
  await engine.stop();
  assert.equal(requestSignal.aborted, true);
  assert.equal(engine.snapshot().armed, false);
  pending.resolve(result('music_on'));
  const snapshot = await work;
  assert.equal(snapshot.pending, null);
  assert.equal(snapshot.busy, false);
  assert.equal(snapshot.musicPlaying, false);
  assert.equal(executed(snapshot).length, 0);
  assert.deepEqual(calls, [['stop']]);
});

test('Stop handles a late rejected decision without surfacing a stale error', async () => {
  const pending = deferred();
  const { engine } = await harness({ decide: () => pending.promise });
  const work = engine.cue('show the demo');
  await engine.stop();
  pending.reject(new Error('request aborted'));
  const snapshot = await work;
  assert.equal(snapshot.history.some(item => item.type === 'error'), false);
  assert.equal(snapshot.pending, null);
});

for (const [field, value] of [['mode', 'auto'], ['provider', 'rehearsal'], ['target', 'rehearsal']]) {
  test(`${field} changes invalidate an outstanding decision`, async () => {
    const pending = deferred();
    let requestSignal;
    const { engine, calls } = await harness({ decide: (_text, { signal }) => { requestSignal = signal; return pending.promise; } });
    const work = engine.cue('show the demo');
    await engine.configure({ [field]: value });
    assert.equal(requestSignal.aborted, true);
    pending.resolve(result());
    const snapshot = await work;
    assert.equal(snapshot.pending, null);
    assert.equal(snapshot.busy, false);
    assert.equal(snapshot.currentScene, 'Slides');
    assert.equal(executed(snapshot).length, 0);
    assert.equal(calls.some(([method]) => method === 'execute'), false);
    if (field !== 'mode') assert.equal(snapshot.armed, false);
  });
}

test('mode change invalidates an already proposed confirmation', async () => {
  const { engine, calls } = await harness();
  const proposal = await engine.cue('show the demo');
  await engine.configure({ mode: 'auto' });
  await assert.rejects(engine.confirm(proposal.pending.id), /expired or was cancelled/);
  assert.deepEqual(calls, []);
});

test('manual control invalidates a pending decision and wins over its late response', async () => {
  const pending = deferred();
  let requestSignal;
  const { engine, calls } = await harness({ decide: (_text, { signal }) => { requestSignal = signal; return pending.promise; } });
  await engine.configure({ mode: 'auto' });
  const work = engine.cue('drop the beat');
  await engine.manual('slides');
  assert.equal(requestSignal.aborted, true);
  pending.resolve(result('music_on'));
  const snapshot = await work;
  assert.deepEqual(calls, [['execute', 'slides']]);
  assert.equal(snapshot.musicPlaying, false);
  assert.equal(snapshot.pending, null);
  assert.equal(executed(snapshot)[0].source, 'manual');
});

test('manual control invalidates an already proposed confirmation', async () => {
  const { engine, calls } = await harness();
  const proposal = await engine.cue('show the demo');
  await engine.manual('music_off');
  await assert.rejects(engine.confirm(proposal.pending.id), /expired or was cancelled/);
  assert.deepEqual(calls, [['execute', 'music_off']]);
});

test('Auto routes a low confidence cue to preview instead of executing', async () => {
  const { engine, calls } = await harness({ decide: async () => result('demo', 0.7) });
  await engine.configure({ mode: 'auto' });
  const snapshot = await engine.cue('show that demo');
  assert.equal(snapshot.pending.action, 'demo');
  assert.deepEqual(calls, []);
  await engine.confirm(snapshot.pending.id);
  assert.deepEqual(calls, [['execute', 'demo']]);
});

test('very low confidence or no-action decisions never become a preview', async () => {
  for (const decision of [result('demo', 0.59), result('none', 0.99)]) {
    const { engine, calls } = await harness({ decide: async () => decision });
    await engine.configure({ mode: 'auto' });
    const snapshot = await engine.cue('unrelated speech');
    assert.equal(snapshot.pending, null);
    assert.equal(snapshot.history[0].type, 'ignored');
    assert.deepEqual(calls, []);
  }
});

test('Auto executes a high confidence cue once', async () => {
  const { engine, calls } = await harness();
  await engine.configure({ mode: 'auto' });
  const snapshot = await engine.cue('show the demo');
  assert.equal(snapshot.pending, null);
  assert.equal(snapshot.currentScene, 'Demo');
  assert.deepEqual(calls, [['execute', 'demo']]);
});

test('an OBS execution failure is never reported as successful', async () => {
  const { engine } = await harness({ execute: async () => { throw new Error('OBS request failed'); } });
  await engine.configure({ mode: 'auto' });
  await assert.rejects(engine.cue('show the demo'), /OBS request failed/);
  const snapshot = engine.snapshot();
  assert.equal(snapshot.currentScene, 'Slides');
  assert.equal(snapshot.busy, false);
  assert.equal(executed(snapshot).length, 0);
  assert.equal(snapshot.history[0].type, 'error');
});

test('a failed confirmation is not executed twice when the user retries', async () => {
  const { engine, calls } = await harness({ execute: async () => { throw new Error('OBS request failed'); } });
  const proposal = await engine.cue('show the demo');
  await assert.rejects(engine.confirm(proposal.pending.id), /OBS request failed/);
  await assert.rejects(engine.confirm(proposal.pending.id), /expired or was cancelled/);
  assert.deepEqual(calls, [['execute', 'demo']]);
  assert.equal(executed(engine.snapshot()).length, 0);
  assert.equal(engine.snapshot().currentScene, 'Slides');
});

test('Stop mutes immediately during an OBS action and ignores its late acknowledgement', async () => {
  const inFlight = deferred();
  const started = deferred();
  const { engine, calls } = await harness({
    decide: async () => result('music_on'),
    execute: async () => { started.resolve(); await inFlight.promise; },
  });
  await engine.configure({ mode: 'auto' });
  const work = engine.cue('drop the beat');
  await started.promise;
  const stopped = engine.stop();
  assert.equal(engine.snapshot().armed, false);
  assert.deepEqual(calls, [['execute', 'music_on'], ['stop']]);
  await stopped;
  assert.equal(engine.snapshot().musicPlaying, false);
  inFlight.resolve();
  await work;
  const snapshot = await stopped;
  assert.deepEqual(calls, [['execute', 'music_on'], ['stop']]);
  assert.equal(snapshot.armed, false);
  assert.equal(snapshot.musicPlaying, false);
  assert.equal(snapshot.history[0].type, 'stopped');
  assert.equal(executed(snapshot).length, 0);
});

test('failed OBS Stop disarms but never claims music was successfully stopped', async () => {
  const { engine } = await harness({ stop: async () => { throw new Error('Mute failed'); } });
  await engine.manual('music_on');
  assert.equal(engine.snapshot().musicPlaying, true);
  await assert.rejects(engine.stop(), /Mute failed/);
  const snapshot = engine.snapshot();
  assert.equal(snapshot.armed, false);
  assert.equal(snapshot.musicPlaying, true);
  assert.notEqual(snapshot.history[0].type, 'stopped');
});

test('recent speech supplies chronological context even when it was not a stage cue', async () => {
  const contexts = [];
  const { engine, advance } = await harness({ decide: async (_text, { context }) => {
    contexts.push(context);
    return result('none');
  } });
  await engine.configure({ target: 'rehearsal' });
  engine.arm(true);
  await engine.cue('I built an application I want to demonstrate.');
  await engine.cue('Let us try it now.');
  assert.deepEqual(contexts[0].recentUtterances, []);
  assert.deepEqual(contexts[1], {
    recentUtterances: ['I built an application I want to demonstrate.'],
    stage: { scene: 'slides', musicPlaying: false },
  });
  advance(45_000);
  await engine.cue('Now?');
  assert.deepEqual(contexts[2].recentUtterances, []);
});

test('only the four most recent utterances enter a decision', async () => {
  const contexts = [];
  const { engine } = await harness({ decide: async (_text, { context }) => { contexts.push(context); return result('none'); } });
  for (let i = 0; i < 7; i++) await engine.cue(`Sentence ${i}`);
  assert.deepEqual(contexts[6].recentUtterances, ['Sentence 2', 'Sentence 3', 'Sentence 4', 'Sentence 5']);
});

test('Stop, re-arm, settings, dismissal and manual control clear remembered speech', async () => {
  for (const operation of [
    async engine => { await engine.stop(); engine.arm(true); },
    async engine => engine.arm(true),
    async engine => engine.configure({ mode: 'auto' }),
    async engine => engine.configure({ speechMode: 'phrase' }),
    async engine => engine.cancel(),
    async engine => engine.manual('slides'),
  ]) {
    const contexts = [];
    const { engine } = await harness({ decide: async (_text, { context }) => { contexts.push(context); return result('none'); } });
    await engine.cue('There is a backing track.');
    await operation(engine);
    await engine.cue('Start it.');
    assert.deepEqual(contexts[1].recentUtterances, []);
  }
});

test('context describes actual mapped OBS state, and does not fabricate disconnected state', async () => {
  const status = { connected: true, configuredScenes: { slides: 'Deck', demo: 'Application' }, currentScene: 'Application', musicAvailable: true, musicMuted: false };
  const contexts = [];
  const engine = createEngine({ apiKey: 'test-api-key', obs: { status: () => status, stop: async () => {} }, decide: async (_text, { context }) => { contexts.push(context); return result('none'); } });
  await engine.configure({ provider: 'openai', target: 'obs' });
  engine.arm(true);
  await engine.cue('That is enough of that.');
  assert.deepEqual(contexts[0].stage, { scene: 'demo', musicPlaying: true });
  status.connected = false;
  await engine.cue('What is happening?');
  assert.deepEqual(contexts[1].stage, { scene: 'unknown', musicPlaying: null });
});
