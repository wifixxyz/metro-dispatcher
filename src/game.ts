import { Dispatcher, type DispatcherStatus } from './core/dispatcher';
import { Graph } from './core/graph';
import { Sim, type SimEvent } from './core/sim';
import type { LineConfig } from './lines/schema';

export const SPEEDS = [1, 2, 4, 8] as const;
export const INTERVALS = [120, 180, 300] as const;

export type Result = { ok: true } | { ok: false; reason: string };

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
    this.interventions = 0;
    this.applyManual();
    this.log.length = 0;
    this.logSeen = 0;
    const limit = 3 * 3600;
    while (this.sim.t < limit && (this.disp.active < this.disp.required || this.sim.t < 60)) this.stepOnce();
    this.sim.events.length = 0;
    this.disp.resetEventCursor();
    this.logSeen = 0;
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
    this.manualLine = on;
    this.applyManual();
    this.interventions++;
    this.addLog(this.sim.t, on ? 'Линия: ручной режим' : 'Линия: автомат', 'info');
  }

  setNodeManual(node: string, on: boolean): void {
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
    return this.done(`Маршрут ${from} → ${to}`, r);
  }

  /** Отменить маршрут, замкнутый на блок-участок (с выдержкой при замыкании приближения). */
  cancelRoute(blockId: string): Result {
    const r = this.sim.il.routeOf(blockId);
    if (!r) return this.done('', { ok: false, reason: 'Маршрут не установлен' });
    return this.done(`Маршрут ${r.id} отменён`, this.sim.il.cancelRoute(r.id, this.sim.t));
  }

  throwPoints(node: string, edge?: string): Result {
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
    const tr = this.train(id);
    if (!tr) return this.done('', { ok: false, reason: `Нет поезда ${id}` });
    tr.hold = on;
    return this.done(on ? `${id} задержан` : `${id}: задержка снята`, { ok: true });
  }

  sendTrain(id: string): Result {
    const tr = this.train(id);
    if (!tr) return this.done('', { ok: false, reason: `Нет поезда ${id}` });
    if (tr.phase !== 'dwell') return this.done('', { ok: false, reason: `${id} уже в пути` });
    tr.hold = false;
    tr.send = true;
    return this.done(`${id} отправлен`, { ok: true });
  }

  recallTrain(id: string): Result {
    return this.done(`${id} → в депо`, this.disp.recall(id));
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
