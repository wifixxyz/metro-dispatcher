import { Dispatcher, type DispatcherStatus } from './core/dispatcher';
import { Graph } from './core/graph';
import { Sim, type SimEvent } from './core/sim';
import type { LineConfig } from './lines/schema';

export const SPEEDS = [1, 2, 4, 8] as const;
export const INTERVALS = [120, 180, 300] as const;

export interface LogLine {
  t: number;
  text: string;
  kind: 'info' | 'warn';
}

export function formatClock(t: number): string {
  const s = Math.floor(t);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(sec)}`;
}

/** Состояние игры: симуляция + автодиспетчер + время. Без DOM. */
export class Game {
  graph!: Graph;
  sim!: Sim;
  disp!: Dispatcher;
  speed = 1;
  paused = false;
  mode: string;
  interval: number;
  readonly log: LogLine[] = [];
  private logSeen = 0;
  private acc = 0;
  private lapCache = new Map<string, number>();

  constructor(
    readonly cfg: LineConfig,
    opts: { mode?: string; interval?: number; seed?: number } = {},
  ) {
    this.mode = opts.mode ?? cfg.modes?.[0]?.id ?? '';
    this.interval = opts.interval ?? 180;
    this.seed = opts.seed ?? 1;
    this.reset(this.mode);
  }

  private seed: number;

  /** Новая смена в выбранном режиме; парк набирается «за кадром» до расчётного. */
  reset(mode: string): void {
    this.mode = mode;
    this.graph = new Graph(this.cfg);
    this.sim = new Sim(this.graph, { seed: this.seed });
    const lap = this.lapCache.get(mode);
    this.disp = new Dispatcher(this.sim, this.cfg, {
      mode,
      interval: this.interval,
      ...(lap !== undefined ? { lapTime: lap } : {}),
    });
    this.lapCache.set(mode, this.disp.lapTime);
    this.acc = 0;
    this.log.length = 0;
    this.logSeen = 0;
    const limit = 3 * 3600;
    while (this.sim.t < limit && (this.disp.active < this.disp.required || this.sim.t < 60)) this.stepOnce();
    this.sim.events.length = 0;
    this.disp.resetEventCursor();
    this.logSeen = 0;
    this.addLog(0, 'Смена начата', 'info');
  }

  setInterval(sec: number): void {
    this.interval = sec;
    this.disp.setInterval(sec);
    this.addLog(this.sim.t, `Интервал ${sec / 60} мин`, 'info');
  }

  setSpeed(x: number): void {
    this.speed = x;
    this.paused = false;
  }

  togglePause(): void {
    this.paused = !this.paused;
  }

  private stepOnce(): void {
    this.sim.step();
    this.disp.update();
  }

  /** Продвинуть модель на кадр длиной `frameDt` секунд реального времени. */
  advance(frameDt: number, maxSteps = 600): number {
    if (this.paused) return 0;
    this.acc += frameDt * this.speed;
    const n = Math.min(maxSteps, Math.floor(this.acc / this.sim.dt));
    this.acc = n >= maxSteps ? 0 : this.acc - n * this.sim.dt;
    for (let i = 0; i < n; i++) this.stepOnce();
    this.collectLog();
    return n;
  }

  status(): DispatcherStatus {
    return this.disp.status();
  }

  private addLog(t: number, text: string, kind: LogLine['kind']): void {
    this.log.push({ t, text, kind });
    if (this.log.length > 300) this.log.splice(0, this.log.length - 300);
  }

  private stationName(id: string): string {
    return this.cfg.stations.find((s) => s.id === id)?.name ?? id;
  }

  private collectLog(): void {
    const ev = this.sim.events;
    for (; this.logSeen < ev.length; this.logSeen++) {
      const e = ev[this.logSeen] as SimEvent;
      if (e.type === 'arrive') this.addLog(e.t, `${e.train} прибыл: ${this.stationName(e.station)}`, 'info');
      else if (e.type === 'depart') this.addLog(e.t, `${e.train} отправился: ${this.stationName(e.station)}`, 'info');
      else if (e.type === 'emergency') this.addLog(e.t, `${e.train}: экстренное торможение`, 'warn');
    }
    // События нужны только журналу и диспетчеру; не даём им расти бесконечно.
    if (ev.length > 5000 && this.logSeen === ev.length && this.disp.eventsConsumed()) {
      ev.length = 0;
      this.logSeen = 0;
      this.disp.resetEventCursor();
    }
  }
}
