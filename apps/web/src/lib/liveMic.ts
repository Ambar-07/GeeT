import type { MicRtcSignal } from "./rooms";

/**
 * Lightweight Web Audio live microphone mixer with high-pass rumble cut,
 * synthesized stereo hall reverb, and safety compressor/limiter.
 */

export function clampMicGain(value: number): number {
  if (!Number.isFinite(value)) return 1.0;
  return Math.max(0, Math.min(2.0, value));
}

export function clampReverbMix(value: number): number {
  if (!Number.isFinite(value)) return 0.25;
  return Math.max(0, Math.min(1, value));
}

/** Synthesize a smooth stereo hall reverb impulse response without external WAV assets. */
export function buildHallImpulse(
  ctx: AudioContext,
  durationSec = 1.7,
  decay = 2.8
): AudioBuffer {
  const sampleRate = ctx.sampleRate || 48000;
  const length = Math.max(1, Math.floor(sampleRate * durationSec));
  const impulse = ctx.createBuffer(2, length, sampleRate);

  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < length; i++) {
      const env = Math.pow(1 - i / length, decay);
      // Gentle one-pole low-pass damps harsh metallic sibilance in the reverb tail
      const white = Math.random() * 2 - 1;
      lp = lp * 0.65 + white * 0.35;
      data[i] = lp * env;
    }
  }
  return impulse;
}

export class LiveMicEngine {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private dryGain: GainNode | null = null;
  private wetGain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private meterBuf: Float32Array<ArrayBuffer> | null = null;
  private gain = 0.85;
  private reverb = 0.28;

  async start(gain = 1.0, reverb = 0.28): Promise<void> {
    this.stop();
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone input requires HTTPS or localhost in a supported browser.");
    }

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) {
      throw new Error("Web Audio API is unavailable in this browser.");
    }

    // Create AudioContext synchronously inside the user gesture before awaiting getUserMedia
    const ctx = new AudioCtx({ latencyHint: "interactive" });
    void ctx.resume().catch(() => {});

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      void ctx.close().catch(() => {});
      throw err;
    }

    if (ctx.state === "suspended") {
      await ctx.resume();
    }

    const source = ctx.createMediaStreamSource(stream);

    // Cut low-end desk rumble and vocal plosives below 85 Hz
    const highpass = ctx.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = 85;

    const dryGain = ctx.createGain();
    const wetGain = ctx.createGain();
    const convolver = ctx.createConvolver();
    convolver.buffer = buildHallImpulse(ctx);

    // Gentle broadcast limiter protects speakers from sudden vocal peaks
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 12;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.004;
    limiter.release.value = 0.14;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;

    source.connect(highpass);
    highpass.connect(analyser);
    highpass.connect(dryGain);
    highpass.connect(convolver);
    convolver.connect(wetGain);
    dryGain.connect(limiter);
    wetGain.connect(limiter);
    limiter.connect(ctx.destination);

    this.ctx = ctx;
    this.stream = stream;
    this.dryGain = dryGain;
    this.wetGain = wetGain;
    this.analyser = analyser;
    this.meterBuf = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
    this.gain = clampMicGain(gain);
    this.reverb = clampReverbMix(reverb);
    dryGain.gain.value = this.gain * (1 - this.reverb * 0.35);
    wetGain.gain.value = this.gain * this.reverb * 0.75;
  }

  applyMix(gain: number, reverb: number): void {
    this.gain = clampMicGain(gain);
    this.reverb = clampReverbMix(reverb);
    if (!this.ctx || !this.dryGain || !this.wetGain) return;
    const now = this.ctx.currentTime;
    const dryLevel = this.gain * (1 - this.reverb * 0.35);
    const wetLevel = this.gain * this.reverb * 0.75;
    this.dryGain.gain.setTargetAtTime(dryLevel, now, 0.02);
    this.wetGain.gain.setTargetAtTime(wetLevel, now, 0.02);
  }

  /** Normalized RMS mic input level (0..1) for the live meter. */
  getLevel(): number {
    if (!this.analyser || !this.meterBuf) return 0;
    this.analyser.getFloatTimeDomainData(this.meterBuf);
    let sumSq = 0;
    for (let i = 0; i < this.meterBuf.length; i++) {
      const s = this.meterBuf[i];
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / this.meterBuf.length);
    return Math.min(1, rms * 5.2);
  }

  stop(): void {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    if (this.ctx) {
      if (this.ctx.state !== "closed") {
        void this.ctx.close().catch(() => {});
      }
      this.ctx = null;
    }
    this.dryGain = null;
    this.wetGain = null;
    this.analyser = null;
    this.meterBuf = null;
  }
}

export const PHONE_MIC_SAMPLE_RATE = 16000;

/** Downsample mono Float32 samples to 16 kHz Int16 PCM for low-latency Wi-Fi mic streaming. */
export function downsampleToInt16(
  input: Float32Array,
  inputRate: number,
  targetRate = PHONE_MIC_SAMPLE_RATE
): ArrayBuffer {
  const ratio = Math.max(1, inputRate / targetRate);
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    const sample = Math.max(-1, Math.min(1, sum / (end - start)));
    out[i] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
  }
  return out.buffer;
}

export function int16ToFloat32(buffer: ArrayBuffer): Float32Array {
  const view = new Int16Array(buffer);
  const out = new Float32Array(view.length);
  for (let i = 0; i < view.length; i++) {
    out[i] = view[i] / 0x8000;
  }
  return out;
}

/** Tune Opus SDP parameters for lowest-latency 10ms mono frames on LAN Wi-Fi. */
export function tuneLowLatencyOpusSdp(sdp: string): string {
  const opusMatch = sdp.match(/a=rtpmap:(\d+)\s+opus\/48000\/2/i);
  if (!opusMatch) return sdp;
  const pt = opusMatch[1];
  const fmtpRe = new RegExp(`a=fmtp:${pt} ([^\\r\\n]+)`);
  let tuned = sdp;
  if (fmtpRe.test(tuned)) {
    tuned = tuned.replace(fmtpRe, (_full, params: string) => {
      const cleaned = params
        .split(";")
        .map((p) => p.trim())
        .filter(
          (p) =>
            p &&
            !/^(minptime|ptime|useinbandfec|stereo|sprop-stereo)=/i.test(p)
        );
      cleaned.push("minptime=10", "ptime=10", "useinbandfec=0", "stereo=0");
      return `a=fmtp:${pt} ${cleaned.join(";")}`;
    });
  } else {
    tuned = tuned.replace(
      new RegExp(`(a=rtpmap:${pt} opus/48000/2\\r?\\n)`, "i"),
      `$1a=fmtp:${pt} minptime=10;ptime=10;useinbandfec=0;stereo=0\r\n`
    );
  }
  if (!/a=maxptime:/i.test(tuned)) {
    tuned = tuned.replace(/(m=audio[^\r\n]+\r?\n)/, "$1a=ptime:10\r\na=maxptime:20\r\n");
  }
  return tuned;
}

const PCM_WORKLET_CODE = `
class GeetPcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(256);
    this.offset = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    let idx = 0;
    while (idx < ch.length) {
      const n = Math.min(ch.length - idx, this.buf.length - this.offset);
      this.buf.set(ch.subarray(idx, idx + n), this.offset);
      this.offset += n;
      idx += n;
      if (this.offset === this.buf.length) {
        const copy = this.buf.slice();
        this.port.postMessage(copy.buffer, [copy.buffer]);
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("geet-pcm-capture", GeetPcmCapture);
`;

export type PhoneMicTransport = "idle" | "connecting" | "webrtc" | "ws";

/**
 * Captures a phone's microphone and streams to Host PC speakers over LAN.
 * Prefers direct LAN WebRTC UDP (10ms Opus, ~25-50ms latency) and automatically
 * falls back to AudioWorklet 5ms-frame WebSocket PCM if direct UDP is blocked.
 */
export class PhoneMicSender {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private meterBuf: Float32Array<ArrayBuffer> | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private pc: RTCPeerConnection | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private onChunk: ((pcm: ArrayBuffer) => void) | null = null;
  private onRtcSignal: ((signal: MicRtcSignal) => void) | null = null;
  private mode: PhoneMicTransport = "idle";

  async start(
    onChunk: (pcm: ArrayBuffer) => void,
    onRtcSignal?: (signal: MicRtcSignal) => void
  ): Promise<void> {
    this.stop();
    if (typeof window !== "undefined" && !window.isSecureContext) {
      throw new Error(
        "Phone browsers block microphone access on plain http://. Open the https:// link to use Phone Mic."
      );
    }
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone API is unavailable in this browser.");
    }

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) {
      throw new Error("Web Audio API is unavailable.");
    }

    // Create & unlock AudioContext synchronously before awaiting getUserMedia so iOS/Android keep the tap gesture
    const ctx = new AudioCtx({ latencyHint: "interactive" });
    void ctx.resume().catch(() => {});

    let stream: MediaStream;
    try {
      // Disable heavy mobile VoIP echo-cancellation/noise-suppression DSP (saves ~80-120ms latency)
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: true,
        },
      });
    } catch (err) {
      void ctx.close().catch(() => {});
      throw err;
    }

    if (ctx.state === "suspended") await ctx.resume();

    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    this.ctx = ctx;
    this.stream = stream;
    this.source = source;
    this.analyser = analyser;
    this.meterBuf = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
    this.onChunk = onChunk;
    this.onRtcSignal = onRtcSignal ?? null;

    if (typeof RTCPeerConnection !== "undefined" && onRtcSignal) {
      this.mode = "connecting";
      await this.startWebRtc(stream, onRtcSignal);
      // If LAN UDP doesn't connect quickly (e.g. strict firewall), engage low-latency WS PCM fallback
      this.fallbackTimer = setTimeout(() => {
        if (this.mode !== "webrtc" && this.ctx && this.source) {
          void this.startWsFallback();
        }
      }, 2200);
    } else {
      await this.startWsFallback();
    }
  }

  private async startWebRtc(
    stream: MediaStream,
    sendSignal: (signal: MicRtcSignal) => void
  ): Promise<void> {
    const pc = new RTCPeerConnection({ iceServers: [] });
    this.pc = pc;
    this.pendingIce = [];

    for (const track of stream.getAudioTracks()) {
      const sender = pc.addTrack(track, stream);
      // Prefer low-latency audio encoding when browser supports RTCRtpSender.setParameters
      try {
        const params = sender.getParameters();
        if (params.encodings?.length) {
          params.encodings[0].priority = "high";
          params.encodings[0].networkPriority = "high";
          void sender.setParameters(params).catch(() => {});
        }
      } catch {
        // Optional browser API
      }
    }

    pc.onicecandidate = (ev) => {
      if (ev.candidate && this.pc === pc) {
        sendSignal({ kind: "ice", candidate: ev.candidate.toJSON() });
      }
    };

    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      if (pc.connectionState === "connected") {
        this.mode = "webrtc";
        if (this.fallbackTimer) {
          clearTimeout(this.fallbackTimer);
          this.fallbackTimer = null;
        }
        this.stopWsFallback();
      } else if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        if (this.ctx && this.source && this.mode !== "ws") {
          void this.startWsFallback();
        }
      }
    };

    const offer = await pc.createOffer({ offerToReceiveAudio: false });
    const tunedOffer: RTCSessionDescriptionInit = {
      type: offer.type,
      sdp: offer.sdp ? tuneLowLatencyOpusSdp(offer.sdp) : offer.sdp,
    };
    await pc.setLocalDescription(tunedOffer);
    sendSignal({ kind: "offer", sdp: tunedOffer.sdp });
  }

  async handleRtcSignal(signal: MicRtcSignal): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    try {
      if (signal.kind === "answer" && signal.sdp) {
        await pc.setRemoteDescription({ type: "answer", sdp: signal.sdp });
        for (const cand of this.pendingIce) {
          await pc.addIceCandidate(cand).catch(() => {});
        }
        this.pendingIce = [];
      } else if (signal.kind === "ice" && signal.candidate) {
        if (pc.remoteDescription) {
          await pc.addIceCandidate(signal.candidate).catch(() => {});
        } else {
          this.pendingIce.push(signal.candidate);
        }
      }
    } catch {
      // Fallback timer will switch to WS PCM if WebRTC handshake fails
    }
  }

  private async startWsFallback(): Promise<void> {
    if (!this.ctx || !this.source || !this.onChunk || this.workletNode || this.processor) return;
    this.mode = "ws";
    const ctx = this.ctx;
    const onChunk = this.onChunk;
    const silent = ctx.createGain();
    silent.gain.value = 0;

    if (ctx.audioWorklet && typeof Blob !== "undefined") {
      try {
        const blobUrl = URL.createObjectURL(
          new Blob([PCM_WORKLET_CODE], { type: "application/javascript" })
        );
        try {
          await ctx.audioWorklet.addModule(blobUrl);
        } finally {
          URL.revokeObjectURL(blobUrl);
        }
        if (this.ctx !== ctx || this.mode !== "ws") return;
        const worklet = new AudioWorkletNode(ctx, "geet-pcm-capture");
        worklet.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
          const samples = new Float32Array(ev.data);
          onChunk(downsampleToInt16(samples, ctx.sampleRate));
        };
        this.source.connect(worklet);
        worklet.connect(silent);
        silent.connect(ctx.destination);
        this.workletNode = worklet;
        return;
      } catch {
        // Fall through to 512-sample ScriptProcessorNode
      }
    }

    const processor = ctx.createScriptProcessor(512, 1, 1);
    processor.onaudioprocess = (ev) => {
      onChunk(downsampleToInt16(ev.inputBuffer.getChannelData(0), ctx.sampleRate));
    };
    this.source.connect(processor);
    processor.connect(silent);
    silent.connect(ctx.destination);
    this.processor = processor;
  }

  private stopWsFallback(): void {
    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.processor) {
      this.processor.onaudioprocess = null;
      this.processor.disconnect();
      this.processor = null;
    }
  }

  getMode(): PhoneMicTransport {
    return this.mode;
  }

  getLevel(): number {
    if (!this.analyser || !this.meterBuf) return 0;
    this.analyser.getFloatTimeDomainData(this.meterBuf);
    let sumSq = 0;
    for (let i = 0; i < this.meterBuf.length; i++) {
      const s = this.meterBuf[i];
      sumSq += s * s;
    }
    return Math.min(1, Math.sqrt(sumSq / this.meterBuf.length) * 5.2);
  }

  stop(): void {
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    if (this.pc) {
      this.onRtcSignal?.({ kind: "stop" });
      this.pc.onicecandidate = null;
      this.pc.onconnectionstatechange = null;
      this.pc.close();
      this.pc = null;
    }
    this.pendingIce = [];
    this.stopWsFallback();
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.ctx) {
      if (this.ctx.state !== "closed") void this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    this.analyser = null;
    this.meterBuf = null;
    this.onChunk = null;
    this.onRtcSignal = null;
    this.mode = "idle";
  }
}

export const MAX_REMOTE_MICS = 4;

export interface RemoteMicPeerInfo {
  uid: string;
  name: string;
  muted: boolean;
  blocked: boolean;
}

/** Scale per-peer speaker volume slightly when 2+ phones sing together to prevent clipping. */
export function computeDuetPeerVolume(gain: number, activePeerCount: number): number {
  const base = Math.max(0, Math.min(1, clampMicGain(gain)));
  if (activePeerCount <= 1) return base;
  if (activePeerCount === 2) return Math.min(1, base * 0.85);
  return Math.min(1, base / Math.sqrt(activePeerCount));
}

interface RtcPeerSlot {
  uid: string;
  name: string;
  pc: RTCPeerConnection;
  pendingIce: RTCIceCandidateInit[];
  audioEl: HTMLAudioElement | null;
  connected: boolean;
  blocked: boolean;
  muted: boolean;
}

/**
 * Receives wireless phone mic audio on Host PC speakers.
 * Supports 2+ simultaneous phones (Duet Mode) over direct LAN WebRTC UDP
 * (<audio> native C++ path, ~25-50ms) plus low-latency WebSocket PCM fallback.
 */
export class RemoteMicReceiver {
  private ctx: AudioContext | null = null;
  private dryGain: GainNode | null = null;
  private wetGain: GainNode | null = null;
  private convolver: ConvolverNode | null = null;
  private nextPlayTime = 0;
  private gain = 1.15;
  private reverb = 0.25;
  private muted = false;
  private level = 0;
  private lastPacketAt = 0;

  // Map of simultaneous direct LAN WebRTC phone peers keyed by guest user_id
  private peers = new Map<string, RtcPeerSlot>();

  private ensureContext(): AudioContext | null {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => {});
      return this.ctx;
    }
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return null;

    const ctx = new AudioCtx({ latencyHint: "interactive" });
    const dryGain = ctx.createGain();
    const wetGain = ctx.createGain();
    const convolver = ctx.createConvolver();
    convolver.buffer = buildHallImpulse(ctx);
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.ratio.value = 8;

    dryGain.connect(limiter);
    convolver.connect(wetGain);
    wetGain.connect(limiter);
    limiter.connect(ctx.destination);

    this.ctx = ctx;
    this.dryGain = dryGain;
    this.wetGain = wetGain;
    this.convolver = convolver;
    dryGain.gain.value = this.gain * (1 - this.reverb * 0.35);
    wetGain.gain.value = this.gain * this.reverb * 0.75;
    return ctx;
  }

  private rebalancePeerVolumes(): void {
    const activeCount = Array.from(this.peers.values()).filter((p) => p.connected).length;
    const vol = computeDuetPeerVolume(this.gain, Math.max(1, activeCount));
    for (const slot of this.peers.values()) {
      if (slot.audioEl) {
        slot.audioEl.volume = vol;
        slot.audioEl.muted = this.muted || slot.muted;
      }
    }
  }

  private closePeer(uid: string): void {
    const slot = this.peers.get(uid);
    if (!slot) return;
    this.peers.delete(uid);
    slot.pc.onicecandidate = null;
    slot.pc.ontrack = null;
    slot.pc.onconnectionstatechange = null;
    slot.pc.close();
    if (slot.audioEl) {
      slot.audioEl.pause();
      slot.audioEl.srcObject = null;
      slot.audioEl = null;
    }
    this.rebalancePeerVolumes();
  }

  private closeAllPeers(): void {
    for (const uid of Array.from(this.peers.keys())) {
      this.closePeer(uid);
    }
  }

  private hasConnectedRtc(): boolean {
    for (const slot of this.peers.values()) {
      if (slot.connected) return true;
    }
    return false;
  }

  async handleRtcSignal(
    signal: MicRtcSignal,
    sendReply: (reply: MicRtcSignal) => void
  ): Promise<void> {
    if (typeof RTCPeerConnection === "undefined") return;
    const fromUid = signal.fromUid;
    if (!fromUid) return;

    if (signal.kind === "stop") {
      this.closePeer(fromUid);
      return;
    }

    if (signal.kind === "offer" && signal.sdp) {
      // Replace any stale connection from this same phone without disturbing other duet singers
      this.closePeer(fromUid);
      if (this.peers.size >= MAX_REMOTE_MICS) {
        const oldestUid = this.peers.keys().next().value;
        if (oldestUid) this.closePeer(oldestUid);
      }

      const pc = new RTCPeerConnection({ iceServers: [] });
      const slot: RtcPeerSlot = {
        uid: fromUid,
        name: signal.fromName?.trim() || "Singer",
        pc,
        pendingIce: [],
        audioEl: null,
        connected: false,
        blocked: false,
        muted: false,
      };
      this.peers.set(fromUid, slot);

      pc.onicecandidate = (ev) => {
        if (ev.candidate && this.peers.get(fromUid) === slot) {
          sendReply({
            toUid: fromUid,
            kind: "ice",
            candidate: ev.candidate.toJSON(),
          });
        }
      };

      pc.onconnectionstatechange = () => {
        if (this.peers.get(fromUid) !== slot) return;
        slot.connected = pc.connectionState === "connected";
        this.rebalancePeerVolumes();
        if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          this.closePeer(fromUid);
        }
      };

      pc.ontrack = (ev) => {
        if (this.peers.get(fromUid) !== slot) return;
        const stream = ev.streams[0] ?? new MediaStream([ev.track]);
        const audio = document.createElement("audio");
        audio.autoplay = true;
        audio.srcObject = stream;
        slot.audioEl = audio;
        slot.connected = true;
        this.rebalancePeerVolumes();
        void audio
          .play()
          .then(() => {
            slot.blocked = false;
          })
          .catch(() => {
            slot.blocked = true;
          });
      };

      try {
        await pc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
        for (const cand of slot.pendingIce) {
          await pc.addIceCandidate(cand).catch(() => {});
        }
        slot.pendingIce = [];
        const answer = await pc.createAnswer();
        const tunedAnswer: RTCSessionDescriptionInit = {
          type: answer.type,
          sdp: answer.sdp ? tuneLowLatencyOpusSdp(answer.sdp) : answer.sdp,
        };
        await pc.setLocalDescription(tunedAnswer);
        sendReply({ toUid: fromUid, kind: "answer", sdp: tunedAnswer.sdp });
      } catch {
        this.closePeer(fromUid);
      }
      return;
    }

    if (signal.kind === "ice" && signal.candidate) {
      const slot = this.peers.get(fromUid);
      if (!slot) return;
      if (slot.pc.remoteDescription) {
        await slot.pc.addIceCandidate(signal.candidate).catch(() => {});
      } else {
        slot.pendingIce.push(signal.candidate);
      }
    }
  }

  /** Call inside a host user gesture (click/keypress) to unlock speaker output for all duet peers and WS audio. */
  async unlock(): Promise<boolean> {
    let ok = true;
    for (const slot of this.peers.values()) {
      if (slot.audioEl) {
        try {
          await slot.audioEl.play();
          slot.blocked = false;
        } catch {
          slot.blocked = true;
          ok = false;
        }
      }
    }
    const ctx = this.ensureContext();
    if (ctx && ctx.state !== "running") {
      try {
        await ctx.resume();
      } catch {
        ok = false;
      }
    }
    return ok && !this.isSuspended();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.rebalancePeerVolumes();
  }

  setPeerMuted(uid: string, muted: boolean): void {
    const slot = this.peers.get(uid);
    if (!slot) return;
    slot.muted = muted;
    this.rebalancePeerVolumes();
  }

  isMuted(): boolean {
    return this.muted;
  }

  getActivePeers(): RemoteMicPeerInfo[] {
    const list: RemoteMicPeerInfo[] = [];
    for (const slot of this.peers.values()) {
      if (slot.connected) {
        list.push({
          uid: slot.uid,
          name: slot.name,
          muted: this.muted || slot.muted,
          blocked: slot.blocked,
        });
      }
    }
    return list;
  }

  isSuspended(): boolean {
    if (this.hasConnectedRtc()) {
      for (const slot of this.peers.values()) {
        if (slot.connected && slot.blocked) return true;
      }
      return false;
    }
    return Boolean(this.ctx && this.ctx.state !== "running");
  }

  isReceiving(): boolean {
    if (this.hasConnectedRtc()) return true;
    return this.lastPacketAt > 0 && Date.now() - this.lastPacketAt < 1200;
  }

  getTransportMode(): "webrtc" | "ws" | null {
    if (this.hasConnectedRtc()) return "webrtc";
    if (this.lastPacketAt > 0 && Date.now() - this.lastPacketAt < 1200) return "ws";
    return null;
  }

  getLevel(): number {
    return this.isReceiving() ? this.level : 0;
  }

  applyMix(gain: number, reverb: number): void {
    this.gain = clampMicGain(gain);
    this.reverb = clampReverbMix(reverb);
    this.rebalancePeerVolumes();
    if (!this.ctx || !this.dryGain || !this.wetGain) return;
    const now = this.ctx.currentTime;
    this.dryGain.gain.setTargetAtTime(this.gain * (1 - this.reverb * 0.35), now, 0.02);
    this.wetGain.gain.setTargetAtTime(this.gain * this.reverb * 0.75, now, 0.02);
  }

  enqueue(pcm: ArrayBuffer): void {
    if (pcm.byteLength < 4 || this.hasConnectedRtc()) return;
    this.lastPacketAt = Date.now();
    const samples = int16ToFloat32(pcm);
    let sumSq = 0;
    for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i];
    this.level = Math.min(1, Math.sqrt(sumSq / samples.length) * 5.2);

    if (this.muted) return;

    const ctx = this.ensureContext();
    if (!ctx || !this.dryGain || !this.convolver) return;
    // Do not pile up buffers on a frozen suspended clock; wait until browser audio is running
    if (ctx.state !== "running") {
      void ctx.resume().catch(() => {});
      return;
    }

    const audioBuf = ctx.createBuffer(1, samples.length, PHONE_MIC_SAMPLE_RATE);
    audioBuf.getChannelData(0).set(samples);

    const src = ctx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(this.dryGain);
    src.connect(this.convolver);

    const now = ctx.currentTime;
    // Tight 16ms jitter cushion; drop excess drift above 65ms so vocals never lag behind the beat
    if (this.nextPlayTime < now || this.nextPlayTime > now + 0.065) {
      this.nextPlayTime = now + 0.016;
    }
    src.start(this.nextPlayTime);
    this.nextPlayTime += audioBuf.duration;
  }

  stop(): void {
    this.closeAllPeers();
    this.nextPlayTime = 0;
    this.level = 0;
    this.lastPacketAt = 0;
    if (this.ctx) {
      if (this.ctx.state !== "closed") void this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    this.dryGain = null;
    this.wetGain = null;
    this.convolver = null;
  }
}
