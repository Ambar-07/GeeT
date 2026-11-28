import { describe, expect, it } from "vitest";
import {
  buildHallImpulse,
  clampMicGain,
  clampReverbMix,
  computeDuetPeerVolume,
  downsampleToInt16,
  int16ToFloat32,
  tuneLowLatencyOpusSdp,
} from "./liveMic";

describe("liveMic helpers", () => {
  it("clamps mic gain and reverb mix safely", () => {
    expect(clampMicGain(-0.5)).toBe(0);
    expect(clampMicGain(2.4)).toBe(2.0);
    expect(clampMicGain(Number.NaN)).toBe(1.0);
    expect(clampReverbMix(-1)).toBe(0);
    expect(clampReverbMix(1.8)).toBe(1);
    expect(clampReverbMix(Number.NaN)).toBe(0.25);
  });

  it("builds a decaying stereo hall impulse response", () => {
    const channels = [new Float32Array(4800), new Float32Array(4800)];
    const fakeCtx = {
      sampleRate: 4800,
      createBuffer: (_ch: number, len: number) => ({
        length: len,
        getChannelData: (idx: number) => channels[idx],
      }),
    } as unknown as AudioContext;

    const buf = buildHallImpulse(fakeCtx, 1.0, 2.8);
    expect(buf.length).toBe(4800);
    const startEnergy = channels[0].slice(0, 400).reduce((a, v) => a + Math.abs(v), 0);
    const tailEnergy = channels[0].slice(4400).reduce((a, v) => a + Math.abs(v), 0);
    expect(startEnergy).toBeGreaterThan(tailEnergy * 10);
  });

  it("downsamples and decodes Int16 PCM chunks cleanly", () => {
    const input = new Float32Array(480);
    for (let i = 0; i < input.length; i++) input[i] = Math.sin((i / 480) * Math.PI * 2) * 0.8;
    const pcm = downsampleToInt16(input, 48000, 16000);
    const decoded = int16ToFloat32(pcm);
    expect(decoded.length).toBe(160);
    expect(Math.max(...decoded)).toBeGreaterThan(0.7);
    expect(Math.min(...decoded)).toBeLessThan(-0.7);
  });

  it("tunes Opus SDP for 10ms low-latency mono frames", () => {
    const sampleSdp = [
      "v=0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=rtpmap:111 opus/48000/2",
      "a=fmtp:111 minptime=20;useinbandfec=1",
    ].join("\r\n");
    const tuned = tuneLowLatencyOpusSdp(sampleSdp);
    expect(tuned).toContain("a=fmtp:111 minptime=10;ptime=10;useinbandfec=0;stereo=0");
    expect(tuned).toContain("a=ptime:10");
    expect(tuned).toContain("a=maxptime:20");
  });

  it("scales per-peer volume smoothly for solo vs duet singers", () => {
    expect(computeDuetPeerVolume(1.0, 1)).toBe(1.0);
    expect(computeDuetPeerVolume(1.0, 2)).toBeCloseTo(0.85, 2);
    expect(computeDuetPeerVolume(1.0, 4)).toBeCloseTo(0.5, 2);
  });
});
