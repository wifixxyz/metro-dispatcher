import { describe, expect, it } from 'vitest';
import { Game, formatClock } from '../src/game';
import { Graph } from '../src/core/graph';
import { Interlocking } from '../src/core/interlocking';
import { NEKRASOVSKAYA } from '../src/lines';
import { buildLayout, pointOnLine, sliceLine, trainShape } from '../src/render/layout';

const graph = () => new Graph(NEKRASOVSKAYA);

describe('схема линии', () => {
  const g = graph();
  const layout = buildLayout(NEKRASOVSKAYA, g);
  it('для каждого участка есть линия с конечными координатами', () => {
    expect(layout.lines.size).toBe(g.edges.size);
    for (const l of layout.lines.values()) {
      expect(l.len).toBeGreaterThan(0);
      for (const p of l.pts) {
        expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      }
    }
  });
  it('станции идут слева направо в порядке линии, расстояния растут', () => {
    const xs = layout.stations.map((s) => s.cx);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    for (let i = 1; i < xs.length; i++) expect((xs[i] as number) - (xs[i - 1] as number)).toBeGreaterThan(100);
  });
  it('путь I сверху и идёт на восток, путь II снизу и идёт на запад', () => {
    const i = layout.lines.get('ks-I')!;
    const ii = layout.lines.get('ks-II')!;
    expect(i.pts[0]!.x).toBeLessThan(i.pts.at(-1)!.x);
    expect(ii.pts[0]!.x).toBeGreaterThan(ii.pts.at(-1)!.x);
    expect(i.pts[0]!.y).toBeLessThan(ii.pts[0]!.y);
  });
  it('съезды оборота — дуги, депо — под Лухмановской', () => {
    expect(layout.lines.get('ng-turn')!.pts.length).toBeGreaterThan(5);
    const lh = layout.stations.find((s) => s.id === 'lh')!;
    for (const id of ['dep-a', 'dep-b']) {
      const p = layout.nodes.get(id)!;
      expect(Math.abs(p.x - lh.cx)).toBeLessThan(200);
      expect(p.y).toBeGreaterThan(50);
    }
  });
  it('соседние участки стыкуются в общих узлах', () => {
    for (const e of g.edges.values()) {
      const l = layout.lines.get(e.id)!;
      const a = layout.nodes.get(e.from)!;
      const b = layout.nodes.get(e.to)!;
      expect(Math.hypot(l.pts[0]!.x - a.x, l.pts[0]!.y - a.y)).toBeLessThan(1e-6);
      expect(Math.hypot(l.pts.at(-1)!.x - b.x, l.pts.at(-1)!.y - b.y)).toBeLessThan(1e-6);
    }
  });
  it('pointOnLine и sliceLine', () => {
    const l = layout.lines.get('ks-I')!;
    expect(pointOnLine(l, 0).p).toEqual(l.pts[0]);
    expect(pointOnLine(l, 1).p.x).toBeCloseTo(l.pts.at(-1)!.x);
    expect(pointOnLine(l, 0.5).dir.x).toBeCloseTo(1);
    const part = sliceLine(layout.lines.get('ng-turn')!, 0.25, 0.75);
    expect(part.length).toBeGreaterThanOrEqual(3);
  });
  it('состав: хвост позади головы, направление по ходу', () => {
    const game = new Game(NEKRASOVSKAYA, { mode: 'nk-ks', interval: 180 });
    const lay = buildLayout(NEKRASOVSKAYA, game.graph);
    for (const tr of game.sim.trains) {
      const { pts, dir } = trainShape(lay, game.graph, tr);
      expect(pts.length).toBeGreaterThanOrEqual(2);
      expect(Math.hypot(dir.x, dir.y)).toBeCloseTo(1);
      for (const p of pts) expect(Number.isFinite(p.x + p.y)).toBe(true);
    }
  });
});

describe('Game', () => {
  it('смена начинается с расчётным парком', () => {
    const game = new Game(NEKRASOVSKAYA, { mode: 'lh-ks', interval: 180 });
    expect(game.status().active).toBe(game.status().required);
    expect(game.status().missing).toBe(0);
    expect(game.sim.trains.length).toBe(game.status().required);
  });
  it('1× — реальное время, 8× — в восемь раз быстрее, пауза останавливает', () => {
    const game = new Game(NEKRASOVSKAYA, { mode: 'lh-ks', interval: 180 });
    const t0 = game.sim.t;
    for (let i = 0; i < 60; i++) game.advance(1 / 60);
    expect(Math.abs(game.sim.t - t0 - 1)).toBeLessThan(0.1);
    game.setSpeed(8);
    const t1 = game.sim.t;
    for (let i = 0; i < 60; i++) game.advance(1 / 60);
    expect(Math.abs(game.sim.t - t1 - 8)).toBeLessThan(0.1);
    game.togglePause();
    const t2 = game.sim.t;
    game.advance(1);
    expect(game.sim.t).toBe(t2);
  });
  it('смена режима сбрасывает смену; журнал пишет прибытия', () => {
    const game = new Game(NEKRASOVSKAYA, { mode: 'nk-ng', interval: 180 });
    game.setSpeed(8);
    for (let i = 0; i < 600; i++) game.advance(1 / 60);
    expect(game.log.some((l) => l.text.includes('прибыл'))).toBe(true);
    game.reset('lh-ok');
    expect(game.mode).toBe('lh-ok');
    expect(game.log.map((l) => l.text)).toEqual(['Смена начата']);
  });
  it('смена интервала меняет расчётный парк', () => {
    const game = new Game(NEKRASOVSKAYA, { mode: 'lh-ok', interval: 300 });
    const r5 = game.status().required;
    game.setInterval(120);
    expect(game.status().required).toBeGreaterThan(r5);
  });
  it('formatClock', () => {
    expect(formatClock(3725.9)).toBe('01:02:05');
  });
});

describe('светофоры для отображения', () => {
  it('aspectOfBlock: свободный путь зелёный, занятый впереди — жёлтый/красно-жёлтый, занятый — красный', () => {
    const g = graph();
    const il = new Interlocking(g, { maxBlock: 400 });
    const blocks = il.pathBlocks(['nk-lh-I']);
    const id = (i: number) => blocks[i]!.block.id;
    expect(il.aspectOfBlock(id(0))).toBe('green');
    il.occupy(id(3), 'T');
    expect(il.aspectOfBlock(id(1))).toBe('yellow');
    expect(il.aspectOfBlock(id(2))).toBe('red-yellow');
    expect(il.aspectOfBlock(id(3))).toBe('red');
    expect(il.version).toBeGreaterThan(0);
  });
});
