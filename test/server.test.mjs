import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/server.mjs';

async function fixture(t) {
  const app = createApp({ env: { PORT: '0' }, obs: {
    status: () => ({ connected: false, scenes: [] }), disconnect: async () => {},
    connect: async () => { throw new Error('OBS is unavailable.'); },
  } });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  t.after(() => app.close());
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (route, data = {}, headers = {}) => {
    const response = await fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
    return { status: response.status, ...await response.json() };
  };
  return { app, url, post };
}

test('HTTP journey: disarmed -> Ask -> confirm -> Auto -> stop', async t => {
  const { url, post } = await fixture(t);
  const initial = await (await fetch(url + '/api/state')).json();
  assert.equal(initial.armed, false);
  assert.equal(initial.ready.apiKey, false);
  let result = await post('/api/cue', { text: 'show the demo' });
  assert.equal(result.state.currentScene, 'Slides');
  await post('/api/arm', { armed: true });
  result = await post('/api/cue', { text: 'show the demo' });
  assert.equal(result.state.pending.action, 'demo');
  assert.equal(result.state.currentScene, 'Slides');
  result = await post('/api/confirm', { id: result.state.pending.id });
  assert.equal(result.state.currentScene, 'Demo');
  await post('/api/config', { mode: 'auto' });
  result = await post('/api/cue', { text: 'drop the beat' });
  assert.equal(result.state.musicPlaying, true);
  result = await post('/api/stop');
  assert.equal(result.state.armed, false);
  assert.equal(result.state.musicPlaying, false);
  assert.equal(result.state.pending, null);
});

test('HTTP rejects foreign origins, host rebinding, non-JSON requests and unsupported actions', async t => {
  const { url, post } = await fixture(t);
  assert.equal((await post('/api/arm', { armed: true }, { Origin: 'https://example.com' })).status, 403);
  const rebound = await new Promise((resolve, reject) => {
    const req = http.get(url + '/api/state', { headers: { Host: 'example.com' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  assert.equal(rebound, 403);
  assert.equal((await fetch(url + '/api/arm', { method: 'POST', body: 'armed=true' })).status, 415);
  assert.equal((await post('/api/manual', { action: 'delete_scene' })).status, 400);
  assert.equal((await post('/api/arm', { armed: 'true' })).status, 400);
  assert.equal((await post('/api/config', { target: 'external' })).status, 400);
});

test('server serves only public assets and never .env or source files', async t => {
  const { url } = await fixture(t);
  for (const route of ['/', '/app.js', '/pcm-worklet.js', '/stage.html?scene=demo', '/assets/stagecue-beat.wav']) {
    const response = await fetch(url + route);
    assert.equal(response.status, 200, route);
  }
  for (const route of ['/.env', '/src/server.mjs', '/..%2f.env', '/%2e%2e%2fsrc%2fserver.mjs']) {
    assert.equal((await fetch(url + route)).status, 404, route);
  }
});

test('unconfigured live paths fail without pretending to execute', async t => {
  const { post } = await fixture(t);
  await post('/api/config', { provider: 'openai' });
  const result = await post('/api/arm', { armed: true });
  assert.equal(result.status, 400);
  assert.equal(result.state.armed, false);
  assert.equal((await post('/api/obs/connect')).status, 400);
});

test('clear-debug API clears traces while preserving the proposal and existing cue history', async t => {
  const {post} = await fixture(t);
  await post('/api/arm', {armed:true});
  const proposed = await post('/api/cue', {text:'show the demo'});
  assert.equal(proposed.state.debug.turns.length, 1);
  const cleared = await post('/api/debug/clear');
  assert.equal(cleared.state.debug.turns.length, 0);
  assert.equal(cleared.state.pending.id, proposed.state.pending.id);
  assert.deepEqual(cleared.state.history, proposed.state.history);
  assert.equal((await post('/api/confirm', {id:proposed.state.pending.id})).state.currentScene, 'Demo');
});

test('threshold configuration is validated and returned to refreshed clients', async t => {
  const {url, post} = await fixture(t);
  assert.equal((await (await fetch(url + '/api/state')).json()).autoThreshold, 65);
  const saved = await post('/api/config', {mode:'auto', autoThreshold:72});
  assert.equal(saved.status, 200);
  assert.equal(saved.state.autoThreshold, 72);
  assert.equal((await (await fetch(url + '/api/state')).json()).autoThreshold, 72);
  for (const autoThreshold of [-1, 101, '65', null, 65.5]) {
    const rejected = await post('/api/config', {autoThreshold});
    assert.equal(rejected.status, 400);
    assert.equal(rejected.state.autoThreshold, 72);
  }
});
