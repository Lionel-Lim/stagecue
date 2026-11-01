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

## Still required on the demo machine

- Microphone permissions, speech recognition in the room, actual end-of-speech latency, and false-positive testing.
- OBS scene switching, media restart/mute, and physical audio routing.
- A full live rehearsal with the same microphone, network, and output used on stage.

Use Ask first for these checks. The prerecorded rehearsal walkthrough demonstrates the local control flow; it must not be presented as evidence of live AI or OBS integration.
