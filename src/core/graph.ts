import type { EdgeConfig, LineConfig, StationConfig } from '../lines/schema';

const KMH = 1 / 3.6;

export interface Edge {
  id: string;
  from: string;
  to: string;
  length: number;
  /** Ограничение скорости, м/с. */
  limit: number;
  track?: string;
}

/** Путевой граф: узлы и направленные участки с длиной. */
export class Graph {
  readonly edges = new Map<string, Edge>();
  readonly stations: StationConfig[];
  private readonly out = new Map<string, Edge[]>();
  private readonly inc = new Map<string, Edge[]>();

  constructor(cfg: LineConfig) {
    const nodes = new Set(cfg.nodes);
    for (const e of cfg.edges) this.addEdge(e, nodes);
    for (const s of cfg.stations) {
      for (const st of s.stops) {
        const e = this.edges.get(st.edge);
        if (!e) throw new Error(`Станция ${s.id}: нет участка ${st.edge}`);
        if (st.at > e.length) throw new Error(`Станция ${s.id}: остановка за пределами ${e.id}`);
      }
    }
    this.stations = cfg.stations;
  }

  private addEdge(c: EdgeConfig, nodes: Set<string>): void {
    if (this.edges.has(c.id)) throw new Error(`Дубликат участка ${c.id}`);
    if (!nodes.has(c.from) || !nodes.has(c.to)) throw new Error(`Участок ${c.id}: неизвестный узел`);
    const e: Edge = { id: c.id, from: c.from, to: c.to, length: c.length, limit: c.speedKmh * KMH };
    if (c.track !== undefined) e.track = c.track;
    this.edges.set(c.id, e);
    const list = this.out.get(c.from) ?? [];
    list.push(e);
    this.out.set(c.from, list);
    const inList = this.inc.get(c.to) ?? [];
    inList.push(e);
    this.inc.set(c.to, inList);
  }

  /** Участки, выходящие из узла. */
  outEdges(node: string): Edge[] {
    return this.out.get(node) ?? [];
  }

  /** Участки, входящие в узел. */
  inEdges(node: string): Edge[] {
    return this.inc.get(node) ?? [];
  }

  edge(id: string): Edge {
    const e = this.edges.get(id);
    if (!e) throw new Error(`Нет участка ${id}`);
    return e;
  }

  /** Участки, выходящие из конца участка. */
  next(edgeId: string): Edge[] {
    return this.out.get(this.edge(edgeId).to) ?? [];
  }

  /** Кратчайший (по длине) маршрут от участка `from` до участка `to` включительно. */
  findPath(from: string, to: string): string[] {
    this.edge(from);
    this.edge(to);
    const dist = new Map<string, number>([[from, 0]]);
    const prev = new Map<string, string>();
    const todo = new Set<string>([from]);
    while (todo.size > 0) {
      let cur = '';
      let best = Infinity;
      for (const id of todo) {
        const d = dist.get(id) ?? Infinity;
        if (d < best) { best = d; cur = id; }
      }
      todo.delete(cur);
      if (cur === to) break;
      for (const n of this.next(cur)) {
        const nd = best + n.length;
        if (nd < (dist.get(n.id) ?? Infinity)) {
          dist.set(n.id, nd);
          prev.set(n.id, cur);
          todo.add(n.id);
        }
      }
    }
    if (!dist.has(to)) throw new Error(`Нет пути ${from} → ${to}`);
    const path = [to];
    while (path[0] !== from) path.unshift(prev.get(path[0] as string) as string);
    return path;
  }
}
