import { randomUUID } from 'node:crypto';

// Bounded, in-memory diagnostics. Callers supply selected fields, never HTTP headers,
// environment variables, raw audio, or unfiltered upstream responses/errors.
export function createDebugStore({ now = Date.now } = {}) {
  let turns = [];
  let audio = { status: 'off', message: 'Microphone is off.' };
  const stamp = () => new Date(now()).toISOString();
  const get = id => turns.find(turn => turn.id === id);
  return {
    begin({ kind = 'typed', text = '', model = null } = {}) {
      const id = randomUUID();
      turns.unshift({
        id, at: stamp(), input: { kind, model },
        transcript: { status: kind === 'microphone' ? 'capturing' : 'final', partial: '', final: text.slice(0, 2000) },
        context: null, request: null, decision: null,
        route: { status: 'waiting', reason: kind === 'microphone' ? 'Waiting for the end of the spoken phrase.' : 'Input received.' },
        output: { status: 'not_sent' }, timings: {},
      });
      turns = turns.slice(0, 20);
      return id;
    },
    update(id, patch) {
      const turn = get(id);
      if (!turn) return; // A cleared/evicted trace must not reappear on a late reply.
      for (const key of ['input', 'transcript', 'route', 'output', 'timings']) {
        if (patch[key]) turn[key] = { ...turn[key], ...structuredClone(patch[key]) };
      }
      for (const key of ['context', 'request', 'decision']) {
        if (Object.hasOwn(patch, key)) turn[key] = structuredClone(patch[key]);
      }
    },
    get(id) { return get(id) ? structuredClone(get(id)) : null; },
    audio(patch) { audio = { ...audio, ...structuredClone(patch), at: stamp() }; },
    clear() { turns = []; },
    snapshot() { return structuredClone({ audio, turns }); },
  };
}
