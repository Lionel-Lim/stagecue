import { randomUUID } from 'node:crypto';
import { decideCue, rehearseCue } from './decision.mjs';

export const ACTIONS = ['slides', 'demo', 'music_on', 'music_off'];

export function createEngine({ obs, apiKey, decide = decideCue, now = Date.now } = {}) {
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
  const log = (type, details = {}) => {
    state.history.unshift({ id: randomUUID(), at: new Date(now()).toISOString(), type, ...details });
    state.history = state.history.slice(0, 30);
  };
  const invalidate = () => {
    generation++;
    request?.abort();
    request = null;
    state.busy = false;
    state.pending = null;
  };
  function snapshot() {
    if (state.pending && state.pending.expiresAt <= now()) state.pending = null;
    return structuredClone({ ...state, obs: obs?.status() ?? { connected: false, scenes: [] }, ready: { apiKey: Boolean(apiKey) } });
  }
  function serialize(fn) {
    const next = execution.then(fn, fn);
    execution = next.catch(() => {});
    return next;
  }
  async function execute(cue, version, manual = false) {
    return serialize(async () => {
      if (version !== generation || (!manual && !state.armed)) return;
      if (!ACTIONS.includes(cue.action)) throw new Error('Unsupported stage action.');
      const start = performance.now();
      dispatching++;
      try {
        if (state.target === 'obs') {
          if (!obs.status().connected) throw new Error('OBS disconnected. Reconnect before sending a cue.');
          await obs.execute(cue.action);
        }
      } finally { dispatching--; }
      if (version !== generation) return;
      if (cue.action === 'slides') state.currentScene = 'Slides';
      if (cue.action === 'demo') state.currentScene = 'Demo';
      if (cue.action === 'music_on') state.musicPlaying = true;
      if (cue.action === 'music_off') state.musicPlaying = false;
      log('executed', { ...cue, target: state.target, dispatchMs: Math.round(performance.now() - start), message: state.target === 'obs' ? 'OBS acknowledged the cue.' : 'Rehearsal output updated.' });
    });
  }
  async function stop() {
    invalidate();
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
    invalidate();
    recentUtterances = [];
    if (armed && state.provider === 'openai' && !apiKey) throw new Error('Add OPENAI_API_KEY to .env and restart first.');
    if (armed && state.target === 'obs' && !obs.status().connected) throw new Error('Connect OBS before arming.');
    state.armed = armed;
    return snapshot();
  }
  async function cue(text) {
    if (typeof text !== 'string' || !text.trim() || text.length > 1000) throw new Error('Enter a cue between 1 and 1,000 characters.');
    if (!state.armed) { log('ignored', { text, message: 'Disarmed. No action taken.' }); return snapshot(); }
    invalidate();
    const version = generation;
    request = new AbortController();
    state.busy = true;
    const context = decisionContext();
    recentUtterances.push({ text: text.trim(), at: now() });
    recentUtterances = recentUtterances.slice(-4);
    try {
      const decision = state.provider === 'openai' ? await decide(text, { apiKey, signal: request.signal, context }) : await rehearseCue(text);
      if (version !== generation || !state.armed) return snapshot();
      state.busy = false;
      const item = { ...decision, text, id: randomUUID(), expiresAt: now() + 15000 };
      if (!ACTIONS.includes(item.action) || !Number.isFinite(item.confidence) || item.confidence < 0.6) {
        log('ignored', { ...item, message: 'No clear stage cue. Nothing changed.' });
      } else if (state.mode === 'ask' || item.confidence < 0.85) {
        state.pending = item;
        log('proposed', { ...item, message: 'Waiting for confirmation (15 seconds).' });
      } else await execute(item, version);
    } catch (error) {
      if (version === generation) {
        state.busy = false;
        log('error', { text, message: error.message });
        throw error;
      }
    }
    return snapshot();
  }
  async function confirm(id) {
    const pending = state.pending;
    if (!pending || pending.id !== id || pending.expiresAt <= now() || !state.armed) throw new Error('This cue expired or was cancelled. Say it again.');
    state.pending = null;
    await execute(pending, generation);
    return snapshot();
  }
  async function cancel() {
    recentUtterances = [];
    if (dispatching) await stop();
    else invalidate();
    log('cancelled', { message: 'Pending cue dismissed.' }); return snapshot();
  }
  async function manual(action) {
    if (!ACTIONS.includes(action)) throw new Error('Unsupported stage action.');
    recentUtterances = [];
    if (dispatching) await stop();
    invalidate();
    await execute({ action, text: 'Manual control', source: 'manual', confidence: 1, decisionMs: 0 }, generation, true);
    return snapshot();
  }
  return { snapshot, configure, arm, cue, confirm, cancel, stop, manual };
}
