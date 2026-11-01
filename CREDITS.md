# Credits and provenance

StageCue's application code, interface, tests, and documentation were created during the London DevDay Exchange Community Hackathon on **1 November 2026**, with the builder directing Codex. The repository began empty. No pre-existing application, starter template, component kit, stock imagery, or recorded music was imported.

## Original work

- The local Node server, cue state machine, Decisions integration, OBS adapter, browser desk, and PCM audio worklet were written for StageCue.
- The interface uses original CSS, inline vector shapes, Unicode marks, and system fonts. No external font or icon library is loaded.
- The browser's rehearsal beat is synthesized by the original Web Audio code in `public/app.js`.
- `public/assets/stagecue-beat.wav` is an original synthesized demo beat generated for this project, not a sampled commercial track.
- The fixed Slides and Demo pages are original demo assets. User-supplied slide decks, captured apps, and replacement music need their own credits if included in a submission.

## Existing software and services

| Dependency | Use | Upstream credit |
| --- | --- | --- |
| Node.js | Local HTTP server, file access, test runner | [Node.js project and license](https://github.com/nodejs/node/blob/main/LICENSE) |
| `obs-websocket-js` 5.0.8 | Authenticated OBS WebSocket v5 client | Brendan Hagan and OBS Websocket Community; [MIT license](https://github.com/obs-websocket-community-projects/obs-websocket-js/blob/master/LICENSE.md) |
| `ws` | Browser/server audio WebSocket bridge | Einar Otto Stangvik, Arnout Kazemier, Luigi Pinca, and contributors; [MIT license](https://github.com/websockets/ws/blob/master/LICENSE) |
| OBS Studio / obs-websocket | External AV scene and media control | [OBS Project](https://obsproject.com/), [OBS license](https://github.com/obsproject/obs-studio/blob/master/COPYING), [protocol](https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md) |
| OpenAI API | Speech transcription and typed cue classification | [OpenAI developer documentation](https://developers.openai.com/) |
| Codex | Development assistance, research, implementation, and tests | [Codex documentation](https://developers.openai.com/codex), [quickstart](https://developers.openai.com/codex/quickstart) |

The lockfile records the resolved dependency tree. Its transitive packages are [@msgpack/msgpack](https://github.com/msgpack/msgpack-javascript) (ISC), [crypto-js](https://github.com/brix/crypto-js) (MIT), [debug](https://github.com/debug-js/debug) (MIT), [eventemitter3](https://github.com/primus/eventemitter3) (MIT), [isomorphic-ws](https://github.com/heineiuo/isomorphic-ws) (MIT), [ms](https://github.com/vercel/ms) (MIT), and [type-fest](https://github.com/sindresorhus/type-fest) (MIT or CC0-1.0). Their upstream licenses are distributed with their installed packages. No OBS binary or third-party library source is vendored here.

## Documentation used

Implementation was checked against current primary documentation on 1 November 2026:

- [Decisions guide](https://developers.openai.com/api/docs/guides/decisions) and [create-decision API reference](https://developers.openai.com/api/reference/resources/decisions/methods/create): fixed choice requests and typed answers.
- [Realtime transcription guide](https://developers.openai.com/api/docs/guides/realtime-transcription): transcription sessions, PCM input, application-side turn commits, and transcript completion events.
- [OBS WebSocket JavaScript client](https://github.com/obs-websocket-community-projects/obs-websocket-js) and [OBS v5 protocol](https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md): authentication, scene switching, input mute, and media restart.

These sources informed new integration code. No Cookbook example or external UI template was copied into the app.

## How Codex helped

Codex split the build into the control desk, Decisions integration, and OBS adapter while the main task assembled the server and cue engine. It inspected current APIs and wrote automated regression tests around the risky handoff from a delayed decision to a live action.

A concrete example is the test **“stop cancels an in-flight restart before unmute and drops queued cues”** in `test/obs.test.mjs`. It pauses a fake OBS restart, invokes Stop, resumes the restart, and verifies that neither unmute nor a queued scene change is sent. Engine tests also exercise cancelled decisions and stale confirmation IDs. These are development contributions; Codex itself is not an autonomous runtime controller inside StageCue.
