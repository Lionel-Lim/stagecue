import { WebSocket } from 'ws';

// OpenAI's gpt-live-transcribe requires application-side turn detection.
// All data is ephemeral; this bridge never writes recordings or transcripts.
export function createTurnDetector({ threshold = 0.018, silenceMs = 400, append, commit, onStart, onLevel } = {}) {
  const rmsThreshold = Number.isFinite(threshold) && threshold > 0 && threshold <= 1 ? threshold : 0.018;
  const tailMs = Number.isFinite(silenceMs) && silenceMs >= 100 && silenceMs <= 2000 ? silenceMs : 400;
  let preRoll = [], active = false, quietMs = 0, durationMs = 0;
  const finish = (reason = 'manual') => {
    if (!active || durationMs < 100) return;
    commit({ audioMs: Math.round(durationMs), reason });
    active = false; quietMs = 0; durationMs = 0; preRoll = [];
  };
  return {
    finish,
    settings: { threshold: rmsThreshold, silenceMs: tailMs },
    push(buffer) {
      if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length % 2 || buffer.length > 48000) return;
      const ms = buffer.length / 48;
      let sum = 0;
      for (let i = 0; i < buffer.length; i += 2) sum += (buffer.readInt16LE(i) / 32768) ** 2;
      const rms = Math.sqrt(sum / (buffer.length / 2));
      const speaking = rms >= rmsThreshold;
      onLevel?.({ rms: Math.round(rms * 10000) / 10000, speechDetected: speaking });
      if (!active) {
        preRoll.push(buffer);
        while (preRoll.reduce((n, b) => n + b.length, 0) > 14400 && preRoll.length > 1) preRoll.shift();
        if (!speaking) return;
        active = true;
        onStart?.();
        for (const part of preRoll) append(part);
        durationMs = preRoll.reduce((n, b) => n + b.length / 48, 0);
        preRoll = [];
      } else { append(buffer); durationMs += ms; }
      quietMs = speaking ? 0 : quietMs + ms;
      if (quietMs >= tailMs || durationMs >= 12000) {
        finish(quietMs >= tailMs ? 'pause' : '12-second limit');
      }
    },
  };
}

/** Returns a synchronous disposer: callers must use it before independent operator actions. */
export function attachAudio(browser, {
  apiKey, engine, model = 'gpt-live-transcribe', threshold, silenceMs,
  createWebSocket = (url, options) => new WebSocket(url, options),
  setTimer = setTimeout, clearTimer = clearTimeout,
  setGuard = setInterval, clearGuard = clearInterval,
}) {
  const diagnostics = engine.diagnostics;
  diagnostics?.audio({ status: 'connecting', model, message: 'Connecting to OpenAI transcription.', rms: 0, speechDetected: false });
  let closed = false;
  const send = event => { if (!closed && browser.readyState === WebSocket.OPEN) browser.send(JSON.stringify(event)); };
  const canListen = () => {
    const state = engine.snapshot();
    return state.armed && state.provider === 'openai' && browser.readyState === WebSocket.OPEN &&
      !(state.target === 'obs' && state.obs?.connected === false);
  };
  if (!apiKey || !canListen()) {
    diagnostics?.audio({ status: 'error', message: 'Live speech requires an armed desk and an API key.' });
    send({ type: 'error', message: 'Select OpenAI Decisions, configure a key, and arm the desk first.' });
    browser.close(); return () => {};
  }
  let upstream;
  try {
    upstream = createWebSocket('wss://api.openai.com/v1/realtime?intent=transcription', {
      headers: { Authorization: `Bearer ${apiKey}` }, handshakeTimeout: 10000,
    });
  } catch {
    diagnostics?.audio({ status: 'error', message: 'Transcription connection could not start.' });
    send({ type: 'error', message: 'Transcription connection could not start.' });
    browser.close(); return () => {};
  }
  let ready = false;
  let audioFailed = false;
  let captureTraceId = null;
  let latestSequence = 0;
  // ACKs arrive in commit order over this one WebSocket. Completion events may not.
  const awaitingAck = [];
  const byItem = new Map();
  const seenItems = new Set();
  const timers = new Set();
  let guard;
  const post = event => {
    if (closed || upstream.readyState !== WebSocket.OPEN) return false;
    upstream.send(JSON.stringify(event));
    return true;
  };
  const cancelTimer = timer => { clearTimer(timer); timers.delete(timer); };
  const close = () => {
    if (closed) return;
    closed = true;
    ready = false;
    if (!audioFailed) diagnostics?.audio({ status: 'off', message: 'Microphone session ended.', speechDetected: false, rms: 0 });
    for (const id of new Set([captureTraceId, ...awaitingAck.map(turn => turn.traceId), ...[...byItem.values()].map(turn => turn.traceId)])) {
      if (id && diagnostics?.get(id)?.route.status === 'waiting') diagnostics.update(id, {
        transcript: { status: 'cancelled' }, route: { status: 'cancelled', reason: 'Microphone session closed before a final transcript was accepted.' },
      });
    }
    for (const timer of timers) clearTimer(timer);
    timers.clear();
    clearGuard(guard);
    awaitingAck.length = 0;
    byItem.clear();
    seenItems.clear();
    // Socket cleanup must never prevent the operator's emergency/manual control.
    try {
      if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
      else upstream.close();
    } catch { /* The session is already invalidated synchronously. */ }
    try { browser.close(); } catch { /* A closed transport cannot receive further audio. */ }
  };
  const fail = message => {
    if (!closed) {
      audioFailed = true;
      diagnostics?.audio({ status: 'error', message, speechDetected: false });
      send({ type: 'error', message }); close();
    }
  };
  const detector = createTurnDetector({
    threshold, silenceMs,
    onLevel: level => diagnostics?.audio(level),
    onStart: () => { captureTraceId = diagnostics?.begin({ kind: 'microphone', model }); },
    append: buffer => post({ type: 'input_audio_buffer.append', audio: buffer.toString('base64') }),
    commit: ({ audioMs, reason }) => {
      if (closed || !ready) return;
      if (awaitingAck.length >= 32) return fail('Transcription is not acknowledging audio. Listening stopped.');
      const turn = { sequence: ++latestSequence, itemId: null, expired: false, partial: '', timer: null, traceId: captureTraceId, committedAt: performance.now() };
      captureTraceId = null;
      diagnostics?.update(turn.traceId, {
        transcript: { status: 'transcribing', commitReason: reason }, timings: { audioMs },
        route: { status: 'waiting', reason: 'Audio committed. Waiting for the final transcript.' },
      });
      awaitingAck.push(turn);
      // Time each local commit, including the time before the service ACKs it.
      turn.timer = setTimer(() => {
        timers.delete(turn.timer);
        turn.expired = true;
        diagnostics?.update(turn.traceId, { transcript: { status: 'timeout' }, route: { status: 'error', reason: 'No final transcript received within six seconds of committing audio.' } });
        if (turn.itemId) byItem.delete(turn.itemId);
        if (turn.sequence === latestSequence) fail('Transcription is taking too long. Listening stopped; try a typed cue.');
      }, 6000);
      timers.add(turn.timer);
      if (!post({ type: 'input_audio_buffer.commit' })) fail('Transcription disconnected. Listening stopped.');
    },
  });
  diagnostics?.audio(detector.settings);
  guard = setGuard(() => {
    if (!canListen()) close();
  }, 250);
  const connectionTimer = setTimer(() => fail('Could not start transcription. Check API access and network.'), 12000);
  timers.add(connectionTimer);
  upstream.on('open', () => post({
    type: 'session.update',
    session: { type: 'transcription', audio: { input: {
      format: { type: 'audio/pcm', rate: 24000 },
      transcription: {
        model, languages: ['en'],
        prompt: 'A presenter at a technology event in London, discussing an application, presentation slides, a live demonstration and backing music. There may be background audience chatter.',
        keywords: ['StageCue', 'Codex', 'OBS', 'DevDay'],
        ...(model === 'gpt-live-transcribe' ? { delay: 'medium' } : {}),
      },
      turn_detection: null,
    } } },
  }));
  upstream.on('message', raw => {
    if (closed) return;
    let event;
    try { event = JSON.parse(raw.toString()); } catch { return; }
    if (!event || typeof event !== 'object') return;
    if (event.type === 'session.updated') {
      if (!canListen()) return close();
      if (!ready) {
        ready = true; cancelTimer(connectionTimer);
        diagnostics?.audio({ status: 'listening', message: 'Transcription ready. Waiting for speech.' });
        send({ type: 'ready' });
      }
    }
    if (event.type === 'input_audio_buffer.committed') {
      if (!ready || typeof event.item_id !== 'string' || !event.item_id || seenItems.has(event.item_id)) return;
      seenItems.add(event.item_id);
      if (seenItems.size > 100) seenItems.delete(seenItems.values().next().value);
      const turn = awaitingAck.shift();
      if (!turn) return;
      turn.itemId = event.item_id;
      diagnostics?.update(turn.traceId, { transcript: { itemId: event.item_id } });
      if (!turn.expired) byItem.set(event.item_id, turn);
    }
    if (event.type === 'conversation.item.input_audio_transcription.delta') {
      const turn = byItem.get(event.item_id);
      if (!ready || !turn || turn.expired || turn.sequence !== latestSequence || typeof event.delta !== 'string') return;
      turn.partial = (turn.partial + event.delta).slice(0, 2000);
      diagnostics?.update(turn.traceId, { transcript: { status: 'partial', partial: turn.partial } });
      send({ type: 'partial', text: turn.partial });
    }
    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      const turn = byItem.get(event.item_id);
      if (!ready || !turn) return;
      byItem.delete(event.item_id);
      cancelTimer(turn.timer);
      const text = typeof event.transcript === 'string' ? event.transcript.trim() : '';
      diagnostics?.update(turn.traceId, {
        transcript: { status: 'final', final: text.slice(0, 2000) },
        timings: { transcriptionMs: Math.round(performance.now() - turn.committedAt) },
      });
      if (turn.expired || turn.sequence !== latestSequence) {
        diagnostics?.update(turn.traceId, { route: { status: 'ignored', reason: 'Outdated transcript: a newer audio turn replaced it. Not sent to Decisions.' } });
        return;
      }
      if (!canListen()) {
        diagnostics?.update(turn.traceId, { route: { status: 'cancelled', reason: 'Desk no longer accepts microphone cues. No decision requested.' } });
        return close();
      }
      if (text) {
        send({ type: 'transcript', text });
        void engine.cue(text, { traceId: turn.traceId }).catch(error => {
          diagnostics?.update(turn.traceId, { route: { status: 'error', reason: error.message } });
          send({ type: 'error', message: error.message });
        });
      } else diagnostics?.update(turn.traceId, { route: { status: 'ignored', reason: 'Final transcript was empty. No decision requested.' } });
    }
    if (event.type === 'conversation.item.input_audio_transcription.failed') {
      const turn = byItem.get(event.item_id);
      if (!turn) return;
      byItem.delete(event.item_id);
      cancelTimer(turn.timer);
      diagnostics?.update(turn.traceId, { transcript: { status: 'error' }, route: { status: 'error', reason: 'OpenAI could not transcribe this audio turn.' } });
      if (turn.sequence === latestSequence) fail('Transcription failed. Check API model access, billing, and microphone settings.');
    }
    if (event.type === 'error') fail('Transcription failed. Check API model access, billing, and microphone settings.');
  });
  upstream.on('error', () => fail('Transcription connection failed. Check your key and network.'));
  upstream.on('close', () => { if (!closed) fail('Transcription disconnected. Reconnect the microphone to continue.'); });
  browser.on('message', (raw, binary) => {
    if (!ready || closed) return;
    if (!canListen()) return close();
    if (!binary) {
      // An explicit end-of-phrase control works even when room noise never falls below the RMS gate.
      if (raw.length > 100) return;
      try { if (JSON.parse(raw.toString())?.type === 'finish_phrase') detector.finish(); } catch { /* Ignore invalid controls. */ }
      return;
    }
    if (!Buffer.isBuffer(raw) || raw.length > 48000 || raw.length % 2) return fail('Invalid microphone audio frame.');
    if (upstream.bufferedAmount > 480000) return fail('Audio connection cannot keep up. Listening stopped.');
    detector.push(raw);
  });
  browser.on('close', close);
  browser.on('error', close);
  return close;
}
