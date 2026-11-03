export type SoundKind = 'click' | 'route' | 'alarm';

/** Минимальный интерфейс Web Audio, который нам нужен (и который подменяется в тестах). */
export type Ctx = AudioContext;

const MIN_GAP: Record<SoundKind, number> = { click: 0.08, route: 0.25, alarm: 2 };

/** Звуки синтезируются в коде, без сэмплов. Контекст создаётся по первому жесту пользователя. */
export class Sound {
  enabled = true;
  private ambientOn = true;
  private ctx: Ctx | undefined;
  private master: GainNode | undefined;
  private ambient: { src: AudioBufferSourceNode; gain: GainNode } | undefined;
  private readonly last = new Map<SoundKind, number>();
  /** Сколько звуков воспроизведено (для проверок). */
  played = 0;

  constructor(private readonly factory: () => Ctx | undefined = defaultFactory) {}

  /** Вызвать из обработчика жеста: создаёт и возобновляет контекст, запускает фон. */
  unlock(): void {
    if (!this.enabled) return;
    if (!this.ctx) {
      this.ctx = this.factory();
      if (!this.ctx) return;
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
    }
    void this.ctx.resume?.();
    this.syncAmbient();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on) this.unlock();
    else this.stopAmbient();
  }

  get ambientEnabled(): boolean {
    return this.ambientOn;
  }

  setAmbient(on: boolean): void {
    this.ambientOn = on;
    this.syncAmbient();
  }

  private syncAmbient(): void {
    if (this.enabled && this.ambientOn && this.ctx) this.startAmbient();
    else this.stopAmbient();
  }

  private startAmbient(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.ambient) return;
    // Тихий фон зала: зациклённый шум через фильтр низких частот.
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let seed = 12345;
    for (let i = 0; i < len; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      data[i] = (seed / 4294967296) * 2 - 1;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 380;
    const gain = ctx.createGain();
    gain.gain.value = 0.045;
    src.connect(lp);
    lp.connect(gain);
    gain.connect(this.master);
    src.start();
    this.ambient = { src, gain };
  }

  private stopAmbient(): void {
    if (!this.ambient) return;
    try {
      this.ambient.src.stop();
    } catch {
      /* уже остановлен */
    }
    this.ambient.gain.disconnect();
    this.ambient = undefined;
  }

  /** Воспроизвести звук; слишком частые повторы отбрасываются. */
  play(kind: SoundKind, volume = 1): boolean {
    const ctx = this.ctx;
    if (!this.enabled || !ctx || !this.master) return false;
    const now = ctx.currentTime;
    const prev = this.last.get(kind);
    if (prev !== undefined && now - prev < MIN_GAP[kind]) return false;
    this.last.set(kind, now);
    this.played++;
    if (kind === 'click') this.click(ctx, now, volume);
    else if (kind === 'route') this.beeps(ctx, now, volume, [880, 1320], 0.07, 'sine');
    else this.beeps(ctx, now, volume, [620, 880, 620, 880, 620, 880], 0.14, 'square');
    return true;
  }

  private env(ctx: Ctx, start: number, dur: number, peak: number): GainNode {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), start + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    g.connect(this.master as GainNode);
    return g;
  }

  private click(ctx: Ctx, t: number, vol: number): void {
    const len = Math.floor(ctx.sampleRate * 0.03);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800;
    src.connect(bp);
    bp.connect(this.env(ctx, t, 0.04, 0.6 * vol));
    src.start(t);
  }

  private beeps(ctx: Ctx, t: number, vol: number, freqs: number[], len: number, type: OscillatorType): void {
    freqs.forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      o.connect(this.env(ctx, t + i * len, len * 0.9, (type === 'square' ? 0.25 : 0.4) * vol));
      o.start(t + i * len);
      o.stop(t + (i + 1) * len);
    });
  }
}

function defaultFactory(): Ctx | undefined {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as { AudioContext?: new () => Ctx; webkitAudioContext?: new () => Ctx };
  const C = w.AudioContext ?? w.webkitAudioContext;
  return C ? new C() : undefined;
}
