# StageCue

**Say the cue. Set the scene. Stay in the moment.**

StageCue is a local control desk for presenters and event hosts. Say “So, let's see the demo” to switch an OBS scene, or “Hey Codex, drop the beat” to start a configured music source. **Ask first** proposes a cue for confirmation; **Auto** executes a sufficiently confident cue while the desk is armed.

Built during the DevDay Exchange Community Hackathon in London, 1 November 2026. The core journey is deliberately small: **presenter → cue → decision → confirmation or auto → slides, demo, or music**. Webcam gestures and arbitrary AV commands are outside this version.

[Watch the 35-second offline rehearsal](docs/stagecue-rehearsal.mp4). This silent walkthrough uses typed phrase matching and simulated output; it does not claim live AI or OBS operation.

## Run locally

Requires Node.js **22.14 or newer** and npm. Use a current Chrome or Edge browser for microphone capture.

```sh
npm install
cp .env.example .env
npm start
```

Open [the control desk](http://localhost:3210) and optionally [the stage display](http://localhost:3210/stage.html). No key or OBS installation is needed for a typed rehearsal. These are local addresses, not public demo links.

1. Keep **CUE ENGINE → Rehearsal · cue matching**, **OUTPUT → Rehearsal stage**, and **Ask first**.
2. Click **Arm the desk**. Enter `So let's see the demo` and choose **Confirm cue**.
3. Select **Auto** and enter `Hey Codex, drop the beat`. The browser plays a small synthesized beat.
4. Enter `Don't play the music` to exercise an ignored cue. Use **Stop & disarm** or Escape to clear pending work and stop music.

The stage display is visual only; rehearsal sound plays in the control desk browser. Clicking the desk controls enables browser audio. If sound is blocked, click a control and check the browser's site audio setting.

## Enable OpenAI decisions and voice

Set `OPENAI_API_KEY` in `.env`, then restart the server. Secrets are configured only in `.env`; the UI never asks for a key or OBS password. `.env` is ignored by Git.

Choose **CUE ENGINE → OpenAI Decisions**, keep **OUTPUT → Rehearsal stage** for the first test, and arm the desk. Try a typed cue first. Then click the microphone icon, allow microphone access, speak one cue, and pause. Clicking the icon again stops capture.

The server sends text to the native [Decisions API](https://developers.openai.com/api/docs/guides/decisions), using `gpt-6-luna` to choose `slides`, `demo`, `music_on`, `music_off`, or `none`. It interprets meaning and context, rather than matching keywords. Each decision receives the current utterance, up to four earlier utterances from the last 45 seconds, and the current scene/music state. Earlier speech is explicitly labelled as background JSON, separate from the new utterance, so previous cues are not treated as new requests. The prompt recognizes polite requests and present-tense desires such as “Can you drop my beat?” and “I want to go back to the slide.” OBS state comes from the connected adapter; unavailable state is marked unknown. The model never receives an unrestricted OBS command interface or sees the slides, camera, or screen.

Try two separate typed cues within 45 seconds: `I have built a working application. Next I will demonstrate it to you.` (no action), followed by `Let us try it now` (a contextual demo cue). Use **Ask first** and review the proposal. Context supplies references, not permission to replay an older command. Stop, re-arming, settings changes, dismissal and manual controls clear conversation context. The activity log remains visible.

Voice uses [realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription), followed by the same contextual decision path:

- **Live · faster** uses `gpt-live-transcribe`, with medium transcription delay for additional audio context.
- **Full phrase · try in noisy rooms** uses `gpt-transcribe` after a complete audio turn and waits at least 700 ms for a pause. This is an accuracy-oriented alternative, not a guarantee of noise immunity, and can add latency.
- **Finish phrase** explicitly commits the current audio when background noise prevents pause detection. It does not stop listening; click the microphone or Stop to end capture.

Both modes request browser echo cancellation/noise suppression, provide English language and technology-event context, and hint product names (StageCue, Codex, OBS, DevDay). Browser audio processing varies. In a crowded room, test a close microphone or headset; these models do not identify the presenter or separate them reliably from nearby speakers. Changing speech mode closes the existing microphone session; click the mic again to use it.

Browser audio is resampled to mono PCM16 at 24 kHz. A simple RMS detector on the local server commits speech after a pause: Live defaults are `VAD_THRESHOLD=0.018` and `VAD_SILENCE_MS=400`; Full phrase enforces a minimum 700 ms pause. Tune these with the actual microphone and room. The displayed **Decision** time measures text classification; it excludes speech capture, silence detection, transcription, and confirmation. No end-to-end latency guarantee is made.

## Connect OBS

1. Open OBS Studio and enable its WebSocket server in **Tools → WebSocket Server Settings**, using port **4455** and authentication. Put the password in `OBS_PASSWORD` in `.env`. The default address is `OBS_URL=ws://127.0.0.1:4455`.
2. Create a **Slides** scene capturing the presentation window and a **Demo** scene capturing the application window. Grant OBS screen-recording permission if the operating system requires it. Scene names can be changed with `OBS_SCENE_SLIDES` and `OBS_SCENE_DEMO`.
3. For a quick visual setup, use OBS Browser Sources pointed to [Slides asset](http://localhost:3210/stage.html?scene=slides) and [Demo asset](http://localhost:3210/stage.html?scene=demo). Set each source to 1920 × 1080. These are supplied demo visuals; replace them with real window captures for a presentation.
4. Add a Media Source named **Beat** with `public/assets/stagecue-beat.wav`, enable looping, and initially mute it. Add that **existing source** to both scenes so it remains active across transitions. `OBS_MUSIC_INPUT` changes its name. Configure OBS monitoring/output with the AV host so the intended speakers actually receive its audio.
5. Restart StageCue after editing `.env`. Select **OUTPUT → OBS Studio**, click **Connect OBS**, check configuration warnings, and arm in **Ask first**. Connection itself only reads OBS state. Confirm a test cue on your own setup before using Auto.

StageCue switches the program scene and restarts/unmutes or stops/mutes the named media input. Both **Stop the music** and **Stop & disarm** send a media-stop command as well as mixer mute; muting alone does not stop playback. It does not configure a projector, venue mixer, streaming destination, or recording. External AV routing remains host-managed. The in-app visual is a scene guide, not an OBS video feed; verify actual output in OBS.

## Debug a cue

Expand **Debug inspector** below the input/output panels, then speak or type a cue. **Follow latest** tracks new input; select an older trace to inspect it without new speech changing your selection.

1. **Input / transcript** shows typed input or microphone partial/final text, the transcription model, and whether the turn is capturing, transcribing, finished, or failed. Only accepted final transcripts go to Decisions.
2. **Context sent** shows the recent utterances and mapped stage state included in that particular request.
3. **Decision output** shows the selected action, model confidence, and all five option probabilities. These are the validated API fields, not a generated explanation of the model's reasoning. Rehearsal is explicitly labelled as a deterministic phrase match.
4. **App action** explains the local rule: ignored, waiting for confirmation, expired, cancelled, dispatching, executed, or failed. For example, a model's `music_on` at 39% is displayed separately from the app's decision to ignore it below 60%.

The top bar reports transcription connection state and the server's RMS level versus its speech gate. A level that stays above the gate can prevent pause detection; use Finish phrase to test that case. Timing separates audio duration, transcription after commit, Decisions and dispatch. Request-body JSON and the validated response/trace are expandable; authentication headers, API keys, OBS passwords and raw audio are not recorded.

The inspector holds at most 20 traces in server memory. **Clear debug** clears these traces without changing the stage, pending confirmation, activity history or conversation context. Stop resets conversation context as before. Collapse the inspector for the demo, since it displays the text you spoke. No diagnostic files are saved automatically.

## Know which path is running

| Cue engine | Output | What is demonstrated |
| --- | --- | --- |
| Rehearsal · cue matching | Rehearsal stage | Offline phrase matching and simulated output |
| OpenAI Decisions | Rehearsal stage | Real AI classification with simulated output |
| Rehearsal · cue matching | OBS Studio | Real OBS control with offline phrase matching |
| OpenAI Decisions | OBS Studio | Full live integration; microphone additionally requires transcription access |

Rehearsal recognizes a small exact phrase list, including the example chips. It is not an AI fallback disguised as a successful live request. API failures are shown without dispatching a cue.

## Control and data boundaries

- The desk starts disarmed. Proposals expire after 15 seconds. Stop clears proposals and cancels pending decisions; if OBS disconnects, use its mixer directly to mute audio.
- Auto uses a heuristic confidence threshold of 0.85; 0.60–0.85 asks for confirmation and lower confidence is ignored. These thresholds are **not calibrated** against a live-event dataset. Use Ask first until tested in the room.
- The local server binds to `127.0.0.1` and checks the request host/origin. Keep it local; it has no multi-user login system.
- Live microphone audio, cue text, recent conversation context and mapped stage state are sent to OpenAI. Rehearsal text stays local. StageCue keeps recent cue history in server memory and does not write recordings or transcripts to disk. Use non-personal sample content in recordings.

## Verify and demo

```sh
npm test
npm run check
```

Once the key is configured, `npm run verify:live` sends 15 labelled cues to the real Decisions API and reports accuracy plus median/p95 decision latency. It includes paraphrases, negations, future plans, quoted cues, and ambiguous multi-action requests. `npm run verify:live -- --context` checks eight contextual examples, including pronouns, absent/ambiguous references and stale commands. Each result also shows how the confidence policy would route it; a correct action below 0.60 still gets ignored. These checks use API credits and exclude microphone/OBS timing.

`npm run verify:live -- --reported` replays 12 examples covering reported room-test failures, their original context, additional paraphrases, and negative cases. The activity log shows model confidence and distinguishes a `none` selection from a cue rejected below the proposal threshold. Ambiguous transcription such as “Drum my beat” is not silently rewritten into a command.

Tests use fake API and OBS clients to cover allowlisted actions, invalid decisions, context expiry/reset, cancellation, stale confirmations, unavailable scenes, and muting during a pending music restart. They do not establish microphone accuracy or real OBS/audio operation. **Room microphone quality and the complete OBS journey still need to be checked on the demo setup.**

[The 80-second demo script and submission checklist](docs/DEMO.md) include those checks. [Credits](CREDITS.md) identify dependencies, original assets, and the concrete Codex contribution. Codex helped build and test StageCue; the runtime uses the OpenAI transcription and Decisions APIs plus OBS WebSocket.

See the [verification record](docs/VERIFICATION.md) for what has actually been exercised.
