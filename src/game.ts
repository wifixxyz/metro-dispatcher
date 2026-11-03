import { Dispatcher, type DispatcherStatus } from './core/dispatcher';
import { Graph } from './core/graph';
import { Sim, type SimEvent } from './core/sim';
import type { LineConfig } from './lines/schema';
import { Stats } from './stats';

export const SPEEDS = [1, 2, 4, 8] as const;
export const INTERVALS = [120, 180, 300] as const;

export type Result = { ok: true } | { ok: false; reason: string };

/** Действие игрока, привязанное к номеру шага: по нему смена воспроизводится точно. */
export type Action =
  | { n: number; k: 'interval'; v: number }
  | { n: number; k: 'lineManual'; v: boolean }
  | { n: number; k: 'nodeManual'; node: string; v: boolean }
  | { n: number; k: 'route'; from: string; to: string }
  | { n: number; k: 'cancel'; block: string }
  | { n: number; k: 'points'; node: string; edge?: string }
  | { n: number; k: 'hold'; id: string; v: boolean }
  | { n: number; k: 'send'; id: string }
  | { n: number; k: 'recall'; id: string };

type DistributiveOmit<T, K extends string> = T extends unknown ? Omit<T, K> : never;

/** Сохранение смены: параметры запуска + действия игрока (модель детерминирована). */
export interface SaveData {
  v: 1;
  mode: string;
  seed: number;
  startInterval: number;
  steps: number;
  actions: Action[];
  savedAt: number;
}

export interface GameSignal {
  kind: 'switch' | 'route' | 'alarm' | 'action';
  /** Вызвано действием игрока, а не автоматом. */
  player: boolean;
}

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
  /** Вся линия в ручном режиме. */
  manualLine = false;
  /** Узлы в ручном режиме (при автоматической линии). */
  readonly manualNodes = new Set<string>();
  /** Число ручных вмешательств за смену. */
  interventions = 0;
  private routeSeq = 0;
  private acc = 0;
  stepCount = 0;
  actions: Action[] = [];
  startInterval: number;
  stats!: Stats;
  /** Звук и вибрация подписываются здесь. */
  onSignal: ((s: GameSignal) => void) | undefined;
  private muted = false;
  private player = false;
  private lapCache = new Map<string, number>();

  constructor(
    readonly cfg: LineConfig,
    opts: { mode?: string; interval?: number; seed?: number } = {},
  ) {
    this.mode = opts.mode ?? cfg.modes?.[0]?.id ?? '';
    this.interval = opts.interval ?? 180;
    this.startInterval = this.interval;
    this.seed = opts.seed ?? 1;
    this.reset(this.mode);
  }

  private seed: number;

  /** Новая смена в выбранном режиме; парк набирается «за кадром» до расчётного. */
  reset(mode: string): void {
    this.mode = mode;
    this.interval = this.startInterval = this.interval;
    this.stepCount = 0;
    this.actions = [];
    this.stats = new Stats(this.cfg);
    this.graph = new Graph(this.cfg);
    this.sim = new Sim(this.graph, { seed: this.seed, ...(this.cfg.blockLength !== undefined ? { maxBlock: this.cfg.blockLength } : {}) });
    const lap = this.lapCache.get(mode);
    this.disp = new Dispatcher(this.sim, this.cfg, {
      mode,
      interval: this.interval,
      ...(lap !== undefined ? { lapTime: lap } : {}),
    });
    this.lapCache.set(mode, this.disp.lapTime);
    this.sim.il.onPoints = () => this.emit({ kind: 'switch', player: this.player });
    this.acc = 0;
    this.interventions = 0;
    this.applyManual();
    this.log.length = 0;
    this.logSeen = 0;
    const limit = 3 * 3600;
    while (this.sim.t < limit && (this.disp.active < this.disp.required || this.sim.t < 60)) this.stepOnce();
    this.sim.events.length = 0;
    this.disp.resetEventCursor();
    this.logSeen = 0;
    this.stepCount = 0;
    this.stats = new Stats(this.cfg);
    this.addLog(0, 'Смена начата', 'info');
  }

  /** Привести ядро в соответствие с переключателями авто / ручной. */
  private applyManual(): void {
    this.disp.auto = !this.manualLine;
    this.sim.manualNodes.clear();
    const nodes = this.sim.il.controlledNodes();
    for (const n of nodes) if (this.manualLine || this.manualNodes.has(n)) this.sim.manualNodes.add(n);
  }

  private done(text: string, r: Result): Result {
    if (r.ok) {
      this.interventions++;
      this.addLog(this.sim.t, text, 'info');
    } else {
      this.addLog(this.sim.t, r.reason, 'warn');
    }
    return r;
  }

  setLineManual(on: boolean): void {
    this.rec({ k: 'lineManual', v: on });
    this.manualLine = on;
    this.applyManual();
    this.interventions++;
    this.addLog(this.sim.t, on ? 'Линия: ручной режим' : 'Линия: автомат', 'info');
  }

  setNodeManual(node: string, on: boolean): void {
    this.rec({ k: 'nodeManual', node, v: on });
    if (on) this.manualNodes.add(node);
    else this.manualNodes.delete(node);
    this.applyManual();
    this.interventions++;
    this.addLog(this.sim.t, `Узел ${node}: ${on ? 'ручной' : 'авто'}`, 'info');
  }

  isNodeManual(node: string): boolean {
    return this.manualLine || this.manualNodes.has(node);
  }

  /**
   * Задать маршрут: от светофора на входе в блок `from` до светофора на входе в блок `to`
   * (маршрут занимает блоки до конечного светофора). Занимает путь кратчайшей цепочкой участков.
   */
  setRoute(from: string, to: string): Result {
    this.rec({ k: 'route', from, to });
    return this.act(() => this.setRouteInner(from, to));
  }

  private setRouteInner(from: string, to: string): Result {
    const il = this.sim.il;
    const a = il.blocks.get(from);
    const b = il.blocks.get(to);
    if (!a || !b || from === to) return this.done('', { ok: false, reason: 'Выберите два разных светофора' });
    let ids: string[];
    try {
      const edges = a.edge === b.edge && a.index < b.index ? [a.edge] : this.graph.findPath(a.edge, b.edge);
      ids = il.pathBlocks(edges).map((x) => x.block.id);
    } catch {
      return this.done('', { ok: false, reason: 'Между светофорами нет пути' });
    }
    const i = ids.indexOf(from);
    const j = ids.lastIndexOf(to);
    if (i < 0 || j <= i) return this.done('', { ok: false, reason: 'Конечный светофор не по ходу движения' });
    ids = ids.slice(i, j);
    if (ids.length > 12) return this.done('', { ok: false, reason: 'Маршрут слишком длинный' });
    const id = `M${++this.routeSeq}`;
    const r = il.setRoute(id, ids, '*');
    if (r.ok) this.emit({ kind: 'route', player: true });
    return this.done(`Маршрут ${from} → ${to}`, r);
  }

  /** Отменить маршрут, замкнутый на блок-участок (с выдержкой при замыкании приближения). */
  cancelRoute(blockId: string): Result {
    this.rec({ k: 'cancel', block: blockId });
    return this.act(() => this.cancelRouteInner(blockId));
  }

  private cancelRouteInner(blockId: string): Result {
    const r = this.sim.il.routeOf(blockId);
    if (!r) return this.done('', { ok: false, reason: 'Маршрут не установлен' });
    return this.done(`Маршрут ${r.id} отменён`, this.sim.il.cancelRoute(r.id, this.sim.t));
  }

  throwPoints(node: string, edge?: string): Result {
    this.rec(edge === undefined ? { k: 'points', node } : { k: 'points', node, edge });
    return this.act(() => this.throwPointsInner(node, edge));
  }

  private throwPointsInner(node: string, edge?: string): Result {
    const il = this.sim.il;
    const outs = this.graph.outEdges(node);
    if (outs.length < 2) return this.done('', { ok: false, reason: 'Здесь нет стрелки' });
    const cur = il.pointPosition(node);
    const target = edge ?? outs[(outs.findIndex((e) => e.id === cur) + 1) % outs.length]?.id ?? '';
    return this.done(`Стрелка ${node} → ${target}`, il.throwPoints(node, target));
  }

  private train(id: string) {
    return this.sim.trains.find((t) => t.id === id);
  }

  holdTrain(id: string, on = true): Result {
    this.rec({ k: 'hold', id, v: on });
    return this.act(() => this.holdInner(id, on));
  }

  private holdInner(id: string, on: boolean): Result {
    const tr = this.train(id);
    if (!tr) return this.done('', { ok: false, reason: `Нет поезда ${id}` });
    tr.hold = on;
    return this.done(on ? `${id} задержан` : `${id}: задержка снята`, { ok: true });
  }

  sendTrain(id: string): Result {
    this.rec({ k: 'send', id });
    return this.act(() => this.sendInner(id));
  }

  private sendInner(id: string): Result {
    const tr = this.train(id);
    if (!tr) return this.done('', { ok: false, reason: `Нет поезда ${id}` });
    if (tr.phase !== 'dwell') return this.done('', { ok: false, reason: `${id} уже в пути` });
    tr.hold = false;
    tr.send = true;
    return this.done(`${id} отправлен`, { ok: true });
  }

  recallTrain(id: string): Result {
    this.rec({ k: 'recall', id });
    return this.act(() => this.done(`${id} → в депо`, this.disp.recall(id)));
  }

  /** Начать смену заново: сбросить и ручные режимы. */
  newShift(): void {
    this.manualLine = false;
    this.manualNodes.clear();
    this.reset(this.mode);
  }

  setInterval(sec: number): void {
    this.collectLog();
    this.rec({ k: 'interval', v: sec });
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
    this.stepCount++;
    if (this.stepCount % 20 === 0) {
      const st = this.status();
      const f = this.stats?.sample(this.sim.t, st.active, st.required, this.sim.trains);
      if (f) {
        this.addLog(f.t, f.text, 'warn');
        this.emit({ kind: 'alarm', player: false });
      }
    }
  }

  private emit(s: GameSignal): void {
    if (!this.muted) this.onSignal?.(s);
  }

  private rec(a: DistributiveOmit<Action, 'n'>): void {
    this.actions.push({ ...a, n: this.stepCount } as Action);
  }

  /** Игрок действует: запись для сохранения, сигнал для вибрации. */
  private act<T extends Result>(fn: () => T): T {
    this.player = true;
    try {
      const r = fn();
      if (r.ok) this.emit({ kind: 'action', player: true });
      return r;
    } finally {
      this.player = false;
    }
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

  collectLog(): void {
    const ev = this.sim.events;
    for (; this.logSeen < ev.length; this.logSeen++) {
      const e = ev[this.logSeen] as SimEvent;
      const f = this.stats.onEvent(e, this.interval);
      if (f) {
        this.addLog(f.t, f.text, 'warn');
        this.emit({ kind: 'alarm', player: false });
      }
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

  /** Данные для сохранения смены. */
  snapshot(): SaveData {
    return {
      v: 1,
      mode: this.mode,
      seed: this.seed,
      startInterval: this.startInterval,
      steps: this.stepCount,
      actions: this.actions.map((a) => ({ ...a })),
      savedAt: Date.now(),
    };
  }

  private applyAction(a: Action): void {
    switch (a.k) {
      case 'interval': this.setInterval(a.v); break;
      case 'lineManual': this.setLineManual(a.v); break;
      case 'nodeManual': this.setNodeManual(a.node, a.v); break;
      case 'route': this.setRoute(a.from, a.to); break;
      case 'cancel': this.cancelRoute(a.block); break;
      case 'points': this.throwPoints(a.node, a.edge); break;
      case 'hold': this.holdTrain(a.id, a.v); break;
      case 'send': this.sendTrain(a.id); break;
      case 'recall': this.recallTrain(a.id); break;
    }
  }

  /**
   * Восстановить смену: новая игра с теми же параметрами, действия игрока проигрываются на тех же шагах.
   * Выполняется порциями, чтобы не вешать интерфейс; `onProgress` получает долю 0..1.
   */
  static async restore(
    cfg: LineConfig,
    save: SaveData,
    onProgress?: (f: number) => void,
    chunk = 20000,
  ): Promise<Game> {
    const g = new Game(cfg, { mode: save.mode, interval: save.startInterval, seed: save.seed });
    g.muted = true;
    const queue = save.actions;
    let ai = 0;
    const tick = async (): Promise<void> => {
      onProgress?.(save.steps === 0 ? 1 : g.stepCount / save.steps);
      await new Promise((r) => setTimeout(r, 0));
    };
    let budget = chunk;
    while (g.stepCount < save.steps) {
      while (ai < queue.length && (queue[ai] as Action).n <= g.stepCount) g.applyAction(queue[ai++] as Action);
      g.stepOnce();
      if (g.stepCount % 500 === 0) g.collectLog();
      if (--budget <= 0) {
        budget = chunk;
        await tick();
      }
    }
    while (ai < queue.length) g.applyAction(queue[ai++] as Action);
    g.collectLog();
    g.muted = false;
    onProgress?.(1);
    return g;
  }
}
