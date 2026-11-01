const element = id => document.getElementById(id);
const text = (id, value) => { element(id).textContent = value; };
const percent = value => Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : 'Not available';
const readable = value => String(value || 'waiting').replaceAll('_', ' ');
let latestState;
let selectedId;
let listSignature;
let detailSignature;

export function setupDebug(clear) {
  element('debug-clear').addEventListener('click', clear);
  element('debug-turn-select').addEventListener('change', event => {
    selectedId = event.target.value;
    element('debug-follow').checked = false;
    detailSignature = null;
    renderDebug(latestState);
  });
  element('debug-follow').addEventListener('change', () => renderDebug(latestState));
}

export function renderDebug(state) {
  if (!state) return;
  latestState = state;
  const debug = state.debug || { turns: [], audio: {} };
  const audio = debug.audio;
  text('debug-audio-status', `${readable(audio.status || 'off')} · ${audio.model || 'microphone'} · ${audio.message || 'Microphone is off.'}`);
  text('debug-audio-level', audio.status === 'listening' && Number.isFinite(audio.rms)
    ? `Input RMS ${audio.rms.toFixed(4)} / speech gate ${audio.threshold} · ${audio.speechDetected ? 'above gate' : 'below gate'} · pause ${audio.silenceMs} ms` : '');
  const turns = debug.turns || [];
  text('debug-count', `${turns.length} TRACE${turns.length === 1 ? '' : 'S'}`);
  element('debug-empty').hidden = !!turns.length;
  element('debug-detail').hidden = !turns.length;
  element('debug-turn-select').disabled = !turns.length;
  const signature = JSON.stringify(turns.map(turn => [turn.id, turn.route.status, (turn.transcript.final || turn.transcript.partial).slice(0, 70)]));
  if (signature !== listSignature) {
    listSignature = signature;
    element('debug-turn-select').replaceChildren();
    for (const turn of turns) {
      const option = document.createElement('option');
      option.value = turn.id;
      const time = new Date(turn.at).toLocaleTimeString('en-GB');
      option.textContent = `${time} · ${turn.input.kind} · ${readable(turn.route.status)} · ${(turn.transcript.final || turn.transcript.partial || 'Capturing speech…').slice(0, 70)}`;
      element('debug-turn-select').append(option);
    }
    if (!turns.length) {
      const option = document.createElement('option'); option.textContent = 'No cues yet';
      element('debug-turn-select').append(option);
    }
  }
  if (element('debug-follow').checked || !turns.some(turn => turn.id === selectedId)) selectedId = turns[0]?.id;
  if (!selectedId) {
    detailSignature = null;
    for (const id of ['debug-partial', 'debug-final', 'debug-request-json', 'debug-trace-json', 'debug-context-list', 'debug-probability-rows', 'debug-timings']) element(id).replaceChildren();
    return;
  }
  element('debug-turn-select').value = selectedId;
  const turn = turns.find(item => item.id === selectedId);
  const currentSignature = JSON.stringify(turn);
  if (currentSignature === detailSignature) return;
  detailSignature = currentSignature;
  text('debug-transcript-status', readable(turn.transcript.status));
  text('debug-input-meta', [turn.input.kind, turn.input.model, turn.input.provider, turn.input.mode, turn.input.target].filter(Boolean).join(' · '));
  text('debug-partial', turn.transcript.partial || (turn.input.kind === 'microphone' ? 'No partial text received.' : 'Not applicable to this input.'));
  text('debug-final-label', turn.input.kind === 'microphone' ? 'FINAL TRANSCRIPT' : 'INPUT TEXT');
  text('debug-final', turn.transcript.final || (turn.transcript.status === 'final' ? '(empty transcript)' : 'Waiting for final transcript…'));

  const context = turn.context;
  text('debug-stage-context', context ? `Scene: ${context.stage.scene}. Music: ${context.stage.musicPlaying === null ? 'unknown' : context.stage.musicPlaying ? 'playing' : 'off'}.` : 'No context sent to OpenAI for this trace.');
  element('debug-context-list').replaceChildren();
  for (const utterance of context?.recentUtterances || []) {
    const item = document.createElement('li'); item.textContent = utterance; element('debug-context-list').append(item);
  }
  if (!context?.recentUtterances?.length) {
    const item = document.createElement('li'); item.textContent = 'No earlier speech included.'; element('debug-context-list').append(item);
  }

  const decision = turn.decision;
  text('debug-decision-value', decision?.error ? `Error: ${decision.code}` : decision ? `${decision.action} · ${decision.source === 'openai' ? 'gpt-6-luna' : 'offline phrase match'}` : 'No decision result');
  text('debug-confidence', decision?.error || (decision && !Number.isFinite(decision.confidence)) ? decision.error || 'No valid confidence returned.' : decision?.source === 'rehearsal' ? 'Deterministic phrase match; no AI confidence score.' : decision ? `Selected-option confidence: ${percent(decision.confidence)}` : 'Waiting, skipped, or not requested. See the app action.');
  const probabilities = decision?.answer?.probabilities || [];
  element('debug-probabilities').hidden = !probabilities.length;
  element('debug-probability-rows').replaceChildren();
  for (const probability of probabilities) {
    const row = document.createElement('tr');
    row.classList.toggle('chosen', probability.value === decision.action);
    const name = document.createElement('td'); name.textContent = probability.value;
    const value = document.createElement('td'); value.textContent = percent(probability.probability);
    row.append(name, value); element('debug-probability-rows').append(row);
  }
  text('debug-route-status', readable(turn.route.status));
  text('debug-route-reason', turn.route.reason);
  const output = turn.output;
  text('debug-output', output.status === 'not_sent' ? 'Output: no action sent.'
    : [`Output: ${readable(output.status)}`, output.target, output.action, output.scene ? `scene ${output.scene}` : '', output.message].filter(Boolean).join(' · '));
  element('debug-timings').replaceChildren();
  for (const [key, label] of [['audioMs', 'Audio duration'], ['transcriptionMs', 'Transcription after commit'], ['decisionMs', 'Decision'], ['dispatchMs', 'Dispatch']]) {
    const title = document.createElement('dt'); title.textContent = label;
    const value = document.createElement('dd'); value.textContent = Number.isFinite(turn.timings[key]) ? `${Math.round(turn.timings[key])} ms` : '—';
    element('debug-timings').append(title, value);
  }
  text('debug-request-json', turn.request ? JSON.stringify(turn.request, null, 2) : 'No OpenAI Decisions request for this trace.');
  text('debug-trace-json', JSON.stringify(turn, null, 2));
}
