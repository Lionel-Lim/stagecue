import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createObsController } from '../src/obs.mjs';
import { createEngine } from '../src/engine.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

class FakeObs extends EventEmitter {
  calls = [];
  sceneNames = ['Talk slides', 'Live demo'];
  failure = null;
  async connect(...args) { this.connection = args; }
  async disconnect() { this.emit('ConnectionClosed'); }
  async call(method, data) {
    this.calls.push({ method, data });
    if (this.failure?.method === method) throw this.failure.error;
    if (method === 'GetSceneList') return { scenes: this.sceneNames.map((sceneName) => ({ sceneName })), currentProgramSceneName: 'Talk slides' };
    if (method === 'GetInputMute') return { inputMuted: true };
    return {};
  }
}

function setup(client = new FakeObs(), options = {}) {
  return { client, obs: createObsController({
    url: 'ws://127.0.0.1:4455', password: 'private-test-password',
    scenes: { slides: 'Talk slides', demo: 'Live demo' }, musicInput: 'Beat', client, ...options,
  }) };
}

test('connect reads OBS configuration without changing live output or exposing credentials', async () => {
  const { client, obs } = setup();
  const status = await obs.connect();
  assert.deepEqual(client.connection, ['ws://127.0.0.1:4455', 'private-test-password', { rpcVersion: 1 }]);
  assert.deepEqual(client.calls.map((call) => call.method), ['GetSceneList', 'GetInputMute']);
  assert.equal(status.currentScene, 'Talk slides');
  assert.equal(status.connected, true);
  assert.equal(JSON.stringify(status).includes('private-test-password'), false);
  assert.deepEqual(status.availableActions, ['slides', 'demo', 'music_on', 'music_off']);
});

test('only configured scene names reach the program output', async () => {
  const { client, obs } = setup();
  await obs.connect();
  await obs.execute('demo');
  assert.deepEqual(client.calls.at(-1), { method: 'SetCurrentProgramScene', data: { sceneName: 'Live demo' } });
  assert.equal(obs.status().currentScene, 'Live demo');
  await assert.rejects(obs.execute('StartStream'), /Unsupported/);
  await assert.rejects(obs.execute({ action: 'demo', sceneName: 'Malicious scene' }), /Unsupported/);
  assert.equal(client.calls.length, 3);
});

test('missing scene disables its cue without mutating OBS', async () => {
  const { client, obs } = setup();
  client.sceneNames = ['Talk slides'];
  await obs.connect();
  assert.equal(obs.status().availableActions.includes('demo'), false);
  await assert.rejects(obs.execute('demo'), /existing OBS scene/);
  assert.equal(client.calls.length, 2);
});

test('music is restarted while muted, then unmuted; music_off only mutes that source', async () => {
  const { client, obs } = setup();
  await obs.connect();
  await obs.execute('music_on');
  await obs.execute('music_off');
  assert.deepEqual(client.calls.slice(2), [
    { method: 'SetInputMute', data: { inputName: 'Beat', inputMuted: true } },
    { method: 'TriggerMediaInputAction', data: { inputName: 'Beat', mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART' } },
    { method: 'SetInputMute', data: { inputName: 'Beat', inputMuted: false } },
    { method: 'SetInputMute', data: { inputName: 'Beat', inputMuted: true } },
  ]);
  assert.equal(obs.status().musicMuted, true);
});

test('failed media restart leaves music muted and reports failure', async () => {
  const { client, obs } = setup();
  await obs.connect();
  client.failure = { method: 'TriggerMediaInputAction', error: Object.assign(new Error('Not a media source'), { code: 604 }) };
  await assert.rejects(obs.execute('music_on'), /code 604/);
  assert.equal(obs.status().musicMuted, true);
  assert.equal(client.calls.some((call) => call.data?.inputMuted === false), false);
});

test('missing music input allows scene cues but disables music cues', async () => {
  const { client, obs } = setup();
  client.failure = { method: 'GetInputMute', error: new Error('Missing source') };
  await obs.connect();
  await obs.execute('demo');
  await assert.rejects(obs.execute('music_on'), /music input/);
  assert.deepEqual(obs.status().availableActions, ['slides', 'demo']);
});

test('closed connection prevents any new output request', async () => {
  const { client, obs } = setup();
  await obs.connect();
  client.emit('ConnectionClosed');
  await assert.rejects(obs.execute('demo'), /disconnected/);
  assert.equal(client.calls.length, 2);
});

test('scene and mute events keep status aligned with manual OBS changes', async () => {
  const { client, obs } = setup();
  await obs.connect();
  client.emit('CurrentProgramSceneChanged', { sceneName: 'Live demo' });
  client.emit('InputMuteStateChanged', { inputName: 'Beat', inputMuted: false });
  assert.equal(obs.status().currentScene, 'Live demo');
  assert.equal(obs.status().musicMuted, false);
});

test('stop cancels an in-flight restart before unmute and drops queued cues', async () => {
  const { client, obs } = setup();
  await obs.connect();
  const originalCall = client.call.bind(client);
  let releaseRestart;
  let startedRestart;
  const started = new Promise((resolve) => { startedRestart = resolve; });
  client.call = async (method, data) => {
    const result = await originalCall(method, data);
    if (method === 'TriggerMediaInputAction') {
      startedRestart();
      await new Promise((resolve) => { releaseRestart = resolve; });
    }
    return result;
  };
  const music = obs.execute('music_on');
  const musicRejected = assert.rejects(music, /cancelled/);
  const scene = obs.execute('demo');
  const sceneRejected = assert.rejects(scene, /cancelled/);
  await started;
  await obs.stop();
  releaseRestart();
  await Promise.all([musicRejected, sceneRejected]);
  assert.equal(client.calls.some((call) => call.data?.inputMuted === false), false);
  assert.equal(client.calls.some((call) => call.method === 'SetCurrentProgramScene'), false);
  assert.equal(obs.status().musicMuted, true);
});

test('connect failure never returns raw connection errors or secrets', async () => {
  const { client, obs } = setup();
  client.connect = async () => { throw new Error('private-test-password in private URL'); };
  await assert.rejects(obs.connect(), /Check Tools/);
  assert.equal(obs.status().connected, false);
  assert.equal(JSON.stringify(obs.status()).includes('private-test-password'), false);
});

test('connection closure rejects an unanswered action and the engine can dispatch after reconnect', async () => {
  const first = new FakeObs();
  const second = new FakeObs();
  let attempts = 0;
  const { obs } = setup(first, { clientFactory: () => attempts++ ? second : first });
  await obs.connect();
  const originalCall = first.call.bind(first);
  const started = deferred();
  first.call = async (method, data) => {
    const result = await originalCall(method, data);
    if (method === 'SetCurrentProgramScene') { started.resolve(); return new Promise(() => {}); }
    return result;
  };
  const engine = createEngine({ obs });
  await engine.configure({ target: 'obs', mode: 'auto' });
  engine.arm(true);
  const firstCue = assert.rejects(engine.cue('show the demo'), /disconnected/);
  await started.promise;
  first.emit('ConnectionClosed');
  await firstCue;
  await obs.connect();
  await engine.cue('back to slides');
  assert.equal(engine.snapshot().currentScene, 'Slides');
  assert.equal(second.calls.at(-1).method, 'SetCurrentProgramScene');
});

test('connection closure during configuration rejects all reads and never reports connected', async () => {
  const client = new FakeObs();
  const { obs } = setup(client);
  const started = deferred();
  client.call = async () => { started.resolve(); return new Promise(() => {}); };
  const rejected = assert.rejects(obs.connect(), /disconnected/);
  await started.promise;
  client.emit('ConnectionClosed');
  await rejected;
  assert.equal(obs.status().connected, false);
});

test('connect timeout is bounded even if disconnect hangs; late completion cannot restore the old connection', async () => {
  const first = new FakeObs();
  const second = new FakeObs();
  const delayedConnect = deferred();
  first.connect = () => delayedConnect.promise;
  first.disconnect = () => new Promise(() => {});
  let attempts = 0;
  const { obs } = setup(first, { connectTimeoutMs: 20, clientFactory: () => attempts++ ? second : first });
  await assert.rejects(obs.connect(), /connection timed out/);
  assert.equal(obs.status().connected, false);
  await obs.connect();
  delayedConnect.resolve();
  first.emit('ConnectionClosed');
  first.emit('CurrentProgramSceneChanged', { sceneName: 'Old session scene' });
  await flush();
  assert.equal(obs.status().connected, true);
  assert.equal(obs.status().currentScene, 'Talk slides');
  assert.equal(first.calls.length, 0);
});

test('a timeout in either configuration read prevents a false connected status', async () => {
  const client = new FakeObs();
  const { obs } = setup(client, { requestTimeoutMs: 20 });
  const originalCall = client.call.bind(client);
  client.call = (method, data) => method === 'GetInputMute' ? new Promise(() => {}) : originalCall(method, data);
  await assert.rejects(obs.connect(), /disconnected|timed out/);
  assert.equal(obs.status().connected, false);
});

test('media restart timeout drops queued cues and cannot unmute after reconnect or late success', async () => {
  const first = new FakeObs();
  const second = new FakeObs();
  const restart = deferred();
  let attempts = 0;
  const { obs } = setup(first, { requestTimeoutMs: 20, clientFactory: () => attempts++ ? second : first });
  await obs.connect();
  const originalCall = first.call.bind(first);
  first.call = async (method, data) => {
    const result = await originalCall(method, data);
    return method === 'TriggerMediaInputAction' ? restart.promise : result;
  };
  const musicRejected = assert.rejects(obs.execute('music_on'), /request timed out/);
  const queuedRejected = assert.rejects(obs.execute('demo'), /disconnected|cancelled/);
  await Promise.all([musicRejected, queuedRejected]);
  assert.equal(obs.status().connected, false);
  await obs.connect();
  await obs.execute('slides');
  restart.resolve({});
  await flush();
  assert.equal(obs.status().connected, true);
  assert.equal(first.calls.some((call) => call.data?.inputMuted === false), false);
  assert.equal(first.calls.some((call) => call.method === 'SetCurrentProgramScene'), false);
  assert.equal(second.calls.at(-1).method, 'SetCurrentProgramScene');
});

test('Stop rejects an outstanding unmute and its late acknowledgement cannot overwrite mute status', async () => {
  const { client, obs } = setup();
  await obs.connect();
  const originalCall = client.call.bind(client);
  const started = deferred();
  const unmute = deferred();
  client.call = async (method, data) => {
    const result = await originalCall(method, data);
    if (method === 'SetInputMute' && data.inputMuted === false) { started.resolve(); return unmute.promise; }
    return result;
  };
  const rejected = assert.rejects(obs.execute('music_on'), /cancelled/);
  await started.promise;
  await obs.stop();
  await rejected;
  unmute.resolve({});
  await flush();
  assert.equal(obs.status().musicMuted, true);
  assert.equal(obs.status().lastError, null);
});

test('Stop timeout returns mixer guidance and disconnects without waiting indefinitely', async () => {
  const { client, obs } = setup(new FakeObs(), { requestTimeoutMs: 20 });
  await obs.connect();
  client.call = () => new Promise(() => {});
  await assert.rejects(obs.stop(), /Use the OBS audio mixer/);
  assert.equal(obs.status().connected, false);
});

test('disconnect cancels a pending handshake without waiting for the underlying client close', async () => {
  const client = new FakeObs();
  const { obs } = setup(client);
  const started = deferred();
  const handshake = deferred();
  client.connect = () => { started.resolve(); return handshake.promise; };
  client.disconnect = () => new Promise(() => {});
  const rejected = assert.rejects(obs.connect(), /disconnected/);
  await started.promise;
  await obs.disconnect();
  await rejected;
  handshake.resolve({});
  await flush();
  assert.equal(obs.status().connected, false);
  assert.equal(client.calls.length, 0);
});

test('code-less upstream errors cannot expose connection details through action status', async () => {
  const { client, obs } = setup();
  await obs.connect();
  client.failure = { method: 'SetCurrentProgramScene', error: new Error('private-test-password in private URL') };
  await assert.rejects(obs.execute('demo'), /could not execute demo/);
  assert.equal(JSON.stringify(obs.status()).includes('private-test-password'), false);
});
