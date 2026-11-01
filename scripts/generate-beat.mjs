// Original synthesized percussion for StageCue. No samples or recordings.
import { mkdir, writeFile } from 'node:fs/promises';
const rate = 48000, seconds = 8, count = rate * seconds;
const audio = new Float32Array(count);
let seed = 20261101;
const noise = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 2147483648 - 1; };
for (let beat = 0; beat < 16; beat++) {
  const offset = beat * rate / 2;
  for (let i = 0; i < rate / 2; i++) {
    const t = i / rate;
    if (beat % 4 === 0 || beat % 4 === 2) audio[offset + i] += Math.sin(2 * Math.PI * (48 * t + 1.5 * (1 - Math.exp(-35 * t)))) * Math.exp(-12 * t) * 0.4;
    if (beat % 4 === 1 || beat % 4 === 3) audio[offset + i] += (noise() * 0.7 + Math.sin(2 * Math.PI * 180 * t) * 0.3) * Math.exp(-22 * t) * 0.24;
    audio[offset + i] += noise() * Math.exp(-85 * t) * 0.12;
    if (i >= rate / 4) audio[offset + i] += noise() * Math.exp(-100 * (t - 0.25)) * 0.065;
  }
}
const wav = Buffer.alloc(44 + count * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(count * 2, 40);
for (let i = 0; i < count; i++) wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, audio[i])) * 32767), 44 + i * 2);
await mkdir(new URL('../public/assets/', import.meta.url), { recursive: true });
await writeFile(new URL('../public/assets/stagecue-beat.wav', import.meta.url), wav);
console.log('Generated original 8-second beat: public/assets/stagecue-beat.wav');
