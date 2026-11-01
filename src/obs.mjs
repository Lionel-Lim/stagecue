// OBS WebSocket v5: only named, preconfigured presentation actions are exposed.
export const OBS_ACTIONS = Object.freeze(['slides', 'demo', 'music_on', 'music_off']);

class ObsControllerError extends Error {}
const cancelled = () => new ObsControllerError('Cue cancelled by stop or disconnect.');
const disconnected = () => new ObsControllerError('OBS is disconnected. Connect before sending a cue.');

function safeError(error, fallback) {
  if (error instanceof ObsControllerError) return error;
  const code = Number.isFinite(error?.code) ? ` (OBS code ${error.code})` : '';
  return new ObsControllerError(`${fallback}${code}`);
}

export function createObsController({
  url = 'ws://127.0.0.1:4455',
  password,
  scenes = { slides: 'Slides', demo: 'Demo' },
  musicInput = 'Music',
  client: injectedClient,
  clientFactory,
  connectTimeoutMs = 5000,
  requestTimeoutMs = 3000,
} = {}) {
  const sceneMap = { slides: scenes.slides, demo: scenes.demo };
  const makeClient = clientFactory ?? (injectedClient ? () => injectedClient : async () => {
    const { OBSWebSocket } = await import('obs-websocket-js');
    return new OBSWebSocket();
  });
  let connection;
  let connected = false;
  let currentScene = null;
  let sceneNames = [];
  let musicMuted = null;
  let musicAvailable = false;
  let lastError = null;
  let warnings = [];
  let connecting;
  let queue = Promise.resolve();
  let generation = 0;

  const status = () => ({
    connected,
    currentScene,
    scenes: [...sceneNames],
    musicMuted,
    musicAvailable,
    configuredScenes: { ...sceneMap },
    musicInput,
    availableActions: connected ? OBS_ACTIONS.filter((action) =>
      action.startsWith('music_') ? musicAvailable : sceneNames.includes(sceneMap[action])) : [],
    warnings: [...warnings],
    lastError,
  });

  function retire(record, error, report = true) {
    if (!record || record.closed) return;
    record.closed = true;
    if (connection === record) {
      connected = false;
      connection = undefined;
      generation += 1;
      queue = Promise.resolve();
      if (report) lastError = error.message;
    }
    if (connecting?.record === record) connecting = undefined;
    for (const waiter of [...record.waiters]) waiter.reject(error);
    for (const [event, handler] of record.listeners) record.client?.off?.(event, handler);
    // Never wait for the underlying client's close: it can itself hang after
    // a lost connection. A new real connection uses a fresh client instance.
    try { Promise.resolve(record.client?.disconnect()).catch(() => {}); } catch {}
  }

  function bindEvents(record) {
    const active = () => connection === record && !record.closed;
    const handlers = {
      ConnectionClosed: () => { if (active()) retire(record, disconnected()); },
      CurrentProgramSceneChanged: ({ sceneName }) => { if (active()) currentScene = sceneName; },
      InputMuteStateChanged: ({ inputName, inputMuted }) => {
        if (active() && inputName === musicInput) musicMuted = inputMuted;
      },
    };
    for (const [event, handler] of Object.entries(handlers)) {
      record.client.on?.(event, handler);
      record.listeners.push([event, handler]);
    }
  }

  function bounded(record, operation, timeoutMs, label, actionGeneration) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        record.waiters.delete(waiter);
        callback(value);
      };
      const waiter = { action: actionGeneration !== undefined, reject: error => finish(reject, error) };
      if (connection !== record || record.closed) return waiter.reject(disconnected());
      record.waiters.add(waiter);
      timer = setTimeout(() => retire(record,
        new ObsControllerError(`OBS ${label} timed out. Reconnect OBS before sending another cue.`)), timeoutMs);
      Promise.resolve().then(() => {
        if (settled) return;
        if (actionGeneration !== undefined) ensureActive(actionGeneration);
        return operation();
      }).then(value => {
        if (settled) return;
        if (connection !== record || record.closed) return waiter.reject(disconnected());
        if (actionGeneration !== undefined && generation !== actionGeneration) return waiter.reject(cancelled());
        finish(resolve, value);
      }, error => finish(reject, error));
    });
  }

  function call(method, data, expectedGeneration) {
    ensureActive(expectedGeneration);
    const record = connection;
    return bounded(record, () => record.client.call(method, data), requestTimeoutMs, 'request', expectedGeneration);
  }

  async function connect() {
    if (connected) return status();
    if (connecting) return connecting.promise;
    const record = { client: undefined, waiters: new Set(), listeners: [], closed: false };
    connection = record;
    const attempt = (async () => {
      try {
        record.client = await bounded(record, makeClient, connectTimeoutMs, 'connection');
        if (connection !== record || record.closed) throw disconnected();
        bindEvents(record);
        await bounded(record, () => record.client.connect(url, password, { rpcVersion: 1 }), connectTimeoutMs, 'connection');
        const [sceneResult, musicResult] = await Promise.allSettled([
          bounded(record, () => record.client.call('GetSceneList'), requestTimeoutMs, 'request'),
          musicInput ? bounded(record, () => record.client.call('GetInputMute', { inputName: musicInput }), requestTimeoutMs, 'request') : Promise.resolve(null),
        ]);
        if (sceneResult.status === 'rejected') throw sceneResult.reason;
        if (connection !== record || record.closed) throw disconnected();
        const list = sceneResult.value;
        sceneNames = list.scenes.map((scene) => scene.sceneName);
        currentScene = list.currentProgramSceneName ?? null;
        musicAvailable = musicResult.status === 'fulfilled' && musicResult.value !== null;
        musicMuted = musicAvailable ? musicResult.value.inputMuted : null;
        warnings = [];
        for (const action of ['slides', 'demo']) {
          if (!sceneNames.includes(sceneMap[action])) warnings.push(`OBS scene for ${action} is missing: ${sceneMap[action] || '(not configured)'}`);
        }
        if (!musicAvailable) warnings.push(`OBS music input is missing or has no audio: ${musicInput || '(not configured)'}`);
        connected = true;
        lastError = null;
        return status();
      } catch (error) {
        const safe = safeError(error, 'Could not connect to OBS. Check Tools → WebSocket Server Settings, the address, and password.');
        retire(record, safe);
        throw safe;
      }
    })();
    connecting = { record, promise: attempt };
    try { return await attempt; }
    finally { if (connecting?.record === record) connecting = undefined; }
  }

  async function disconnect() {
    retire(connection, disconnected(), false);
    return status();
  }

  function ensureActive(expectedGeneration) {
    if (!connected) throw disconnected();
    if (generation !== expectedGeneration) throw cancelled();
  }

  async function stopMusic(expectedGeneration) {
    // Muting the mixer does not stop the media transport. Send both requests
    // immediately: failure of one must not prevent the other being attempted.
    const results = await Promise.allSettled([
      call('SetInputMute', { inputName: musicInput, inputMuted: true }, expectedGeneration).then(() => {
        ensureActive(expectedGeneration);
        musicMuted = true;
      }),
      call('TriggerMediaInputAction', {
        inputName: musicInput,
        mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP',
      }, expectedGeneration),
    ]);
    ensureActive(expectedGeneration);
    if (results.some(result => result.status === 'rejected')) {
      throw new ObsControllerError('Could not fully stop music in OBS. Use the OBS audio mixer and media controls.');
    }
  }

  async function perform(action, expectedGeneration) {
    ensureActive(expectedGeneration);
    if (action === 'slides' || action === 'demo') {
      const sceneName = sceneMap[action];
      if (!sceneName || !sceneNames.includes(sceneName)) throw new ObsControllerError(`Configure an existing OBS scene for ${action} before sending this cue.`);
      await call('SetCurrentProgramScene', { sceneName }, expectedGeneration);
      ensureActive(expectedGeneration);
      currentScene = sceneName;
    } else {
      if (!musicAvailable) throw new ObsControllerError('Configure an OBS music input with audio before sending this cue.');
      if (action === 'music_off') {
        await stopMusic(expectedGeneration);
      } else {
        // Keep the source muted until restart succeeds. A missing/invalid media
        // source must never fall through to an unexpected unmute.
        await call('SetInputMute', { inputName: musicInput, inputMuted: true }, expectedGeneration);
        ensureActive(expectedGeneration);
        musicMuted = true;
        await call('TriggerMediaInputAction', {
          inputName: musicInput,
          mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
        }, expectedGeneration);
        ensureActive(expectedGeneration);
        await call('SetInputMute', { inputName: musicInput, inputMuted: false }, expectedGeneration);
        ensureActive(expectedGeneration);
        musicMuted = false;
      }
    }
    lastError = null;
    return { action, ...status() };
  }

  async function execute(action) {
    if (!OBS_ACTIONS.includes(action)) throw new Error('Unsupported OBS action.');
    const expectedGeneration = generation;
    const result = queue.then(() => perform(action, expectedGeneration));
    queue = result.catch(() => {});
    try {
      return await result;
    } catch (error) {
      const safe = safeError(error, `OBS could not execute ${action}. Check the configured scene or media source.`);
      if (generation === expectedGeneration) lastError = safe.message;
      throw safe;
    }
  }

  async function stop() {
    generation += 1;
    const expectedGeneration = generation;
    for (const waiter of [...(connection?.waiters ?? [])]) if (waiter.action) waiter.reject(cancelled());
    queue = Promise.resolve();
    // Do not queue behind media playback: mute and stop immediately, and invalidate
    // pending cues so that an in-flight restart cannot unmute afterward.
    if (connected && musicAvailable) {
      try {
        await stopMusic(expectedGeneration);
        ensureActive(expectedGeneration);
        lastError = null;
      } catch {
        const error = new ObsControllerError('Could not fully stop music in OBS. Use the OBS audio mixer and media controls.');
        if (generation === expectedGeneration) lastError = error.message;
        throw error;
      }
    }
    return status();
  }

  return { status, connect, disconnect, execute, stop };
}
