import { randomUUID } from 'node:crypto';
import { decideCue, rehearseCue, buildDecisionRequest } from './decision.mjs';
import { createDebugStore } from './debug.mjs';

export const ACTIONS = ['slides', 'demo', 'music_on', 'music_off'];

export function createEngine({ obs, apiKey, decide = decideCue, now = Date.now } = {}) {
  const diagnostics = createDebugStore({ now });
  const state = {
    armed: false, mode: 'ask', target: 'rehearsal', provider: 'rehearsal',
    currentScene: 'Slides', musicPlaying: false, pending: null, history: [], busy: false, speechMode: 'live',
  };
  let recentUtterances = [];
  function decisionContext() {
    recentUtterances = recentUtterances.filter(item => now() - item.at < 45_000).slice(-4);
    const status = state.target === 'obs' ? obs?.status() : null;
    const scenes = status?.configuredScenes ?? { slides: 'Slides', demo: 'Demo' };
    const scene = status
      ? status.connected && status.currentScene === scenes.slides ? 'slides'
        : status.connected && status.currentScene === scenes.demo ? 'demo' : 'unknown'
      : state.currentScene.toLowerCase();
    const musicPlaying = status
      ? status.connected && status.musicAvailable && typeof status.musicMuted === 'boolean' ? !status.musicMuted : null
      : state.musicPlaying;
    return { recentUtterances: recentUtterances.map(item => item.text), stage: { scene, musicPlaying } };
  }
  let generation = 0;
  let request;
  let execution = Promise.resolve();
  let dispatching = 0;
  let activeTraceId = null;
  let runningTraceId = null;
  const queuedTraceIds = new Set();
  const log = (type, details = {}) => {
    state.history.unshift({ id: randomUUID(), at: new Date(now()).toISOString(), type, ...details });
    state.history = state.history.slice(0, 30);
  };
  const invalidate = (reason = 'Superseded by a newer cue or settings change.') => {
    for (const id of new Set([activeTraceId, runningTraceId, state.pending?.traceId, ...queuedTraceIds])) {
      if (id) diagnostics.update(id, { route: { status: 'cancelled', reason }, ...(id === runningTraceId ? { output: { status: 'cancelled', message: 'Dispatch cancelled. Check OBS for its current output.' } } : {}) });
    }
    activeTraceId = null;
    generation++;
    request?.abort();
    request = null;
    state.busy = false;
    state.pending = null;
  };
  function expirePending() {
    if (state.pending && state.pending.expiresAt <= now()) {
      diagnostics.update(state.pending.traceId, { route: { status: 'expired', reason: 'Confirmation expired after 15 seconds. No action sent.' } });
      state.pending = null;
    }
  }
  function snapshot() {
    expirePending();
    return structuredClone({ ...state, debug: diagnostics.snapshot(), obs: obs?.status() ?? { connected: false, scenes: [] }, ready: { apiKey: Boolean(apiKey) } });
  }
  function serialize(fn) {
    const next = execution.then(fn, fn);
    execution = next.catch(() => {});
    return next;
  }
  async function execute(cue, version, manual = false) {
    if (cue.traceId) queuedTraceIds.add(cue.traceId);
    return serialize(async () => {
      queuedTraceIds.delete(cue.traceId);
      if (version !== generation || (!manual && !state.armed)) return;
      if (!ACTIONS.includes(cue.action)) throw new Error('Unsupported stage action.');
      const start = performance.now();
      dispatching++;
      runningTraceId = cue.traceId;
      diagnostics.update(cue.traceId, {
        route: { status: 'dispatching', reason: manual ? 'Explicit manual control; no model used.' : 'Cue approved for dispatch.' },
        output: { status: 'dispatching', target: state.target, action: cue.action },
      });
      try {
        if (state.target === 'obs') {
          if (!obs.status().connected) throw new Error('OBS disconnected. Reconnect before sending a cue.');
          await obs.execute(cue.action);
        }
      } catch (error) {
        if (version === generation) diagnostics.update(cue.traceId, {
          route: { status: 'error', reason: error.message },
          output: { status: 'error', message: error.message },
          timings: { dispatchMs: Math.round(performance.now() - start) },
        });
        throw error;
      } finally { dispatching--; if (runningTraceId === cue.traceId) runningTraceId = null; }
      if (version !== generation) return;
      if (cue.action === 'slides') state.currentScene = 'Slides';
      if (cue.action === 'demo') state.currentScene = 'Demo';
      if (cue.action === 'music_on') state.musicPlaying = true;
      if (cue.action === 'music_off') state.musicPlaying = false;
      log('executed', { ...cue, target: state.target, dispatchMs: Math.round(performance.now() - start), message: state.target === 'obs' ? 'OBS acknowledged the cue.' : 'Rehearsal output updated.' });
      const authorization = manual ? 'Explicit manual control; no model used.'
        : cue.confirmed ? 'Presenter confirmed the proposed cue.'
          : `Auto accepted confidence ${(cue.confidence * 100).toFixed(1)}% at or above the 85% threshold.`;
      diagnostics.update(cue.traceId, {
        route: { status: 'executed', reason: `${authorization} ${state.target === 'obs' ? 'OBS acknowledged the cue.' : 'Rehearsal output updated.'}` },
        output: { status: state.target === 'obs' ? 'acknowledged' : 'simulated', scene: state.target === 'obs' ? obs.status().currentScene : state.currentScene, musicPlaying: state.musicPlaying },
        timings: { dispatchMs: Math.round(performance.now() - start) },
      });
    });
  }
  async function stop() {
    invalidate('Stop / disarm cancelled this cue.');
    recentUtterances = [];
    state.armed = false;
    const version = generation;
    if (state.target === 'obs' && obs.status().connected) await obs.stop();
    else if (state.target === 'obs' && state.musicPlaying) throw new Error('OBS is disconnected. Mute Beat directly in OBS.');
    if (version !== generation) return snapshot();
    state.musicPlaying = false;
    log('stopped', { message: 'Disarmed. Pending cues cleared. Music stopped.' });
    return snapshot();
  }
  async function configure(config) {
    for (const [key, values] of Object.entries({ mode: ['ask', 'auto'], target: ['rehearsal', 'obs'], provider: ['rehearsal', 'openai'], speechMode: ['live', 'phrase'] })) {
      if (key in config && !values.includes(config[key])) throw new Error(`Invalid ${key}.`);
    }
    if (dispatching || (config.target && config.target !== state.target) || (config.provider && config.provider !== state.provider)) {
      const stopping = stop();
      const version = generation;
      await stopping;
      if (version !== generation) throw new Error('Settings change cancelled by a newer action.');
    }
    else invalidate();
    recentUtterances = [];
    for (const key of ['mode', 'target', 'provider', 'speechMode']) if (config[key]) state[key] = config[key];
    return snapshot();
  }
  function arm(armed) {
    if (typeof armed !== 'boolean') throw new Error('Armed must be true or false.');
    if (!armed) return stop();
    invalidate('Re-arming cleared earlier pending work.');
    recentUtterances = [];
    if (armed && state.provider === 'openai' && !apiKey) throw new Error('Add OPENAI_API_KEY to .env and restart first.');
    if (armed && state.target === 'obs' && !obs.status().connected) throw new Error('Connect OBS before arming.');
    state.armed = armed;
    return snapshot();
  }
  async function cue(text, { traceId } = {}) {
    if (typeof text !== 'string' || !text.trim() || text.length > 1000) throw new Error('Enter a cue between 1 and 1,000 characters.');
    traceId ??= diagnostics.begin({ kind: 'typed', text: text.trim() });
    if (!state.armed) {
      diagnostics.update(traceId, { route: { status: 'ignored', reason: 'Desk is disarmed. No decision requested and no action sent.' } });
      log('ignored', { text, message: 'Disarmed. No action taken.' }); return snapshot();
    }
    invalidate();
    activeTraceId = traceId;
    const version = generation;
    request = new AbortController();
    state.busy = true;
    const context = decisionContext();
    diagnostics.update(traceId, {
      context: state.provider === 'openai' ? context : null,
      request: state.provider === 'openai' ? buildDecisionRequest(text, context) : null,
      route: { status: 'processing', reason: state.provider === 'openai' ? 'Waiting for OpenAI Decisions.' : 'Checking the offline phrase list.' },
      input: { provider: state.provider, mode: state.mode, target: state.target },
    });
    const decisionStarted = performance.now();
    recentUtterances.push({ text: text.trim(), at: now() });
    recentUtterances = recentUtterances.slice(-4);
    try {
      const decision = state.provider === 'openai' ? await decide(text, { apiKey, signal: request.signal, context }) : await rehearseCue(text);
      if (version !== generation || !state.armed) return snapshot();
      activeTraceId = null;
      state.busy = false;
      diagnostics.update(traceId, {
        decision: { action: decision.action, confidence: decision.confidence, source: decision.source, answer: decision.answer ?? null },
        timings: { decisionMs: decision.decisionMs },
      });
      const item = { ...decision, text, traceId, id: randomUUID(), expiresAt: now() + 15000 };
      if (!ACTIONS.includes(item.action) || !Number.isFinite(item.confidence) || item.confidence < 0.6) {
        const reason = item.action === 'none' ? (item.source === 'rehearsal' ? 'Offline phrase list found no matching cue.' : 'Model selected none: no stage action.')
          : !ACTIONS.includes(item.action) || !Number.isFinite(item.confidence) ? 'Invalid action or confidence; nothing sent.'
            : `Confidence ${(item.confidence * 100).toFixed(1)}% is below the 60% proposal threshold.`;
        diagnostics.update(traceId, { route: { status: 'ignored', reason } });
        log('ignored', { ...item, message: `${reason} Nothing changed.` });
      } else if (state.mode === 'ask' || item.confidence < 0.85) {
        diagnostics.update(traceId, { route: { status: 'awaiting_confirmation', reason: state.mode === 'ask' ? 'Ask first requires your confirmation (15 seconds).' : `Confidence ${(item.confidence * 100).toFixed(1)}% is below the 85% Auto threshold. Confirmation required (15 seconds).` } });
        state.pending = item;
        log('proposed', { ...item, message: 'Waiting for confirmation (15 seconds).' });
      } else await execute(item, version);
    } catch (error) {
      if (version === generation) {
        activeTraceId = null;
        const trace = diagnostics.get(traceId);
        diagnostics.update(traceId, {
          route: { status: 'error', reason: error.message },
          ...(trace?.decision ? {} : { decision: { error: error.message, code: error.code || 'DECISION_ERROR' }, timings: { decisionMs: Math.round(performance.now() - decisionStarted) } }),
        });
        state.busy = false;
        log('error', { text, message: error.message });
        throw error;
      }
    }
    return snapshot();
  }
  async function confirm(id) {
    expirePending();
    const pending = state.pending;
    if (!pending || pending.id !== id || pending.expiresAt <= now() || !state.armed) throw new Error('This cue expired or was cancelled. Say it again.');
    state.pending = null;
    await execute({ ...pending, confirmed: true }, generation);
    return snapshot();
  }
  async function cancel() {
    recentUtterances = [];
    if (dispatching) await stop();
    else invalidate('Presenter dismissed the cue.');
    log('cancelled', { message: 'Pending cue dismissed.' }); return snapshot();
  }
  async function manual(action) {
    if (!ACTIONS.includes(action)) throw new Error('Unsupported stage action.');
    recentUtterances = [];
    if (dispatching) await stop();
    invalidate('Explicit manual control replaced the cue.');
    const traceId = diagnostics.begin({ kind: 'manual', text: action });
    await execute({ action, traceId, text: 'Manual control', source: 'manual', confidence: 1, decisionMs: 0 }, generation, true);
    return snapshot();
  }
  return { snapshot, configure, arm, cue, confirm, cancel, stop, manual, diagnostics,
    clearDebug() { diagnostics.clear(); return snapshot(); },
  };
}
