import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { attachAudio } from '../src/audio.mjs';
import { createDebugStore } from '../src/debug.mjs';

class FakeSocket extends EventEmitter {
  constructor(state = WebSocket.OPEN) {
    super();
    this.readyState = state;
    this.bufferedAmount = 0;
    this.sent = [];
    this.closeCalls = 0;
    this.terminateCalls = 0;
  }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() { this.closeCalls++; this.readyState = WebSocket.CLOSING; }
  terminate() { this.terminateCalls++; this.readyState = WebSocket.CLOSED; }
  open() { this.readyState = WebSocket.OPEN; this.emit('open'); }
  event(value) { this.emit('message', Buffer.from(JSON.stringify(value))); }
}

function fakeClock() {
  let now = 0;
  let next = 0;
  const tasks = new Map();
  const add = (callback, delay, repeat = false) => {
    const id = ++next;
    tasks.set(id, { callback, due: now + delay, delay, repeat });
    return id;
  };
  return {
    setTimer: (callback, delay) => add(callback, delay),
    clearTimer: id => tasks.delete(id),
    setGuard: (callback, delay) => add(callback, delay, true),
    clearGuard: id => tasks.delete(id),
    size: () => tasks.size,
    advance(milliseconds) {
      const end = now + milliseconds;
      while (true) {
        const pending = [...tasks.entries()].filter(([, task]) => task.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
        if (!pending) break;
        const [id, task] = pending;
        now = task.due;
        if (task.repeat) task.due += task.delay;
        else tasks.delete(id);
        task.callback();
      }
      now = end;
    },
  };
}

function pcm(milliseconds, amplitude = 0) {
  const buffer = Buffer.alloc(milliseconds * 48);
  for (let index = 0; index < buffer.length; index += 2) buffer.writeInt16LE(amplitude, index);
  return buffer;
}

function session(t, options = {}) {
  const browser = new FakeSocket();
  const upstream = new FakeSocket(WebSocket.CONNECTING);
  const clock = fakeClock();
  const state = { armed: true, provider: 'openai', target: 'rehearsal', obs: { connected: true }, ...options.state };
  const cues = [];
  const cueMetadata = [];
  const diagnostics = createDebugStore();
  let connections = 0;
  const engine = { diagnostics, snapshot: () => structuredClone(state), cue: async (text, metadata) => { cues.push(text); cueMetadata.push(metadata); } };
  const dispose = attachAudio(browser, {
    apiKey: 'test-api-key', engine,
    ...clock,
    createWebSocket: (url, config) => {
      connections++;
      assert.equal(url, 'wss://api.openai.com/v1/realtime?intent=transcription');
      assert.equal(config.headers.Authorization, 'Bearer test-api-key');
      return upstream;
    },
    ...options.attach,
  });
  t.after(dispose);
  return {
    browser, upstream, clock, state, cues, cueMetadata, diagnostics, dispose,
    connections: () => connections,
    start() { upstream.open(); upstream.event({ type: 'session.updated' }); },
    turn() {
      browser.emit('message', pcm(20, 5_000), true);
      for (let i = 0; i < 20; i++) browser.emit('message', pcm(20), true);
    },
    ack(item_id) { upstream.event({ type: 'input_audio_buffer.committed', item_id }); },
    complete(item_id, transcript) { upstream.event({ type: 'conversation.item.input_audio_transcription.completed', item_id, transcript }); },
  };
}

const errors = browser => browser.sent.filter(event => event.type === 'error');

test('requires armed OpenAI mode and a key before opening an upstream connection', t => {
  for (const options of [{ state: { armed: false } }, { state: { provider: 'rehearsal' } }, { attach: { apiKey: '' } }]) {
    const app = session(t, options);
    assert.equal(app.connections(), 0);
    assert.equal(app.browser.closeCalls, 1);
    assert.equal(errors(app.browser).length, 1);
    assert.equal(app.clock.size(), 0);
    assert.doesNotThrow(app.dispose);
  }
});

test('sends the transcription configuration once opened and waits for session readiness', t => {
  const app = session(t);
  app.turn();
  assert.equal(app.upstream.sent.length, 0);
  app.start();
  assert.equal(app.connections(), 1);
  const update = app.upstream.sent[0];
  assert.equal(update.type, 'session.update');
  assert.equal(update.session.type, 'transcription');
  assert.deepEqual(update.session.audio.input.format, { type: 'audio/pcm', rate: 24000 });
  assert.equal(update.session.audio.input.transcription.model, 'gpt-live-transcribe');
  assert.equal(update.session.audio.input.transcription.delay, 'medium');
  assert.deepEqual(update.session.audio.input.transcription.keywords, ['StageCue', 'Codex', 'OBS', 'DevDay']);
  assert.equal(update.session.audio.input.turn_detection, null);
  app.upstream.event({ type: 'session.updated' });
  assert.equal(app.browser.sent.filter(event => event.type === 'ready').length, 1);
  app.turn();
  assert.equal(app.upstream.sent.filter(event => event.type === 'input_audio_buffer.commit').length, 1);
});

test('full phrase model uses committed turns and accepts the finish control while noisy', t => {
  const app = session(t, { attach: { model: 'gpt-transcribe', silenceMs: 700 } });
  app.start();
  const transcription = app.upstream.sent[0].session.audio.input.transcription;
  assert.equal(transcription.model, 'gpt-transcribe');
  assert.equal(transcription.delay, undefined);
  app.browser.emit('message', Buffer.from('{"type":"finish_phrase"}'), false);
  assert.equal(app.upstream.sent.filter(event => event.type === 'input_audio_buffer.commit').length, 0);
  app.browser.emit('message', pcm(500, 5_000), true);
  app.browser.emit('message', Buffer.from('{"type":"finish_phrase"}'), false);
  app.ack('noisy'); app.complete('noisy', 'let us try it now');
  assert.deepEqual(app.cues, ['let us try it now']);
  app.dispose();
  app.browser.emit('message', Buffer.from('{"type":"finish_phrase"}'), false);
  assert.equal(app.upstream.sent.filter(event => event.type === 'input_audio_buffer.commit').length, 1);
});

test('an ACKed final transcript dispatches once and duplicate completions are ignored', t => {
  const app = session(t);
  app.start(); app.turn(); app.ack('first');
  app.complete('first', '  show the demo  ');
  app.complete('first', 'drop the beat');
  assert.deepEqual(app.cues, ['show the demo']);
  assert.deepEqual(app.browser.sent.filter(event => event.type === 'transcript'), [{ type: 'transcript', text: 'show the demo' }]);
  app.clock.advance(6_000);
  assert.equal(errors(app.browser).length, 0);
  assert.equal(app.browser.closeCalls, 0);
});

test('out-of-order completion dispatches the latest turn and does not trigger a false timeout', t => {
  const app = session(t);
  app.start(); app.turn(); app.ack('first');
  app.clock.advance(1_000);
  app.turn(); app.ack('second');
  app.complete('second', 'stop the music');
  app.clock.advance(6_000);
  app.complete('first', 'drop the beat');
  assert.deepEqual(app.cues, ['stop the music']);
  assert.equal(errors(app.browser).length, 0);
  assert.equal(app.browser.closeCalls, 0);
});

test('a new local commit suppresses the old transcript before the new ACK arrives', t => {
  const app = session(t);
  app.start(); app.turn(); app.ack('first');
  app.turn();
  app.complete('first', 'drop the beat');
  assert.deepEqual(app.cues, []);
  app.ack('second'); app.complete('second', 'stop the music');
  assert.deepEqual(app.cues, ['stop the music']);
});

test('unknown and unacknowledged transcripts cannot create stage cues', t => {
  const app = session(t);
  app.start(); app.turn();
  app.complete('unknown', 'drop the beat');
  app.complete(undefined, 'drop the beat');
  app.ack('actual');
  app.complete('actual', { command: 'drop the beat' });
  assert.deepEqual(app.cues, []);
});

test('duplicate ACKs do not consume the next turn mapping', t => {
  const app = session(t);
  app.start(); app.turn(); app.ack('first');
  app.turn(); app.ack('first'); app.ack('second');
  app.complete('second', 'show the demo');
  assert.deepEqual(app.cues, ['show the demo']);
});

test('only the latest turn supplies partial transcript text', t => {
  const app = session(t);
  app.start(); app.turn(); app.ack('first');
  app.turn(); app.ack('second');
  app.upstream.event({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'first', delta: 'old phrase' });
  app.upstream.event({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'second', delta: 'show ' });
  app.upstream.event({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'second', delta: 'the demo' });
  assert.deepEqual(app.browser.sent.filter(event => event.type === 'partial').map(event => event.text), ['show ', 'show the demo']);
  assert.deepEqual(app.cues, []);
});

test('synchronous disposal blocks transcripts before the socket close handshake completes', t => {
  const app = session(t);
  app.start(); app.turn(); app.ack('first');
  app.state.armed = false;
  app.dispose();
  assert.equal(app.browser.readyState, WebSocket.CLOSING);
  assert.equal(app.clock.size(), 0);
  app.state.armed = true;
  app.complete('first', 'drop the beat');
  app.upstream.event({ type: 'session.updated' });
  app.turn();
  app.dispose();
  assert.deepEqual(app.cues, []);
  assert.equal(app.browser.closeCalls, 1);
  assert.equal(app.upstream.closeCalls, 1);
});

test('connecting socket cleanup errors cannot block a synchronous dispose', t => {
  const app = session(t);
  app.upstream.terminate = () => { throw new Error('transport already gone'); };
  assert.doesNotThrow(app.dispose);
  assert.equal(app.browser.closeCalls, 1);
  assert.equal(app.clock.size(), 0);
  app.state.armed = true;
  app.upstream.open();
  app.upstream.event({ type: 'session.updated' });
  app.complete('late-item', 'drop the beat');
  assert.deepEqual(app.cues, []);
});

test('dispatch checks current armed/provider/connection state without waiting for the guard', t => {
  for (const mutation of [
    state => { state.armed = false; },
    state => { state.provider = 'rehearsal'; },
    state => { state.target = 'obs'; state.obs.connected = false; },
  ]) {
    const app = session(t);
    app.start(); app.turn(); app.ack('first');
    mutation(app.state);
    app.complete('first', 'drop the beat');
    assert.deepEqual(app.cues, []);
    assert.equal(app.browser.closeCalls, 1);
  }
});

test('a closing browser cannot receive a late stage action', t => {
  const app = session(t);
  app.start(); app.turn(); app.ack('first');
  app.browser.close();
  app.complete('first', 'drop the beat');
  assert.deepEqual(app.cues, []);
  assert.equal(app.upstream.closeCalls, 1);
});

test('the newest turn times out after six seconds and later text is ignored', t => {
  const app = session(t);
  app.start(); app.turn(); app.ack('first');
  app.clock.advance(5_999);
  assert.equal(errors(app.browser).length, 0);
  app.clock.advance(1);
  assert.match(errors(app.browser)[0].message, /taking too long/);
  assert.equal(app.clock.size(), 0);
  app.complete('first', 'drop the beat');
  assert.deepEqual(app.cues, []);
});

test('connection startup has a deadline and cleans up the connecting socket', t => {
  const app = session(t);
  app.clock.advance(12_000);
  assert.match(errors(app.browser)[0].message, /Could not start transcription/);
  assert.equal(app.upstream.terminateCalls, 1);
  assert.equal(app.clock.size(), 0);
});

test('an older failed transcription does not close a newer healthy turn', t => {
  const app = session(t);
  app.start(); app.turn(); app.ack('first');
  app.turn(); app.ack('second');
  app.upstream.event({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'first', error: { message: 'sensitive upstream content' } });
  app.complete('second', 'show the demo');
  assert.deepEqual(app.cues, ['show the demo']);
  assert.equal(errors(app.browser).length, 0);
});

test('the newest failed transcription closes safely without exposing upstream errors', t => {
  const app = session(t);
  app.start(); app.turn(); app.ack('first');
  app.upstream.event({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'first', error: { message: 'private upstream payload' } });
  assert.equal(errors(app.browser).length, 1);
  assert.doesNotMatch(errors(app.browser)[0].message, /private|payload/);
  assert.equal(app.browser.closeCalls, 1);
});

test('invalid binary audio and backpressure stop the microphone without sending a cue', t => {
  for (const scenario of ['odd', 'oversized', 'backpressure']) {
    const app = session(t);
    app.start();
    if (scenario === 'backpressure') app.upstream.bufferedAmount = 480_001;
    const frame = scenario === 'odd' ? Buffer.alloc(3) : scenario === 'oversized' ? Buffer.alloc(48_002) : pcm(20, 5_000);
    app.browser.emit('message', frame, true);
    assert.equal(errors(app.browser).length, 1);
    assert.equal(app.browser.closeCalls, 1);
    assert.deepEqual(app.cues, []);
  }
});

test('malformed upstream messages are ignored without crashing', t => {
  const app = session(t);
  app.start();
  for (const raw of ['{bad', 'null', '5', '"text"']) {
    assert.doesNotThrow(() => app.upstream.emit('message', Buffer.from(raw)));
  }
  assert.deepEqual(app.cues, []);
  assert.equal(errors(app.browser).length, 0);
});

test('speech debug correlates partial, final and decision input and tracks gate settings', t => {
  const app = session(t);
  app.start(); app.turn(); app.ack('first');
  app.upstream.event({type:'conversation.item.input_audio_transcription.delta',item_id:'first',delta:'show the'});
  let trace = app.diagnostics.snapshot().turns[0];
  assert.equal(trace.transcript.partial, 'show the');
  assert.equal(trace.transcript.status, 'partial');
  assert.equal(trace.timings.audioMs, 420);
  assert.equal(trace.transcript.commitReason, 'pause');
  app.complete('first', 'show the demo');
  trace = app.diagnostics.snapshot().turns[0];
  assert.equal(trace.transcript.final, 'show the demo');
  assert.equal(trace.transcript.itemId, 'first');
  assert.equal(app.cueMetadata[0].traceId, trace.id);
  assert.ok(Number.isFinite(trace.timings.transcriptionMs));
  assert.equal(app.diagnostics.snapshot().audio.threshold, 0.018);
  assert.equal(JSON.stringify(app.diagnostics.snapshot()).includes('test-api-key'), false);
});

test('old speech results remain inspectable without becoming a new decision', t => {
  const app = session(t);
  app.start(); app.turn(); app.ack('first');
  const firstId = app.diagnostics.snapshot().turns[0].id;
  app.turn(); app.ack('second');
  app.complete('first', 'drop the beat');
  assert.equal(app.diagnostics.get(firstId).transcript.final, 'drop the beat');
  assert.equal(app.diagnostics.get(firstId).route.status, 'ignored');
  assert.deepEqual(app.cues, []);
  app.complete('second', 'stop the music');
  assert.deepEqual(app.cues, ['stop the music']);
});

test('transcription timeout and closed capture are visible without raw service errors', t => {
  const app = session(t);
  app.start(); app.turn(); app.ack('first');
  app.clock.advance(6000);
  const debug = app.diagnostics.snapshot();
  assert.equal(debug.audio.status, 'error');
  assert.equal(debug.turns[0].transcript.status, 'timeout');
  assert.equal(debug.turns[0].route.status, 'error');
});
