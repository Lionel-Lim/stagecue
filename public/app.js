const actions = { slides: 'Switch to Slides', demo: 'Switch to Demo', music_on: 'Drop the beat', music_off: 'Stop the music' };
const ui = Object.fromEntries([...document.querySelectorAll('[id]')].map((element) => [element.id, element]));
let state = null;
let online = false;
let fetching = false;
let mutations = 0;
let generation = 0;
let lastHistory = '';
let mic = null;
let micStarting = false;
let micEpoch = 0;
let beatContext = null;
let beatTimer = null;
let beatStep = 0;

function notify(message) {
  ui['error-text'].textContent = message;
  ui['error-notice'].hidden = !message;
}

function outputState() {
  if (state?.target !== 'obs') return { scene: state?.currentScene || 'Slides', musicPlaying: !!state?.musicPlaying };
  const actualScene = state.obs?.currentScene;
  const configured = state.obs?.configuredScenes || { slides: 'Slides', demo: 'Demo' };
  return {
    scene: actualScene || 'Not connected',
    sceneType: actualScene === configured.demo ? 'Demo' : actualScene === configured.slides ? 'Slides' : 'Unknown',
    musicPlaying: state.obs?.musicAvailable && state.obs?.musicMuted === false,
  };
}

function setOnline(value) {
  online = value;
  ui['server-status'].className = `connection-pill ${value ? 'online' : 'offline'}`;
  ui['server-status'].replaceChildren();
  const dot = document.createElement('span');
  dot.className = 'status-dot';
  ui['server-status'].append(dot, document.createTextNode(value ? 'Desk connected' : 'Desk offline'));
  if (!value) { stopMicrophone(); syncBeat(); }
}

async function api(path, body = {}) {
  const requestGeneration = ++generation;
  mutations++;
  updateControls();
  try {
    const response = await fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
    });
    const result = await response.json();
    if (requestGeneration === generation) {
      setOnline(true);
      if (result.state) render(result.state);
    }
    if (!response.ok || result.error) throw new Error(result.error || `Request failed (${response.status}).`);
    return result;
  } catch (error) {
    if (requestGeneration === generation) {
      if (error.name === 'TypeError') setOnline(false);
      notify(error.name === 'TimeoutError' ? 'That request timed out. Check the activity log before trying again.' : error.message);
    }
    return null;
  } finally {
    mutations--;
    updateControls();
  }
}

async function refresh() {
  if (fetching || mutations) return;
  fetching = true;
  const requestGeneration = generation;
  try {
    const response = await fetch('/api/state', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error('Cannot read desk state.');
    const result = await response.json();
    if (requestGeneration !== generation || mutations) return;
    setOnline(true);
    render(result.state || result);
  } catch {
    if (requestGeneration === generation) {
      setOnline(false);
      updateControls();
    }
  } finally { fetching = false; }
}

function render(next) {
  const previous = state;
  state = next;
  if (previous && (!state.armed || previous.provider !== state.provider || previous.target !== state.target || previous.speechMode !== state.speechMode || (state.target === 'obs' && !state.obs?.connected))) stopMicrophone();
  ui['arm-card'].classList.toggle('armed', !!state.armed);
  ui['armed-label'].textContent = state.armed ? 'ARMED' : 'STANDBY';
  ui['arm-button-text'].textContent = state.armed ? 'Desk armed' : 'Arm the desk';
  ui['arm-button'].setAttribute('aria-pressed', String(!!state.armed));
  ui['arm-description'].textContent = state.armed ? (state.mode === 'auto' ? 'Auto is active. Clear cues change the stage.' : 'You’re ready. Each recognised cue waits for your approval.') : 'Your cues stay inactive until you arm the desk.';
  for (const button of document.querySelectorAll('[data-mode]')) {
    const active = button.dataset.mode === state.mode;
    button.classList.toggle('selected', active);
    button.setAttribute('aria-pressed', String(active));
  }
  ui['provider-select'].value = state.provider;
  ui['target-select'].value = state.target;
  ui['speech-select'].value = state.speechMode || 'live';
  ui['mode-description'].textContent = state.mode === 'auto' ? 'Clear cues act immediately. Uncertain cues still ask.' : 'You approve each cue before the stage changes.';
  ui['engine-badge'].textContent = state.provider === 'openai' ? 'OPENAI DECISIONS' : 'REHEARSAL';
  ui['engine-explanation'].textContent = state.provider === 'openai'
    ? 'OpenAI Decisions uses your current cue, recent speech (up to 45 seconds), and stage state. Microphone audio is sent to OpenAI while listening. Stop clears conversation context.'
    : 'Rehearsal matches a few cue phrases without AI. Arm the desk and try one.';
  const output = outputState();
  const scene = output.scene;
  const sceneType = output.sceneType || scene;
  const demo = sceneType === 'Demo';
  const slides = sceneType === 'Slides';
  ui['stage-frame'].dataset.scene = sceneType;
  ui['slide-content'].hidden = !slides;
  ui['demo-content'].hidden = !demo;
  ui['external-scene-content'].hidden = demo || slides;
  ui['external-scene-name'].textContent = scene;
  ui['scene-label'].textContent = scene;
  ui['output-label'].textContent = state.target === 'obs' ? (state.obs?.connected ? 'OBS connected' : 'OBS disconnected') : 'Simulated OBS';
  ui['output-dot'].classList.toggle('live', state.target === 'rehearsal' || !!state.obs?.connected);
  ui['stage-preview-label'].textContent = state.target === 'obs' ? 'SCENE GUIDE' : 'REHEARSAL';
  ui['preview-caption'].textContent = state.target === 'obs'
    ? 'Scene guide only. Check the actual video output in OBS Studio.'
    : 'A local stage simulation. The rehearsal beat plays in this browser.';
  ui['obs-status-row'].hidden = state.target !== 'obs';
  ui['obs-status-text'].textContent = state.obs?.connected ? `Connected · ${(state.obs.scenes || []).length} scenes available` : (state.obs?.lastError || state.obs?.error || 'Connect OBS WebSocket to route your cues.');
  ui['obs-connect'].textContent = state.obs?.connected ? 'Connected ✓' : 'Connect OBS ↗';
  const warnings = [...(Array.isArray(state.obs?.warnings) ? state.obs.warnings : [])];
  if (state.obs?.connected && state.obs.lastError) warnings.unshift(state.obs.lastError);
  ui['obs-warning'].hidden = state.target !== 'obs' || !warnings.length;
  ui['obs-warning'].textContent = warnings.join(' · ');
  ui['beat-badge'].hidden = !output.musicPlaying;
  const history = Array.isArray(state.history) ? state.history : [];
  const latestDecision = history.find((item) => Number.isFinite(item.decisionMs) && item.source !== 'manual');
  const decisionMs = Number.isFinite(state.pending?.decisionMs) ? state.pending.decisionMs : latestDecision?.decisionMs;
  ui['latency-value'].textContent = Number.isFinite(decisionMs) ? `${Math.round(decisionMs)} ms` : '—';
  ui['pending-card'].hidden = !state.pending;
  if (state.pending) {
    ui['pending-action'].textContent = actions[state.pending.action] || state.pending.action;
    ui['pending-text'].textContent = `“${state.pending.text || ''}”`;
    const expiry = typeof state.pending.expiresAt === 'number' ? state.pending.expiresAt : Date.parse(state.pending.expiresAt);
    ui['pending-timer'].textContent = Number.isFinite(expiry) ? `${Math.max(0, Math.ceil((expiry - Date.now()) / 1000))}s` : '';
    if (state.pending.id !== previous?.pending?.id) {
      requestAnimationFrame(() => {
        const bounds = ui['pending-card'].getBoundingClientRect();
        const footerHeight = document.querySelector('.desk-footer').getBoundingClientRect().height;
        if (bounds.top < 12 || bounds.bottom > innerHeight - footerHeight - 12) {
          ui['pending-card'].scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
        }
      });
    }
  }
  for (const button of document.querySelectorAll('[data-action]')) {
    const action = button.dataset.action;
    const active = (action === 'slides' && slides) || (action === 'demo' && demo) || (action === 'music_on' && output.musicPlaying);
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  renderHistory(history);
  syncBeat();
  updateControls();
}

function updateControls() {
  const ready = !!state && online;
  const occupied = mutations > 0 || !!state?.busy;
  const armed = ready && !!state.armed;
  ui['arm-button'].disabled = !ready || occupied;
  ui['cue-submit'].disabled = !armed || occupied;
  ui['cue-input'].disabled = !ready;
  for (const button of document.querySelectorAll('[data-mode], [data-cue]')) button.disabled = !ready || occupied || (!!button.dataset.cue && !armed);
  ui['provider-select'].disabled = !ready || occupied;
  ui['target-select'].disabled = !ready || occupied;
  ui['speech-select'].disabled = !ready || occupied || state?.provider !== 'openai';
  ui['finish-phrase'].disabled = !mic?.ready;
  for (const button of document.querySelectorAll('[data-action]')) {
    const unavailable = state?.target === 'obs' && (!state.obs?.connected || (Array.isArray(state.obs.availableActions) && !state.obs.availableActions.includes(button.dataset.action)));
    button.disabled = !ready || mutations > 0 || unavailable;
    button.title = unavailable ? 'This scene or audio input is unavailable in OBS. Check the setup message above.' : '';
  }
  ui['confirm-button'].disabled = !armed || occupied || !state?.pending;
  ui['cancel-button'].disabled = !ready || occupied;
  ui['obs-connect'].disabled = !ready || occupied || !!state?.obs?.connected;
  const micEligible = armed && state.provider === 'openai' && !!state.ready?.apiKey && (state.target !== 'obs' || !!state.obs?.connected);
  ui['mic-button'].disabled = !mic && !micStarting && !micEligible;
  ui['mic-button'].setAttribute('aria-pressed', String(!!mic || micStarting));
  ui['mic-button'].setAttribute('aria-label', mic || micStarting ? 'Stop microphone' : 'Start microphone');
  ui['microphone-surface'].classList.toggle('listening', !!mic?.ready);
  ui['mic-status'].textContent = mic?.ready ? 'LISTENING' : micStarting ? 'CONNECTING' : 'OFF';
  ui['mic-heading'].textContent = mic?.ready ? 'The floor is yours.' : micStarting ? 'Opening your microphone…' : 'Ready when you are.';
  ui['mic-help'].textContent = mic?.ready ? 'Speak, then pause. If the room stays noisy, click Finish phrase. Click the mic to stop.'
    : micStarting ? 'Allow microphone access in your browser.'
      : state?.provider !== 'openai' ? 'Select OpenAI Decisions to use your microphone.'
        : !state?.ready?.apiKey ? 'Add OPENAI_API_KEY to your local .env, then restart.'
          : state.target === 'obs' && !state.obs?.connected ? 'Connect OBS before starting the microphone.'
            : !armed ? 'Arm the desk, then click the microphone to listen.'
              : state.speechMode === 'phrase' ? 'Waits for a fuller phrase; may add delay. Try a headset or close microphone in a noisy room.'
                : 'Click to listen. Audio is sent to OpenAI only while active.';
}

function renderHistory(history) {
  const signature = JSON.stringify(history);
  if (signature === lastHistory) return;
  lastHistory = signature;
  ui['activity-count'].textContent = `${history.length} EVENT${history.length === 1 ? '' : 'S'}`;
  ui['history-list'].replaceChildren();
  if (!history.length) {
    const empty = document.createElement('div'); empty.className = 'empty-history';
    const icon = document.createElement('span'); icon.textContent = '↳'; icon.setAttribute('aria-hidden', 'true');
    const message = document.createElement('p'); message.textContent = 'The quiet before the show.';
    const detail = document.createElement('span'); detail.textContent = 'Your cues and stage changes will appear here.';
    message.append(document.createElement('br'), detail); empty.append(icon, message); ui['history-list'].append(empty);
    return;
  }
  for (const event of history.slice(0, 30)) {
    const item = document.createElement('div'); item.className = 'history-item';
    const time = document.createElement('time'); time.className = 'history-time';
    const date = new Date(event.at);
    time.textContent = Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const icon = document.createElement('span'); icon.className = `history-icon${event.type === 'error' ? ' error' : ''}`;
    icon.textContent = event.type === 'error' ? '!' : ['pending', 'proposed'].includes(event.type) ? '◷' : '↗'; icon.setAttribute('aria-hidden', 'true');
    const content = document.createElement('div');
    const message = document.createElement('div'); message.className = 'history-message';
    message.textContent = actions[event.action] ? `${actions[event.action]} · ${event.message || event.type}` : event.message || event.type || 'Cue received';
    content.append(message);
    if (event.text) { const detail = document.createElement('div'); detail.className = 'history-detail'; detail.textContent = `“${event.text}”`; content.append(detail); }
    const meta = document.createElement('div'); meta.className = 'history-meta';
    meta.textContent = [event.source, Number.isFinite(event.decisionMs) ? `${Math.round(event.decisionMs)} ms decision` : null].filter(Boolean).join(' · ');
    item.append(time, icon, content, meta); ui['history-list'].append(item);
  }
}

async function unlockAudio() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    if (!beatContext || beatContext.state === 'closed') beatContext = new AudioContext();
    if (beatContext.state === 'suspended') await beatContext.resume();
    syncBeat();
  } catch { /* The desk works if browser audio is unavailable. */ }
}

function syncBeat() {
  const play = state?.target === 'rehearsal' && state.musicPlaying && online && beatContext?.state === 'running';
  if (!play && beatTimer) { clearInterval(beatTimer); beatTimer = null; }
  if (!play || beatTimer) return;
  beatStep = 0;
  const tick = () => {
    if (!beatContext || beatContext.state !== 'running') return;
    const at = beatContext.currentTime;
    const kick = beatStep % 2 === 0;
    const oscillator = beatContext.createOscillator();
    const gain = beatContext.createGain();
    oscillator.type = kick ? 'sine' : 'triangle';
    oscillator.frequency.setValueAtTime(kick ? 115 : 560, at);
    oscillator.frequency.exponentialRampToValueAtTime(kick ? 42 : 280, at + (kick ? .13 : .04));
    gain.gain.setValueAtTime(kick ? .19 : .025, at);
    gain.gain.exponentialRampToValueAtTime(.0001, at + (kick ? .22 : .065));
    oscillator.connect(gain); gain.connect(beatContext.destination);
    oscillator.start(at); oscillator.stop(at + .23);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    beatStep++;
  };
  tick(); beatTimer = setInterval(tick, 60000 / 105 / 2);
}

function stopMicrophone() {
  micEpoch++;
  micStarting = false;
  const active = mic;
  mic = null;
  if (active) {
    active.stream?.getTracks().forEach((track) => track.stop());
    if (active.ws && active.ws.readyState < WebSocket.CLOSING) active.ws.close();
    active.source?.disconnect(); active.worklet?.disconnect(); active.silence?.disconnect();
    if (active.context && active.context.state !== 'closed') active.context.close().catch(() => {});
  }
  updateControls();
}

async function startMicrophone() {
  if (mic || micStarting) { stopMicrophone(); return; }
  if (!state?.armed || state.provider !== 'openai' || !state.ready?.apiKey) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) { notify('This browser cannot capture audio here. Use current Chrome or Edge on localhost. Typed cues still work.'); return; }
  notify('');
  micStarting = true;
  const epoch = ++micEpoch;
  const active = { stream: null, context: null, ws: null, ready: false };
  mic = active;
  updateControls();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    if (epoch !== micEpoch) { stream.getTracks().forEach((track) => track.stop()); return; }
    active.stream = stream;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    active.context = new AudioContext();
    await active.context.audioWorklet.addModule('/pcm-worklet.js');
    if (epoch !== micEpoch) return;
    await active.context.resume();
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/audio`);
    active.ws = ws;
    const readyTimeout = setTimeout(() => {
      if (epoch === micEpoch && !active.ready) { notify('Microphone connection timed out. Check your OpenAI key and try again.'); stopMicrophone(); }
    }, 15000);
    ws.addEventListener('message', (event) => {
      if (epoch !== micEpoch || typeof event.data !== 'string') return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'ready' && !active.ready) {
        clearTimeout(readyTimeout);
        try {
          active.source = active.context.createMediaStreamSource(active.stream);
          active.worklet = new AudioWorkletNode(active.context, 'pcm-24-processor');
          // Connect through zero gain so the graph renders without microphone feedback.
          active.silence = active.context.createGain(); active.silence.gain.value = 0;
          active.source.connect(active.worklet); active.worklet.connect(active.silence); active.silence.connect(active.context.destination);
          active.worklet.port.onmessage = ({ data }) => {
            if (epoch === micEpoch && ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 96000) ws.send(data);
          };
          active.worklet.addEventListener('processorerror', () => {
            if (epoch === micEpoch) { notify('Microphone audio processing stopped. Click the mic to reconnect.'); stopMicrophone(); }
          });
          active.ready = true; micStarting = false; updateControls();
        } catch (error) { notify(`Microphone audio could not start: ${error.message}`); stopMicrophone(); }
      } else if (message.type === 'partial' || message.type === 'transcript') {
        ui.transcript.textContent = message.text || '';
        ui.transcript.classList.toggle('has-text', !!message.text);
        // The server submits final transcripts as cues; never submit them twice.
      } else if (message.type === 'error') {
        notify(message.message || 'The microphone connection reported an error.');
        stopMicrophone();
      }
    });
    ws.addEventListener('error', () => { if (epoch === micEpoch) { notify('Could not connect the microphone. Check the server and your OpenAI key.'); stopMicrophone(); } });
    ws.addEventListener('close', () => { clearTimeout(readyTimeout); if (epoch === micEpoch) { notify('Microphone connection ended. Click the mic to reconnect.'); stopMicrophone(); } });
    stream.getAudioTracks()[0]?.addEventListener('ended', () => { if (epoch === micEpoch) stopMicrophone(); });
  } catch (error) {
    if (epoch !== micEpoch) return;
    notify(error.name === 'NotAllowedError' ? 'Microphone access was denied. Allow it in your browser, or type a cue instead.' : `Microphone unavailable: ${error.message}`);
    stopMicrophone();
  }
}

async function submitCue(text) {
  if (!text.trim() || !state?.armed || mutations || state.busy) return;
  notify('');
  unlockAudio();
  const result = await api('/api/cue', { text: text.trim() });
  if (result) ui['cue-input'].value = '';
}

async function emergencyStop() {
  stopMicrophone();
  if (beatTimer) { clearInterval(beatTimer); beatTimer = null; }
  notify('');
  await api('/api/stop');
}

ui['arm-button'].addEventListener('click', async () => { unlockAudio(); if (state?.armed) stopMicrophone(); notify(''); await api('/api/arm', { armed: !state?.armed }); });
for (const button of document.querySelectorAll('[data-mode]')) button.addEventListener('click', () => api('/api/config', { mode: button.dataset.mode }));
ui['provider-select'].addEventListener('change', (event) => { stopMicrophone(); api('/api/config', { provider: event.target.value }); });
ui['target-select'].addEventListener('change', (event) => { stopMicrophone(); api('/api/config', { target: event.target.value }); });
ui['speech-select'].addEventListener('change', (event) => { stopMicrophone(); api('/api/config', { speechMode: event.target.value }); });
ui['finish-phrase'].addEventListener('click', () => { if (mic?.ready && mic.ws.readyState === WebSocket.OPEN) mic.ws.send(JSON.stringify({ type: 'finish_phrase' })); });
ui['cue-form'].addEventListener('submit', (event) => { event.preventDefault(); submitCue(ui['cue-input'].value); });
for (const button of document.querySelectorAll('[data-cue]')) button.addEventListener('click', () => submitCue(button.dataset.cue));
for (const button of document.querySelectorAll('[data-action]')) button.addEventListener('click', () => { unlockAudio(); api('/api/manual', { action: button.dataset.action }); });
ui['confirm-button'].addEventListener('click', () => { if (state?.pending) { unlockAudio(); api('/api/confirm', { id: state.pending.id }); } });
ui['cancel-button'].addEventListener('click', () => api('/api/cancel'));
ui['mic-button'].addEventListener('click', () => { unlockAudio(); startMicrophone(); });
ui['obs-connect'].addEventListener('click', () => api('/api/obs/connect'));
ui['stop-button'].addEventListener('click', emergencyStop);
ui['dismiss-error'].addEventListener('click', () => notify(''));
window.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); emergencyStop(); } });
window.addEventListener('pagehide', () => { stopMicrophone(); if (beatTimer) clearInterval(beatTimer); });
refresh();
setInterval(refresh, 500);
