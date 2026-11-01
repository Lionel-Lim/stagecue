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

## Still required on the demo machine

- Real OpenAI key access to `gpt-6-luna` Decisions and `gpt-live-transcribe`.
- Microphone permissions, speech recognition in the room, actual end-of-speech latency, and false-positive testing.
- OBS scene switching, media restart/mute, and physical audio routing.
- A full live rehearsal with the same microphone, network, and output used on stage.

Use Ask first for these checks. The prerecorded rehearsal walkthrough demonstrates the local control flow; it must not be presented as evidence of live AI or OBS integration.
