import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurnDetector } from '../src/audio.mjs';

// Mono signed little-endian PCM at 24 kHz: 48 bytes represent one millisecond.
function pcm(milliseconds, amplitude = 0) {
  const buffer = Buffer.alloc(milliseconds * 48);
  const level = Math.round(amplitude * 32767);
  for (let index = 0; index < buffer.length; index += 2) {
    buffer.writeInt16LE((index / 2) % 2 ? -level : level, index);
  }
  return buffer;
}

function capture(options = {}) {
  const segments = [];
  const committed = [];
  let current = [];
  const detector = createTurnDetector({
    ...options,
    append: buffer => { segments.push(buffer); current.push(buffer); },
    commit: () => { committed.push(Buffer.concat(current)); current = []; },
  });
  return { detector, segments, committed };
}

test('silence and quiet room noise stay local instead of appending or committing', () => {
  const { detector, segments, committed } = capture();
  for (let index = 0; index < 500; index++) detector.push(pcm(20, index % 2 ? 0.01 : 0));
  assert.equal(segments.length, 0);
  assert.equal(committed.length, 0);
});

test('RMS detects alternating positive and negative samples as speech', () => {
  const { detector, segments, committed } = capture();
  const speech = pcm(20, 0.1);
  detector.push(speech);
  assert.equal(segments.length, 1);
  assert.strictEqual(segments[0], speech);
  assert.equal(committed.length, 0);
});

test('speech includes recent pre-roll in order and bounds it to 300 ms for normal frames', () => {
  const { detector, segments, committed } = capture();
  const quietFrames = Array.from({ length: 20 }, (_value, index) => pcm(20, index / 2_000));
  for (const buffer of quietFrames) detector.push(buffer);
  const speech = pcm(20, 0.2);
  detector.push(speech);
  assert.equal(segments.length, 15);
  assert.deepEqual(segments.slice(0, -1), quietFrames.slice(-14));
  assert.strictEqual(segments.at(-1), speech);
  assert.equal(Buffer.concat(segments).length, 300 * 48);
  assert.equal(committed.length, 0);
});

test('400 ms of silence commits exactly once and the tail remains in the audio', () => {
  const { detector, segments, committed } = capture();
  detector.push(pcm(20, 0.2));
  for (let index = 0; index < 19; index++) detector.push(pcm(20));
  assert.equal(committed.length, 0, '380 ms must not end the turn');
  detector.push(pcm(20));
  assert.equal(committed.length, 1);
  assert.equal(committed[0].length, 420 * 48);
  assert.equal(segments.length, 21);
  for (let index = 0; index < 40; index++) detector.push(pcm(20));
  assert.equal(committed.length, 1, 'continued silence must not create empty turns');
  assert.equal(segments.length, 21, 'continued silence must stay in pre-roll');
});

test('renewed speech resets the silence duration instead of splitting a sentence', () => {
  const { detector, committed } = capture();
  detector.push(pcm(20, 0.2));
  for (let index = 0; index < 15; index++) detector.push(pcm(20));
  detector.push(pcm(20, 0.2));
  for (let index = 0; index < 19; index++) detector.push(pcm(20));
  assert.equal(committed.length, 0);
  detector.push(pcm(20));
  assert.equal(committed.length, 1);
  assert.equal(committed[0].length, 740 * 48);
});

test('a later turn has its own audio and a bounded new pre-roll', () => {
  const { detector, committed } = capture();
  detector.push(pcm(20, 0.2));
  for (let index = 0; index < 20; index++) detector.push(pcm(20));
  const first = Buffer.from(committed[0]);
  for (let index = 0; index < 40; index++) detector.push(pcm(20));
  detector.push(pcm(20, 0.4));
  for (let index = 0; index < 20; index++) detector.push(pcm(20));
  assert.equal(committed.length, 2);
  assert.deepEqual(committed[0], first);
  assert.equal(committed[1].length, 700 * 48);
  assert.equal(committed[1].readInt16LE(280 * 48), Math.round(0.4 * 32767));
});

test('continuous speech is bounded to 12 seconds before a fresh turn starts', () => {
  const { detector, committed } = capture();
  for (let index = 0; index < 599; index++) detector.push(pcm(20, 0.2));
  assert.equal(committed.length, 0);
  detector.push(pcm(20, 0.2));
  assert.equal(committed.length, 1);
  assert.equal(committed[0].length, 12_000 * 48);
  detector.push(pcm(20, 0.3));
  for (let index = 0; index < 20; index++) detector.push(pcm(20));
  assert.equal(committed.length, 2);
  assert.equal(committed[1].length, 420 * 48);
});

test('empty and odd-length PCM frames are ignored without advancing the turn', () => {
  const { detector, segments, committed } = capture();
  const invalid = [null, undefined, [], new Uint8Array(960), Buffer.alloc(0), Buffer.alloc(1), Buffer.alloc(3), Buffer.alloc(961), Buffer.alloc(48_002)];
  for (const frame of invalid) assert.doesNotThrow(() => detector.push(frame));
  assert.equal(segments.length, 0);
  detector.push(pcm(20, 0.2));
  for (let index = 0; index < 19; index++) detector.push(pcm(20));
  for (const frame of invalid) detector.push(frame);
  assert.equal(committed.length, 0);
  detector.push(pcm(20));
  assert.equal(committed.length, 1);
  assert.equal(committed[0].length, 420 * 48);
});

test('invalid VAD settings fall back to the default threshold and 400 ms silence', () => {
  for (const value of [NaN, Infinity, -1, 0, 'invalid']) {
    const { detector, segments, committed } = capture({ threshold: value, silenceMs: value });
    detector.push(pcm(20, 0.01));
    assert.equal(segments.length, 0);
    detector.push(pcm(20, 0.03));
    for (let index = 0; index < 19; index++) detector.push(pcm(20));
    assert.equal(committed.length, 0);
    detector.push(pcm(20));
    assert.equal(committed.length, 1);
  }
});

test('configured threshold and silence interval control the gate and commit point', () => {
  const { detector, segments, committed } = capture({ threshold: 0.1, silenceMs: 200 });
  detector.push(pcm(20, 0.05));
  assert.equal(segments.length, 0);
  detector.push(pcm(20, 0.2));
  assert.equal(segments.length, 2);
  for (let index = 0; index < 9; index++) detector.push(pcm(20, 0.05));
  assert.equal(committed.length, 0);
  detector.push(pcm(20, 0.05));
  assert.equal(committed.length, 1);
  assert.equal(committed[0].length, 240 * 48);
});

test('silence duration follows PCM length rather than the number of messages', () => {
  const { detector, committed } = capture();
  detector.push(pcm(30, 0.2));
  detector.push(pcm(170));
  detector.push(pcm(229));
  assert.equal(committed.length, 0);
  detector.push(pcm(1));
  assert.equal(committed.length, 1);
  assert.equal(committed[0].length, 430 * 48);
});

test('an explicit finish commits noisy audio once without waiting for silence', () => {
  const { detector, committed } = capture({ silenceMs: 700 });
  detector.finish();
  detector.push(pcm(100, 0.2));
  detector.push(pcm(300, 0.1));
  assert.equal(committed.length, 0);
  detector.finish();
  assert.equal(committed.length, 1);
  assert.equal(committed[0].length, 400 * 48);
  detector.finish();
  assert.equal(committed.length, 1);
});

test('full phrase pause preserves a sentence with a 500ms hesitation', () => {
  const { detector, committed } = capture({ silenceMs: 700 });
  detector.push(pcm(100, 0.2));
  detector.push(pcm(500));
  assert.equal(committed.length, 0);
  detector.push(pcm(100, 0.2));
  detector.push(pcm(700));
  assert.equal(committed.length, 1);
  assert.equal(committed[0].length, 1400 * 48);
});
