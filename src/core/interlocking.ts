import { aspectFor, type Aspect } from './alsars';
import type { Graph } from './graph';

/** Блок-участок: часть рельсового участка между соседними светофорами. */
export interface Block {
  id: string;
  edge: string;
  index: number;
  /** Смещения начала и конца вдоль участка, м. */
  s0: number;
  s1: number;
  fromNode: string;
  toNode: string;
  /** Вход закрыт маршрутным светофором (стрелочная горловина). */
  controlled: boolean;
}

/** Блок-участок в координатах пути поезда. */
export interface PathBlock {
  block: Block;
  s0: number;
  s1: number;
}

export type RouteResult = { ok: true } | { ok: false; reason: string };

export interface Route {
  id: string;
  owner: string;
  blocks: string[];
  /** Замкнутые стрелки: узел → выбранный участок. */
  points: Map<string, string>;
  /** Блоки, которые уже занимались поездом (для постепенного размыкания). */
  seen: Set<string>;
  /** Заданное время размыкания при отмене с замыканием приближения. */
  releaseAt?: number;
}

export interface InterlockingOptions {
  /** Максимальная длина блок-участка, м. */
  maxBlock?: number;
  /** Выдержка времени при отмене маршрута, замкнутого приближением, с. */
  approachDelay?: number;
}

export class Interlocking {
  readonly blocks = new Map<string, Block>();
  readonly routes = new Map<string, Route>();
  /** Нарушения: два состава в одном блок-участке и т. п. */
  readonly violations: string[] = [];
  readonly approachDelay: number;
  /** Растёт при любом изменении занятости или замыканий (для перерисовки). */
  version = 0;
  /** Вызывается, когда стрелка встала в новое положение. */
  onPoints: ((node: string, edge: string) => void) | undefined;
  private readonly byEdge = new Map<string, Block[]>();
  private readonly occupants = new Map<string, string[]>();
  private readonly blockLock = new Map<string, string>();
  private readonly pointLock = new Map<string, { edge: string; route: string }>();
  /** Текущее положение стрелок: узел → участок, на который они поставлены. */
  private readonly pointPos = new Map<string, string>();

  constructor(
    readonly graph: Graph,
    opts: InterlockingOptions = {},
  ) {
    const maxBlock = opts.maxBlock ?? 400;
    this.approachDelay = opts.approachDelay ?? 60;
    for (const e of graph.edges.values()) {
      const n = Math.max(1, Math.ceil(e.length / maxBlock));
      const len = e.length / n;
      const list: Block[] = [];
      for (let k = 0; k < n; k++) {
        const b: Block = {
          id: `${e.id}#${k}`,
          edge: e.id,
          index: k,
          s0: k * len,
          s1: (k + 1) * len,
          fromNode: e.from,
          toNode: e.to,
          controlled: k === 0 && (graph.outEdges(e.from).length > 1 || graph.inEdges(e.from).length > 1),
        };
        list.push(b);
        this.blocks.set(b.id, b);
      }
      this.byEdge.set(e.id, list);
    }
  }

  block(id: string): Block {
    const b = this.blocks.get(id);
    if (!b) throw new Error(`Нет блок-участка ${id}`);
    return b;
  }

  /** Блок-участки вдоль пути (список рельсовых участков) с координатами пути. */
  pathBlocks(edges: string[]): PathBlock[] {
    const res: PathBlock[] = [];
    let acc = 0;
    for (const eid of edges) {
      for (const b of this.byEdge.get(eid) ?? []) res.push({ block: b, s0: acc + b.s0, s1: acc + b.s1 });
      acc += this.graph.edge(eid).length;
    }
    return res;
  }

  // ---- занятость ----

  occupy(blockId: string, train: string): void {
    const list = this.occupants.get(blockId) ?? [];
    if (list.includes(train)) return;
    if (list.length > 0) this.violations.push(`Блок ${blockId}: ${train} въехал при ${list.join(',')}`);
    list.push(train);
    this.occupants.set(blockId, list);
    this.version++;
  }

  vacate(blockId: string, train: string): void {
    const list = this.occupants.get(blockId);
    if (!list) return;
    const i = list.indexOf(train);
    if (i >= 0) list.splice(i, 1);
    if (list.length === 0) this.occupants.delete(blockId);
    this.version++;
  }

  occupantsOf(blockId: string): readonly string[] {
    return this.occupants.get(blockId) ?? [];
  }

  /** Занят ли блок кем-то, кроме `except`. */
  isOccupied(blockId: string, except?: string): boolean {
    const list = this.occupants.get(blockId);
    return !!list && list.some((t) => t !== except);
  }

  /** Узлы со стрелками (из узла выходит больше одного участка). */
  switchNodes(): string[] {
    const res = new Set<string>();
    for (const b of this.blocks.values()) if (b.index === 0 && this.graph.outEdges(b.fromNode).length > 1) res.add(b.fromNode);
    return [...res];
  }

  /** Узлы с маршрутными светофорами (стрелки и слияния). */
  controlledNodes(): string[] {
    const res = new Set<string>();
    for (const b of this.blocks.values()) if (b.controlled) res.add(b.fromNode);
    return [...res];
  }

  /** Участок, на который сейчас поставлена стрелка узла. */
  pointPosition(node: string): string | undefined {
    return this.pointPos.get(node) ?? this.graph.outEdges(node)[0]?.id;
  }

  /** Можно ли перевести стрелки: не замкнуты маршрутом, за ними нет занятых блоков. */
  canThrow(node: string, owner?: string): RouteResult {
    if (this.pointLock.has(node)) return { ok: false, reason: `Стрелка ${node} замкнута маршрутом` };
    for (const e of this.graph.outEdges(node)) {
      const first = this.byEdge.get(e.id)?.[0];
      if (first && this.isOccupied(first.id, owner)) return { ok: false, reason: `Стрелка ${node}: участок ${first.id} занят` };
    }
    return { ok: true };
  }

  /** Перевести стрелки узла на участок `edge`. */
  throwPoints(node: string, edge: string): RouteResult {
    if (!this.graph.outEdges(node).some((e) => e.id === edge)) return { ok: false, reason: `Стрелка ${node}: нет участка ${edge}` };
    if (this.pointPosition(node) === edge) return { ok: true };
    const can = this.canThrow(node);
    if (!can.ok) return can;
    this.pointPos.set(node, edge);
    this.version++;
    this.onPoints?.(node, edge);
    return { ok: true };
  }

  /** Проходит ли поезд `train` через блок: маршрут замкнут на него или на любой поезд (`*`). */
  permits(blockId: string, train: string): boolean {
    const o = this.lockedBy(blockId);
    return o === train || o === '*';
  }

  lockedBy(blockId: string): string | undefined {
    const r = this.blockLock.get(blockId);
    return r === undefined ? undefined : this.routes.get(r)?.owner;
  }

  // ---- маршруты ----

  /** Установить и замкнуть маршрут по цепочке блок-участков. */
  setRoute(id: string, blockIds: string[], owner: string): RouteResult {
    if (this.routes.has(id)) return { ok: false, reason: `Маршрут ${id} уже установлен` };
    const points = new Map<string, string>();
    for (const bid of blockIds) {
      const b = this.block(bid);
      if (this.isOccupied(bid, owner)) return { ok: false, reason: `Участок ${bid} занят` };
      if (this.blockLock.has(bid)) return { ok: false, reason: `Участок ${bid} замкнут другим маршрутом` };
      if (b.index === 0 && this.graph.outEdges(b.fromNode).length > 1) {
        const have = this.pointLock.get(b.fromNode);
        if (have && have.edge !== b.edge) return { ok: false, reason: `Стрелка ${b.fromNode} замкнута в другом положении` };
        if (this.pointPosition(b.fromNode) !== b.edge) {
          const can = this.canThrow(b.fromNode, owner);
          if (!can.ok) return can;
        }
        points.set(b.fromNode, b.edge);
        // Защита фланга: соседние ветви не должны быть заняты.
        for (const other of this.graph.outEdges(b.fromNode)) {
          if (other.id === b.edge) continue;
          const first = this.byEdge.get(other.id)?.[0];
          if (first && this.isOccupied(first.id, owner)) {
            return { ok: false, reason: `Фланговая защита: занят ${first.id}` };
          }
        }
      }
    }
    const route: Route = { id, owner, blocks: [...blockIds], points, seen: new Set() };
    this.routes.set(id, route);
    for (const bid of blockIds) this.blockLock.set(bid, id);
    for (const [node, edge] of points) {
      this.pointLock.set(node, { edge, route: id });
      const prev = this.pointPosition(node);
      this.pointPos.set(node, edge);
      if (prev !== edge) this.onPoints?.(node, edge);
    }
    this.version++;
    return { ok: true };
  }

  /** Отменить маршрут. Если к нему приближается поезд — размыкание с выдержкой. */
  cancelRoute(id: string, now: number): RouteResult {
    const r = this.routes.get(id);
    if (!r) return { ok: false, reason: `Маршрут ${id} не установлен` };
    const first = this.block(r.blocks[0] as string);
    const approaching = this.predecessors(first).some((p) => this.isOccupied(p.id));
    const entered = r.seen.size > 0;
    if (approaching && !entered) {
      r.releaseAt = now + this.approachDelay;
      return { ok: false, reason: `Замыкание приближения: размыкание через ${this.approachDelay} с` };
    }
    for (const bid of [...r.blocks]) if (!r.seen.has(bid)) this.releaseBlock(r, bid);
    return { ok: true };
  }

  private predecessors(b: Block): Block[] {
    const res: Block[] = [];
    if (b.index > 0) {
      const prev = this.byEdge.get(b.edge)?.[b.index - 1];
      if (prev) res.push(prev);
      return res;
    }
    for (const e of this.graph.inEdges(b.fromNode)) {
      const list = this.byEdge.get(e.id);
      const last = list?.[list.length - 1];
      if (last) res.push(last);
    }
    return res;
  }

  private releaseBlock(r: Route, bid: string): void {
    const i = r.blocks.indexOf(bid);
    if (i < 0) return;
    r.blocks.splice(i, 1);
    this.blockLock.delete(bid);
    this.version++;
    const b = this.block(bid);
    const pl = this.pointLock.get(b.fromNode);
    if (b.index === 0 && pl && pl.route === r.id) this.pointLock.delete(b.fromNode);
    if (r.blocks.length === 0) this.routes.delete(r.id);
  }

  /** Постепенное размыкание и отложенная отмена. Вызывать каждый шаг. */
  update(now: number): void {
    for (const r of [...this.routes.values()]) {
      for (const bid of [...r.blocks]) {
        if (this.isOccupied(bid)) r.seen.add(bid);
        else if (r.seen.has(bid)) this.releaseBlock(r, bid);
      }
      if (this.routes.has(r.id) && r.releaseAt !== undefined && now >= r.releaseAt) {
        for (const bid of [...r.blocks]) if (!r.seen.has(bid)) this.releaseBlock(r, bid);
        r.releaseAt = undefined;
      }
    }
  }

  /** Маршрут, которому принадлежит замок блок-участка. */
  routeOf(blockId: string): Route | undefined {
    const id = this.blockLock.get(blockId);
    return id === undefined ? undefined : this.routes.get(id);
  }

  /** Занятые блок-участки. */
  occupiedBlocks(): string[] {
    return [...this.occupants.keys()];
  }

  /** Замкнутые маршрутом блок-участки. */
  lockedBlocks(): string[] {
    return [...this.blockLock.keys()];
  }

  /** Следующий блок-участок по ходу: следом на участке, иначе по замкнутой стрелке или единственный. */
  private following(b: Block): Block | undefined {
    const list = this.byEdge.get(b.edge);
    const nxt = list?.[b.index + 1];
    if (nxt) return nxt;
    const outs = this.graph.outEdges(b.toNode);
    const pl = this.pointLock.get(b.toNode);
    const e = outs.length === 1 ? outs[0] : outs.find((x) => x.id === pl?.edge);
    return e ? this.byEdge.get(e.id)?.[0] : undefined;
  }

  /** Показание светофора на входе в блок-участок (для отображения). */
  aspectOfBlock(blockId: string): Aspect {
    const b = this.block(blockId);
    if (this.isOccupied(b.id) || (b.controlled && !this.blockLock.has(b.id))) return 'red';
    let free = 0;
    let cur = this.following(b);
    while (cur && free < 2) {
      if (this.isOccupied(cur.id) || (cur.controlled && !this.blockLock.has(cur.id))) break;
      free++;
      cur = this.following(cur);
    }
    return aspectFor(true, cur || free >= 2 ? free : 2);
  }

  /** Проверка: нет пересекающихся маршрутов и стрелок в двух положениях. */
  conflicts(): string[] {
    const res: string[] = [];
    const seenBlocks = new Map<string, string>();
    const seenPoints = new Map<string, string>();
    for (const r of this.routes.values()) {
      for (const b of r.blocks) {
        const o = seenBlocks.get(b);
        if (o !== undefined && o !== r.id) res.push(`${b}: ${o} и ${r.id}`);
        seenBlocks.set(b, r.id);
      }
      for (const [n, e] of r.points) {
        const o = seenPoints.get(n);
        if (o !== undefined && o !== e) res.push(`стрелка ${n}: ${o} и ${e}`);
        seenPoints.set(n, e);
      }
    }
    return res;
  }

  /** Показание светофора на входе в блок по ходу `path` (цепочка блоков). */
  aspect(path: PathBlock[], index: number): Aspect {
    const pb = path[index];
    if (!pb) return 'red';
    const b = pb.block;
    const clear = !this.isOccupied(b.id) && (!b.controlled || this.blockLock.has(b.id));
    if (!clear) return 'red';
    let free = 0;
    for (let k = index + 1; k < path.length && free < 2; k++) {
      const nb = (path[k] as PathBlock).block;
      if (this.isOccupied(nb.id) || (nb.controlled && !this.blockLock.has(nb.id))) break;
      free++;
    }
    return aspectFor(true, free);
  }
}
