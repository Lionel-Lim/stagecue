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

The server sends text to the native [Decisions API](https://developers.openai.com/api/docs/guides/decisions), using `gpt-6-luna` to choose `slides`, `demo`, `music_on`, `music_off`, or `none`. The model never receives an unrestricted OBS command interface. Voice uses [realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription) with `gpt-live-transcribe`, followed by the same decision path.

Browser audio is resampled to mono PCM16 at 24 kHz. A simple RMS detector on the local server commits speech after a pause: defaults are `VAD_THRESHOLD=0.018` and `VAD_SILENCE_MS=400`. Tune these with the actual microphone and room. The displayed **Decision** time measures text classification; it excludes speech capture, silence detection, transcription, and confirmation. No end-to-end latency guarantee is made.

## Connect OBS

1. Open OBS Studio and enable its WebSocket server in **Tools → WebSocket Server Settings**, using port **4455** and authentication. Put the password in `OBS_PASSWORD` in `.env`. The default address is `OBS_URL=ws://127.0.0.1:4455`.
2. Create a **Slides** scene capturing the presentation window and a **Demo** scene capturing the application window. Grant OBS screen-recording permission if the operating system requires it. Scene names can be changed with `OBS_SCENE_SLIDES` and `OBS_SCENE_DEMO`.
3. For a quick visual setup, use OBS Browser Sources pointed to [Slides asset](http://localhost:3210/stage.html?scene=slides) and [Demo asset](http://localhost:3210/stage.html?scene=demo). Set each source to 1920 × 1080. These are supplied demo visuals; replace them with real window captures for a presentation.
4. Add a Media Source named **Beat** with `public/assets/stagecue-beat.wav`, enable looping, and initially mute it. Add that **existing source** to both scenes so it remains active across transitions. `OBS_MUSIC_INPUT` changes its name. Configure OBS monitoring/output with the AV host so the intended speakers actually receive its audio.
5. Restart StageCue after editing `.env`. Select **OUTPUT → OBS Studio**, click **Connect OBS**, check configuration warnings, and arm in **Ask first**. Connection itself only reads OBS state. Confirm a test cue on your own setup before using Auto.

StageCue switches the program scene and restarts/unmutes or mutes the named media input. It does not configure a projector, venue mixer, streaming destination, or recording. External AV routing remains host-managed. The in-app visual is a scene guide, not an OBS video feed; verify actual output in OBS.

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
- Live microphone audio and cue text are sent to OpenAI. Rehearsal text stays local. StageCue keeps recent cue history in server memory and does not write recordings or transcripts to disk. Use non-personal sample content in recordings.

## Verify and demo

```sh
npm test
npm run check
```

Once the key is configured, `npm run verify:live` sends 15 labelled cues to the real Decisions API and reports accuracy plus median/p95 decision latency. It includes paraphrases, negations, future plans, quoted cues, and ambiguous multi-action requests. This uses API credits and excludes microphone/OBS timing.

Tests use fake API and OBS clients to cover allowlisted actions, invalid decisions, cancellation, stale confirmations, unavailable scenes, and muting during a pending music restart. They do not establish microphone accuracy, account API access, or real OBS/audio operation. **Live API, microphone, and OBS checks still need to be run on the demo setup.**

[The 80-second demo script and submission checklist](docs/DEMO.md) include those checks. [Credits](CREDITS.md) identify dependencies, original assets, and the concrete Codex contribution. Codex helped build and test StageCue; the runtime uses the OpenAI transcription and Decisions APIs plus OBS WebSocket.

See the [verification record](docs/VERIFICATION.md) for what has actually been exercised.
