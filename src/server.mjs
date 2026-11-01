import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { createObsController } from './obs.mjs';
import { createEngine } from './engine.mjs';
import { attachAudio } from './audio.mjs';

const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.wav': 'audio/wav', '.svg': 'image/svg+xml' };

export function createApp({ env = process.env, obs: injectedObs, engine: injectedEngine } = {}) {
  const port = Number(env.PORT || 3210);
  const obs = injectedObs ?? createObsController({
    url: env.OBS_URL || 'ws://127.0.0.1:4455', password: env.OBS_PASSWORD,
    scenes: { slides: env.OBS_SCENE_SLIDES || 'Slides', demo: env.OBS_SCENE_DEMO || 'Demo' },
    musicInput: env.OBS_MUSIC_INPUT || 'Beat',
  });
  const engine = injectedEngine ?? createEngine({ obs, apiKey: env.OPENAI_API_KEY });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 48000 });
  const audioSessions = new Map();
  const allowedHost = host => host === `127.0.0.1:${server.address()?.port || port}` || host === `localhost:${server.address()?.port || port}`;
  function allowedRequest(req) {
    if (!allowedHost(req.headers.host)) return false;
    return !req.headers.origin || req.headers.origin === `http://${req.headers.host}`;
  }
  function respond(res, code, body) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }
  function closeAudio() {
    for (const dispose of audioSessions.values()) dispose();
    audioSessions.clear();
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:* ws://127.0.0.1:*; img-src 'self' data:; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (!allowedRequest(req)) return respond(res, 403, { error: 'Only this local control desk may access StageCue.' });
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { return respond(res, 400, { error: 'Invalid path.' }); }
    if (req.method === 'GET' && pathname === '/api/state') return respond(res, 200, engine.snapshot());
    if (req.method === 'POST' && pathname.startsWith('/api/')) {
      if (!req.headers['content-type']?.startsWith('application/json')) return respond(res, 415, { error: 'Send JSON.' });
      try {
        let raw = '';
        for await (const chunk of req) {
          raw += chunk.toString();
          if (raw.length > 16000) throw new Error('Request too large.');
        }
        let body;
        try { body = JSON.parse(raw || '{}'); } catch { throw new Error('Invalid JSON.'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Send a JSON object.');
        switch (pathname) {
          case '/api/config': closeAudio(); await engine.configure(body); break;
          case '/api/arm': if (!body.armed) closeAudio(); await engine.arm(body.armed); break;
          case '/api/cue': closeAudio(); await engine.cue(body.text); break;
          case '/api/confirm': await engine.confirm(body.id); break;
          case '/api/cancel': closeAudio(); await engine.cancel(); break;
          case '/api/manual': closeAudio(); await engine.manual(body.action); break;
          case '/api/stop': closeAudio(); await engine.stop(); break;
          case '/api/obs/connect': await obs.connect(); break;
          default: return respond(res, 404, { error: 'Unknown API route.' });
        }
        return respond(res, 200, { state: engine.snapshot() });
      } catch (error) { return respond(res, 400, { error: error.message, state: engine.snapshot() }); }
    }
    if (req.method !== 'GET') return respond(res, 405, { error: 'Method not allowed.' });
    const file = path.resolve(publicRoot, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(publicRoot) || !types[path.extname(file)]) return respond(res, 404, { error: 'Not found.' });
    try {
      const contents = await readFile(file);
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] }); res.end(contents);
    } catch { respond(res, 404, { error: 'Not found.' }); }
  });
  server.on('upgrade', (req, socket, head) => {
    if (!allowedRequest(req) || !req.headers.origin || req.url !== '/api/audio' || sockets.clients.size >= 1) { socket.destroy(); return; }
    sockets.handleUpgrade(req, socket, head, browser => {
      sockets.emit('connection', browser, req);
      const fullPhrase = engine.snapshot().speechMode === 'phrase';
      const configuredSilence = Number(env.VAD_SILENCE_MS || 400);
      const silenceMs = Number.isFinite(configuredSilence) && configuredSilence >= 100 && configuredSilence <= 2000 ? configuredSilence : 400;
      const dispose = attachAudio(browser, {
        apiKey: env.OPENAI_API_KEY, engine,
        model: fullPhrase ? 'gpt-transcribe' : env.TRANSCRIPTION_MODEL || 'gpt-live-transcribe',
        threshold: Number(env.VAD_THRESHOLD || 0.018),
        silenceMs: fullPhrase ? Math.max(700, silenceMs) : silenceMs,
      });
      audioSessions.set(browser, dispose);
      browser.once('close', () => audioSessions.delete(browser));
    });
  });
  async function close() {
    closeAudio();
    await engine.stop().catch(() => {});
    await obs.disconnect().catch(() => {});
    sockets.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  return { server, engine, obs, close, port };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const app = createApp();
  app.server.listen(app.port, '127.0.0.1', () => console.log(`StageCue is ready at http://localhost:${app.port} (rehearsal, disarmed)`));
  app.server.on('error', error => console.error(error.code === 'EADDRINUSE' ? 'Port is already in use. Set PORT in .env.' : 'Could not start local server.'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
}
