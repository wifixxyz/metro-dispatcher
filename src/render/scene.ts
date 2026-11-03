import { Container, Graphics, Text, type Application } from 'pixi.js';
import type { Viewport } from 'pixi-viewport';
import type { Game } from '../game';
import { formatClock } from '../game';
import { pointOnLine, sliceLine, trainShape, type Layout, type Line } from './layout';

const COLORS = {
  track: 0x4a5368,
  trackDim: 0x1c212c,
  platform: 0x2a3040,
  platformDim: 0x171b24,
  busy: 0xff4d4d,
  locked: 0xffd54a,
  accent: 0xde64a1,
  text: 0xaab2c0,
  green: 0x5ad19a,
  yellow: 0xf2c94c,
  red: 0xff5d5d,
} as const;

const ASPECT_COLOR = {
  green: 0x4cd964,
  yellow: 0xf2c94c,
  'red-yellow': 0xff9f43,
  red: 0xff4d4d,
} as const;

/** Минимальный масштаб, при котором показываем сигналы, подписи составов и часы. */
const LOD_DETAIL = 0.9;
const LOD_LABELS = 0.6;

export type Hit =
  | { kind: 'train'; id: string }
  | { kind: 'switch'; node: string }
  | { kind: 'signal'; block: string }
  /** Рядом есть светофор или стрелка, но масштаб слишком мелкий для точного касания. */
  | { kind: 'far' };

export interface SceneStats {
  trainsDrawn: number;
  edgesDrawn: number;
  signalsDrawn: number;
  frames: number;
}

interface TrainSprite {
  body: Graphics;
  label: Text;
}

export class Scene {
  readonly root = new Container();
  readonly stats: SceneStats = { trainsDrawn: 0, edgesDrawn: 0, signalsDrawn: 0, frames: 0 };
  private readonly tracks = new Graphics();
  private readonly overlay = new Graphics();
  private readonly signals = new Graphics();
  private readonly trainLayer = new Container();
  private readonly labelLayer = new Container();
  private readonly clockLayer = new Container();
  private readonly sprites = new Map<string, TrainSprite>();
  private readonly clocks: { text: Text; edge: string }[] = [];
  private readonly names: Text[] = [];
  private seenVersion = -1;
  private clockT = -Infinity;
  private game: Game;
  private readonly marks = new Graphics();
  /** Выбранный начальный светофор маршрута. */
  selected: string | undefined;
  private seenSel: string | undefined;
  private seenManual = '';
  private seenDetail = false;

  constructor(
    _app: Application,
    private readonly viewport: Viewport,
    private readonly layout: Layout,
    game: Game,
  ) {
    this.game = game;
    this.root.addChild(this.tracks, this.overlay, this.signals, this.marks, this.clockLayer, this.trainLayer, this.labelLayer);
    viewport.addChild(this.root);
    this.build();
  }

  /** Новая смена: пересобрать схему под режим. */
  setGame(game: Game): void {
    this.game = game;
    for (const s of this.sprites.values()) {
      s.body.destroy();
      s.label.destroy();
    }
    this.sprites.clear();
    this.build();
    this.seenVersion = -1;
  }

  private activeEdges(): Set<string> {
    return new Set(this.game.disp.routes.loop);
  }

  private build(): void {
    const { cfg, graph } = this.game;
    const active = this.activeEdges();
    const depot = cfg.depot;
    const depotEdges = new Set(depot ? [depot.entry, depot.exit, ...depot.tracks.map((t) => t.edge)] : []);
    const g = this.tracks;
    g.clear();
    let n = 0;
    // Платформы.
    for (const st of this.layout.stations) {
      const on = active.has(cfg.stations.find((s) => s.id === st.id)?.stops[0]?.edge ?? '');
      const fill = on ? COLORS.platform : COLORS.platformDim;
      const h = this.layout.trackHalf;
      if (st.platform === 'island') {
        g.rect(st.cx - st.half, -h + 4, st.half * 2, 2 * h - 8).fill({ color: fill });
      } else {
        g.rect(st.cx - st.half, -h - 9, st.half * 2, 6).fill({ color: fill });
        g.rect(st.cx - st.half, h + 3, st.half * 2, 6).fill({ color: fill });
      }
    }
    // Пути.
    for (const e of graph.edges.values()) {
      const line = this.layout.lines.get(e.id);
      if (!line) continue;
      const on = active.has(e.id) || (depotEdges.has(e.id));
      this.strokeLine(g, line, 0, 1, on ? COLORS.track : COLORS.trackDim, 3);
      n++;
    }
    this.stats.edgesDrawn = n;

    // Подписи станций и часы.
    for (const t of this.names) t.destroy();
    this.names.length = 0;
    for (const c of this.clocks) c.text.destroy();
    this.clocks.length = 0;
    for (const st of this.layout.stations) {
      const sc = cfg.stations.find((s) => s.id === st.id);
      const on = active.has(sc?.stops[0]?.edge ?? '');
      const label = new Text({
        text: st.name,
        style: { fill: COLORS.text, fontSize: 11, fontFamily: 'system-ui, sans-serif' },
      });
      label.anchor.set(0.5, 1);
      label.position.set(st.cx, -this.layout.trackHalf - 16);
      label.alpha = on ? 1 : 0.3;
      this.root.addChild(label);
      this.names.push(label);
      (sc?.stops ?? []).forEach((stop, i) => {
        const text = new Text({ text: '', style: { fill: COLORS.green, fontSize: 8, fontFamily: 'ui-monospace, monospace' } });
        text.anchor.set(0.5, i === 0 ? 1 : 0);
        text.position.set(st.cx, i === 0 ? -this.layout.trackHalf - 3 : this.layout.trackHalf + 3);
        text.visible = on;
        this.clockLayer.addChild(text);
        this.clocks.push({ text, edge: stop.edge });
      });
    }
  }

  private strokeLine(g: Graphics, line: Line, f0: number, f1: number, color: number, width: number): void {
    const pts = sliceLine(line, f0, f1);
    const first = pts[0];
    if (!first) return;
    g.moveTo(first.x, first.y);
    for (let i = 1; i < pts.length; i++) g.lineTo((pts[i] as { x: number }).x, (pts[i] as { y: number }).y);
    g.stroke({ width, color, cap: 'round', join: 'round' });
  }

  /** Вызывать каждый кадр после `game.advance`. */
  update(): void {
    this.stats.frames++;
    const { sim, graph, disp } = this.game;
    const il = sim.il;
    const scale = this.viewport.scale.x;
    const detail = scale >= LOD_DETAIL;

    const manualKey = `${this.game.manualLine}|${[...this.game.manualNodes].join(',')}`;
    if (il.version !== this.seenVersion || this.selected !== this.seenSel || manualKey !== this.seenManual || detail !== this.seenDetail) {
      this.seenVersion = il.version;
      this.seenSel = this.selected;
      this.seenManual = manualKey;
      this.seenDetail = detail;
      this.drawOverlay(detail);
    }
    this.signals.visible = true;
    this.clockLayer.visible = detail;
    this.labelLayer.visible = scale >= LOD_LABELS;

    // Составы.
    const alive = new Set<string>();
    let drawn = 0;
    for (const tr of sim.trains) {
      if (tr.phase === 'done') continue;
      alive.add(tr.id);
      let sp = this.sprites.get(tr.id);
      if (!sp) {
        const body = new Graphics();
        const label = new Text({
          text: tr.id.replace(/^\D+/, ''),
          style: { fill: 0xffffff, fontSize: 9, fontWeight: '600', fontFamily: 'system-ui, sans-serif' },
        });
        label.anchor.set(0.5, 1);
        this.trainLayer.addChild(body);
        this.labelLayer.addChild(label);
        sp = { body, label };
        this.sprites.set(tr.id, sp);
      }
      const { pts, dir } = trainShape(this.layout, graph, tr);
      const head = pts[pts.length - 1];
      if (!head || pts.length < 2) {
        sp.body.visible = false;
        sp.label.visible = false;
        continue;
      }
      sp.body.visible = true;
      sp.label.visible = true;
      const b = sp.body;
      b.clear();
      b.moveTo((pts[0] as { x: number }).x, (pts[0] as { y: number }).y);
      for (let i = 1; i < pts.length; i++) b.lineTo((pts[i] as { x: number }).x, (pts[i] as { y: number }).y);
      b.stroke({ width: 6, color: COLORS.accent, cap: 'butt', join: 'round' });
      // Стрелка направления на голове.
      const nx = -dir.y;
      const ny = dir.x;
      b.poly([
        head.x + dir.x * 7, head.y + dir.y * 7,
        head.x + nx * 5, head.y + ny * 5,
        head.x - nx * 5, head.y - ny * 5,
      ]).fill({ color: COLORS.accent });
      sp.label.position.set(head.x, head.y - 9);
      drawn++;
    }
    for (const [id, sp] of this.sprites) {
      if (alive.has(id)) continue;
      sp.body.destroy();
      sp.label.destroy();
      this.sprites.delete(id);
    }
    this.stats.trainsDrawn = drawn;

    // Интервальные часы: раз в секунду модельного времени.
    if (detail && sim.t - this.clockT >= 1) {
      this.clockT = sim.t;
      const h = this.game.interval;
      for (const c of this.clocks) {
        const last = disp.lastDepartAt(c.edge);
        if (last === undefined) {
          c.text.text = '';
          continue;
        }
        const since = sim.t - last;
        c.text.text = formatClock(since).slice(3);
        // Отклонение от интервала: зелёный в пределах ±15%, жёлтый до ±30%, дальше красный.
        const dev = Math.abs(since - h) / h;
        c.text.style.fill = since < h ? COLORS.text : dev <= 0.15 ? COLORS.green : dev <= 0.3 ? COLORS.yellow : COLORS.red;
      }
    }
  }

  private drawOverlay(detail: boolean): void {
    const { sim, graph } = this.game;
    const il = sim.il;
    const o = this.overlay;
    o.clear();
    for (const id of il.lockedBlocks()) this.strokeBlock(o, id, COLORS.locked, 4, graph.edge(il.block(id).edge).length);
    for (const id of il.occupiedBlocks()) this.strokeBlock(o, id, COLORS.busy, 5, graph.edge(il.block(id).edge).length);

    // Сигналы на входе в блок-участки активной части.
    const s = this.signals;
    s.clear();
    const active = this.activeEdges();
    let n = 0;
    for (const b of il.blocks.values()) {
      if (!active.has(b.edge)) continue;
      // Внутриучастковые светофоры — только при крупном масштабе; входы на участки и маршрутные — всегда.
      if (!detail && b.index > 0) continue;
      const line = this.layout.lines.get(b.edge);
      if (!line) continue;
      const len = graph.edge(b.edge).length;
      const { p, dir } = pointOnLine(line, b.s0 / len);
      const off = 7;
      const x = p.x + dir.y * off;
      const y = p.y - dir.x * off;
      const color = ASPECT_COLOR[il.aspectOfBlock(b.id)];
      const big = b.controlled;
      s.circle(x, y, big ? 4.5 : 3.2).fill({ color, alpha: 0.25 });
      s.circle(x, y, big ? 2.6 : 1.8).fill({ color });
      if (this.selected === b.id) s.circle(x, y, 7).stroke({ width: 1.5, color: 0xffffff });
      n++;
    }
    this.stats.signalsDrawn = n;

    // Стрелки: кольцо (зелёное — авто, оранжевое — ручной узел) и риска в сторону текущего положения.
    const m = this.marks;
    m.clear();
    for (const node of il.switchNodes()) {
      const p = this.layout.nodes.get(node);
      const pos = il.pointPosition(node);
      const line = pos ? this.layout.lines.get(pos) : undefined;
      if (!p || !line) continue;
      if (!active.has(pos ?? '') && !this.nodeActive(node, active)) continue;
      const color = this.game.isNodeManual(node) ? 0xff9f43 : 0x5ad19a;
      m.circle(p.x, p.y, 6).stroke({ width: 1.5, color });
      const d = pointOnLine(line, 0.02).p;
      const dx = d.x - p.x;
      const dy = d.y - p.y;
      const n2 = Math.hypot(dx, dy) || 1;
      m.moveTo(p.x, p.y).lineTo(p.x + (dx / n2) * 11, p.y + (dy / n2) * 11).stroke({ width: 2, color });
    }
  }

  private nodeActive(node: string, active: Set<string>): boolean {
    const g = this.game.graph;
    return [...g.outEdges(node), ...g.inEdges(node)].some((e) => active.has(e.id));
  }

  /** Что находится под точкой (мировые координаты); радиус касания — 22 экранных пикселя. */
  hitTest(wx: number, wy: number): Hit | undefined {
    const scale = this.viewport.scale.x;
    const r = 22 / scale;
    const detail = scale >= LOD_DETAIL;
    const { sim, graph } = this.game;
    const il = sim.il;
    const active = this.activeEdges();

    const nearest = (cands: { hit: Hit; x: number; y: number }[], radius: number): Hit | undefined => {
      let best: { hit: Hit; d: number } | undefined;
      for (const c of cands) {
        const d = Math.hypot(c.x - wx, c.y - wy);
        if (d <= radius && (!best || d < best.d)) best = { hit: c.hit, d };
      }
      return best?.hit;
    };
    const fixed: { hit: Hit; x: number; y: number }[] = [];
    for (const node of il.switchNodes()) {
      const p = this.layout.nodes.get(node);
      if (p && this.nodeActive(node, active)) fixed.push({ hit: detail ? { kind: 'switch', node } : { kind: 'far' }, x: p.x, y: p.y });
    }
    for (const b of il.blocks.values()) {
      if (!active.has(b.edge) || (!detail && b.index > 0)) continue;
      const pos = this.signalPos(b.id);
      if (pos) fixed.push({ hit: detail ? { kind: 'signal', block: b.id } : { kind: 'far' }, x: pos.x, y: pos.y });
    }
    // Точные цели (светофор, стрелка) важнее состава, который на них стоит.
    if (detail) {
      const exact = nearest(fixed, r * 0.5);
      if (exact) return exact;
    }
    const trains: { hit: Hit; x: number; y: number }[] = [];
    for (const tr of sim.trains) {
      if (tr.phase === 'done') continue;
      for (const p of trainShape(this.layout, graph, tr).pts) trains.push({ hit: { kind: 'train', id: tr.id }, x: p.x, y: p.y });
    }
    return nearest(trains, r) ?? nearest(fixed, r);
  }

  /** Экранные координаты сигнала (для тестов и подсказок). */
  signalScreen(blockId: string): { x: number; y: number } | undefined {
    const p = this.signalPos(blockId);
    if (!p) return undefined;
    const s = this.viewport.toScreen(p.x, p.y);
    return { x: s.x, y: s.y };
  }

  /** Привести точку в центр экрана с заданным масштабом. */
  focusNode(node: string, scale: number): void {
    const p = this.layout.nodes.get(node);
    if (!p) return;
    this.viewport.setZoom(scale, true);
    this.viewport.moveCenter(p.x, p.y);
  }

  trainHeadScreen(id: string): { x: number; y: number } | undefined {
    const tr = this.game.sim.trains.find((t) => t.id === id);
    if (!tr) return undefined;
    const { pts } = trainShape(this.layout, this.game.graph, tr);
    const h = pts[pts.length - 1];
    if (!h) return undefined;
    const s = this.viewport.toScreen(h.x, h.y);
    return { x: s.x, y: s.y };
  }

  switchScreen(node: string): { x: number; y: number } | undefined {
    const p = this.layout.nodes.get(node);
    if (!p) return undefined;
    const s = this.viewport.toScreen(p.x, p.y);
    return { x: s.x, y: s.y };
  }

  private signalPos(blockId: string): { x: number; y: number } | undefined {
    const b = this.game.sim.il.blocks.get(blockId);
    const line = b ? this.layout.lines.get(b.edge) : undefined;
    if (!b || !line) return undefined;
    const len = this.game.graph.edge(b.edge).length;
    const { p, dir } = pointOnLine(line, b.s0 / len);
    return { x: p.x + dir.y * 7, y: p.y - dir.x * 7 };
  }

  private strokeBlock(g: Graphics, id: string, color: number, width: number, edgeLen: number): void {
    const b = this.game.sim.il.block(id);
    const line = this.layout.lines.get(b.edge);
    if (!line) return;
    this.strokeLine(g, line, b.s0 / edgeLen, b.s1 / edgeLen, color, width);
  }
}
