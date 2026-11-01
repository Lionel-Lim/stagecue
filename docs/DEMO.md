# StageCue demo and submission

Target an **80-second recording**, with a hard maximum of **90 seconds**. Show one complete journey: a presenter gives a cue, the desk interprets it, and the intended stage output changes. Keep the cue-engine and output labels visible so viewers can distinguish live integration from rehearsal.

## Before recording

1. Run `npm test` and `npm run check`. Start StageCue, close unrelated tabs, hide notifications, and use sample slides/app content without personal data.
2. For a live demo, add the API key and OBS password to `.env` off-camera, restart, connect OBS, and test a typed OpenAI cue before enabling the microphone. Do not film `.env`, the OBS password dialog, terminal history containing secrets, or account pages.
3. Check the real OBS program output and audio destination. Set up Slides, Demo, and the same Beat media source in both scenes as described in the README. An OBS acknowledgement does not prove the room can hear the beat.
4. In a separate rehearsal, test every spoken phrase below using the actual microphone. Tune silence detection if phrases split or never complete. Confirm that Stop mutes the real source. Use headphones or low monitoring volume to reduce feedback.
5. Arrange the desk beside OBS's program preview. For simulated output, use the desk's stage preview or `/stage.html`. Reset to Slides, music off, **Ask first**, and disarmed.

If voice access or audio capture fails, demonstrate typed cues and say so. If the AI or OBS connection is unavailable, select the appropriate rehearsal option and label the recording accordingly. Never describe phrase matching or the schematic preview as proof of a live model or OBS feed.

## 80-second script

| Time | What to show | What to say or do |
| --- | --- | --- |
| 0–9 s | Desk and actual program output; engine/output labels visible | “Presenters keep asking someone backstage to change the screen or start music. StageCue gives them four useful controls in their own voice.” |
| 9–15 s | Arm the desk; microphone on for a verified voice demo | “This is [OpenAI Decisions with OBS / explicitly name the rehearsal path]. I'll start in Ask first.” |
| 15–29 s | Say or type the exact cue; show pending card, then confirm | **“So let's see the demo.”** Pause. “It proposes Demo. I confirm, and the scene changes.” Click **Confirm cue**; show the real switch. |
| 29–43 s | Select Auto, then cue music | “Now Auto.” **“Hey Codex, drop the beat.”** Pause; let the beat be audible for a few seconds. Keep the activity entry and output visible. |
| 43–53 s | Test a negative cue | **“Don't play the music.”** Pause. “A negated instruction is ignored; it doesn't start another action.” Show the ignored entry. |
| 53–65 s | Transition back and stop | **“Back to the slides.”** Pause for the switch. Click **Stop & disarm** or press Escape. “Stop clears pending cues and mutes the music.” |
| 65–76 s | Briefly show relevant test file or test output, with no secrets | “Codex helped build this and test a subtle failure: Stop during an unfinished music restart must prevent a later unmute or queued scene change.” |
| 76–80 s | Return to desk or repository page | “One presenter, one clear cue, and the stage follows.” |

Do not narrate cue phrases before their intended execution while the microphone is listening. Turn the microphone off during explanatory commentary if it could be mistaken for a cue. Decision timing in the UI covers classification only; report measured voice-to-output latency separately if you measure it.

## London-time delivery plan

The [event schedule](https://luma.com/dde-ldn-hack) lists building from **11:00** and submissions closing at **17:00**. Teams have at most four people. Keep the core build and its provenance within the hackathon.

| By | Deliverable |
| --- | --- |
| 14:00 | Typed Ask/Auto journey stable, tests passing, OBS scenes configured |
| 15:00 | One real OpenAI cue and one real OBS switch verified; microphone tested |
| 15:30 | Repeat the full journey; decide honestly which live/rehearsal path to record |
| 16:00 | Feature freeze; protect the final hour for recording and submission |
| 16:20 | Record and trim to 75–85 seconds; verify exported picture and audio |
| 16:40 | Public GitHub repository, README/setup, credits, and accessible video link ready |
| 16:50 | Open repo and video links signed out; submit with ten minutes of margin |

Deadline risks are microphone permissions, noisy-room turn detection, API/model access, OBS screen-capture permission, and audio routing. Keep typed cues available, use the fixed local scene assets when window capture takes too long, and cut gestures or additional actions before cutting demo time.

## Submission checklist

- [ ] All local tests/checks pass; exact commit to submit is identified.
- [ ] Live OpenAI decision observed, or AI rehearsal explicitly disclosed.
- [ ] Real microphone-to-cue flow observed, or typed input explicitly disclosed.
- [ ] Real OBS program switch and audible Beat start/stop observed, or simulated output explicitly disclosed.
- [ ] Public repository includes source, lockfile, README, `.env.example`, and credits; excludes `.env`, recordings containing secrets, private logs, and `node_modules`.
- [ ] Demo video plays with sound, is no longer than 90 seconds, and shows the complete core journey.
- [ ] Repository and video links open in a signed-out/private browser without a permission request. A localhost address is not a public demo link.
- [ ] Submission includes a concrete Codex contribution, credited third-party materials, team details, and the actual links.

This checklist records work still to verify; it is not a claim that a public repo, uploaded video, live API call, or live AV test already exists.
