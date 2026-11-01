# Verification record

This record separates tested behavior from integration that requires the presenter's setup.

## 1 November 2026 — local build

- Node 22.14 installed dependencies from the lockfile; the installation audit reported zero known vulnerabilities.
- Automated tests exercise the native Decisions request format using a fake HTTP service, OBS requests using fake clients, the local HTTP journey, cancellation, stale confirmations, and PCM speech-turn detection.
- All 84 automated tests passed, including connection deadlines, out-of-order transcription, and a late unmute after Stop. Syntax checks passed.
- Browser rehearsal exercised Ask → confirm → Demo, Auto → beat, negated speech → no scene change, and Stop → disarmed with rehearsal audio off.
- Desktop and 390 × 844 layouts checked; the Stop control stays visible and no horizontal overflow was observed. Browser console reported no errors or warnings during the rehearsal.
- Rehearsal output is explicitly labelled; no model/network latency is inferred from its near-zero decision time.
- `.env` is ignored, static file routing cannot serve it, and the HTTP API rejects foreign origins and invalid host headers.
- The [silent rehearsal walkthrough](stagecue-rehearsal.mp4) is 34.64 seconds, measured with ffprobe.

## 1 November 2026 — contextual cues and speech options

- All 92 automated tests passed after adding bounded conversation context, context reset/expiry, Full phrase transcription configuration and explicit audio-turn completion. Syntax and whitespace checks passed.
- Decisions receives chronological presenter messages (up to four previous utterances within 45 seconds) and mapped current stage state. The latest message is evaluated as the new cue.
- The latest direct-cue evaluation matched 14/15 model labels; one combined music/demo request selected music at 0.75 confidence, requiring confirmation rather than executing in Auto. A correctly classified slides cue was below the 0.60 threshold and would be ignored. Including confidence routing, 13/15 examples behaved as expected.
- The latest context evaluation matched 7/8 model labels. The application introduction followed by “Let us try it now” selected Demo at 0.99 confidence. Without an introduction, the same phrase incorrectly proposed Demo at 0.76; a backing-track reference selected music at only 0.39 and would be ignored. Including confidence routing, 6/8 examples behaved as expected. These are known limitations, not passing model evaluations.
- The latest completed direct requests had median 299 ms / p95 1116 ms; contextual requests had median 473 ms / p95 775 ms. Earlier runs had repeated four-second timeouts, and one diagnostic request took about ten seconds. These measurements exclude speech, OBS and confirmation, and do not establish a consistent latency guarantee.
- Real transcription session setup was accepted for `gpt-live-transcribe` and for the new `gpt-transcribe` Full phrase option. The latter check sent no microphone audio; it establishes configuration/account access, not room transcription quality.
- The presenter reported poor recognition using the laptop microphone in the event room. Full phrase mode, a longer pause, vocabulary/context hints, and Finish phrase are available for retesting. Noise improvement is not yet verified.
- Desktop and 390-pixel mobile layouts include the speech selector and Finish phrase control. No horizontal overflow was observed. The microphone controls remain inactive while disarmed.
- The final browser journey used real Decisions and simulated output: an application introduction left the scene unchanged; “Let us try it now” proposed Demo (354 ms decision); Confirm switched to Demo; Stop returned the desk to standby. This verifies the typed contextual journey, not microphone accuracy or OBS output.

Use Ask first for room tests. Confidence thresholds remain heuristic; the live evaluation scripts now report both label accuracy and the effect of the proposal threshold, and exit unsuccessfully when either misses an expected result.

## 1 November 2026 — debug inspector

- All 105 automated tests passed, including correlated speech/decision trace IDs, partial/final text, bounded storage, safe answer-field selection, confidence routing, expiry, queued/in-flight cancellation, and clearing diagnostics without cancelling an action. Syntax and whitespace checks passed.
- The browser exercised rehearsal input → proposal → confirmation → simulated dispatch, then one real Decisions request. The inspector displayed the typed cue, request body, `demo` choice, 99% confidence and all five option probabilities. The unconfirmed live proposal expired and correctly remained “no action sent.”
- Trace selection stayed fixed when Follow latest was off. Literal HTML-like input rendered as text. Clear debug removed the traces without changing the stage.
- Speech partial/final rendering, RMS/gate information and the low-confidence explanation were checked with an isolated, explicitly labelled synthetic browser fixture. This did not capture microphone audio and does not establish real-room recognition quality.
- Request logging includes only the body. Validated response logging strips unknown upstream fields; no configured keys/passwords or raw audio are included. Debug data is kept in memory only.

## 1 November 2026 — reported natural-language cue fixes

- The saved room-test traces showed two distinct failures: “Okay, I want to go back to the slide.” selected `none` at 90% confidence; “Can you drop my beat?” selected `music_on` at 50%, below the unchanged 60% proposal threshold. Replaying the original context reproduced both failures.
- The prompt now distinguishes polite requests and present desires from negation, future plans, descriptions and combined requests. Previous utterances are explicitly labelled as background JSON, separate from the latest text message. There are no keyword overrides in OpenAI mode.
- The final live evaluation passed all 35 labelled cases and proposal-policy checks: 12 reported/paraphrase cases, eight contextual cases, and 15 original direct/negative cases. The reported slides request selected `slides` at 100% confidence; the music request selected `music_on` at 94%. Both exceed the unchanged 85% Auto threshold. Other valid examples still required confirmation below 85%.
- Completed decision latency: reported set median 334 ms / p95 752 ms; context set median 386 ms / p95 670 ms; direct set median 398 ms / p95 996 ms. This is one small prompt-development evaluation, not an independent accuracy benchmark or latency guarantee; speech and OBS latency are excluded.
- Activity now shows confidence and the actual reason a cue was ignored, separating model `none` from low confidence. “Drum my beat” remains an unclear/unsupported transcript and is not silently rewritten to “drop the beat.”
- All 105 automated tests passed, plus syntax and whitespace checks. A browser replay of the five reported utterances used real Decisions with rehearsal output: Demo executed, both unclear/filler phrases were ignored, music executed at 94%, and Slides executed at 99%. This verifies typed transcripts and simulated output, not a new microphone or OBS test.

## 1 November 2026 — OBS music-stop fix

- The presenter reported that OBS music started successfully but did not stop. The adapter sent only `SetInputMute`; it did not stop media playback. Both `music_off` and Stop now send mixer mute and `OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP` to the configured source. Each operation is attempted even if the other fails, and partial failure is reported instead of claiming success.
- All 107 automated tests passed, including the new stop requests, partial failures, repeated Stop, cancellation of an in-flight restart, and protection against late unmute acknowledgements. Syntax and whitespace checks passed.
- A direct check against the presenter's OBS instance moved the configured Beat media source from paused to `OBS_MEDIA_STATE_STOPPED`, with mute enabled, and verified it stayed stopped for two seconds. Monitoring settings were left unchanged. The presenter still needs to confirm the audible result and the full voice → OBS journey after the server restart; the earlier diagnostic did not establish audible success.
- After restarting the app, its manual `music_off` and `/api/stop` paths both completed against OBS. A separate read confirmed media stopped, mute enabled, and Monitor and Output still selected. The desk was left disarmed with OpenAI/Auto/OBS settings and the OBS connection restored.
- The presenter then retested manual Beat on → Beat off and confirmed that the audible music stopped. This establishes the manual OBS audio journey; voice-triggered stopping still requires a recognized/accepted cue.

## Still required on the demo machine

- Microphone permissions, speech recognition in the room, actual end-of-speech latency, and false-positive testing.
- OBS scene switching, media restart/mute, and physical audio routing.
- A full live rehearsal with the same microphone, network, and output used on stage.

Use Ask first for these checks. The prerecorded rehearsal walkthrough demonstrates the local control flow; it must not be presented as evidence of live AI or OBS integration.
