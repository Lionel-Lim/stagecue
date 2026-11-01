// Original streaming mono resampler. The server expects signed PCM16 at 24 kHz.
// Keeping fractional position across render blocks avoids gaps and clock drift.
class PCM24Processor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 24000;
    this.samples = [];
    this.position = 0;
    this.buffer = new Int16Array(2400);
    this.offset = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length || !channels[0]?.length) return true;
    const length = channels[0].length;
    for (let i = 0; i < length; i++) {
      let value = 0;
      for (let c = 0; c < channels.length; c++) value += channels[c][i] || 0;
      this.samples.push(value / channels.length);
    }
    while (this.position + 1 < this.samples.length) {
      const index = Math.floor(this.position);
      const fraction = this.position - index;
      const value = Math.max(-1, Math.min(1, this.samples[index] * (1 - fraction) + this.samples[index + 1] * fraction));
      this.buffer[this.offset++] = value < 0 ? Math.round(value * 32768) : Math.round(value * 32767);
      this.position += this.ratio;
      if (this.offset === this.buffer.length) {
        this.port.postMessage(this.buffer.buffer, [this.buffer.buffer]);
        this.buffer = new Int16Array(2400);
        this.offset = 0;
      }
    }
    const consumed = Math.floor(this.position);
    if (consumed > 0) {
      this.samples.splice(0, consumed);
      this.position -= consumed;
    }
    return true;
  }
}
registerProcessor('pcm-24-processor', PCM24Processor);
