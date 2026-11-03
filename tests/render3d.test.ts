import { describe, expect, it } from 'vitest';
import { Game } from '../src/game';
import { Graph } from '../src/core/graph';
import { Interlocking } from '../src/core/interlocking';
import { NEKRASOVSKAYA } from '../src/lines';
import { buildStatic } from '../src/render3d/build';
import { LEVEL, buildLayout3d, edgePoint, heightAt, sampleBack, trainPolyline } from '../src/render3d/layout3d';
import { Governor } from '../src/render3d/quality';
import { makeMiniLine } from './helpers/miniLine';

const g = new Graph(NEKRASOVSKAYA);
const l3 = buildLayout3d(NEKRASOVSKAYA, g);

describe('3D-геометрия из конфига', () => {
  it('станции расставлены в реальных метрах: расстояние между станциями = длина перегона', () => {
    const st = l3.plan.stations;
    const lh = st.find((s) => s.id === 'lh')!;
    const nk = st.find((s) => s.id === 'nk')!;
    // Платформа 160 м → полудлина 80; перегон Некрасовка–Лухмановская 1600 м.
    expect(lh.cx - nk.cx).toBeCloseTo(80 + 1600 + 80);
    const total = st.at(-1)!.cx - st[0]!.cx;
    expect(total).toBeGreaterThan(13000);
  });
  it('длина ломаной участка совпадает с длиной участка (кроме съездов и депо)', () => {
    for (const e of g.edges.values()) {
      if (e.track === 'turn' || e.track === 'depot') continue;
      expect(l3.plan.lines.get(e.id)!.len).toBeCloseTo(e.length, 0);
    }
  });
  it('сооружения: эстакада у первых станций, тоннель дальше; платформы плоские', () => {
    expect(l3.structure.get('nk-I')).toBe('viaduct');
    expect(l3.structure.get('ng-I')).toBe('tunnel');
    for (const st of NEKRASOVSKAYA.stations) {
      for (const s of st.stops) {
        const [a, b] = l3.heights.get(s.edge)!;
        expect(a).toBe(b);
      }
    }
    expect(heightAt(l3, 'nk-I', 0.5)).toBe(LEVEL.viaduct);
    expect(heightAt(l3, 'ng-I', 0.5)).toBe(LEVEL.tunnel);
  });
  it('на перегоне между эстакадой и тоннелем высота плавно меняется', () => {
    const e = 'ud-ks-I';
    const hs = [0, 0.25, 0.5, 0.75, 1].map((f) => heightAt(l3, e, f));
    for (let i = 1; i < hs.length; i++) expect(hs[i]!).toBeLessThanOrEqual(hs[i - 1]!);
    expect(hs[0]).toBe(LEVEL.viaduct);
    expect(hs.at(-1)).toBe(LEVEL.tunnel);
  });
  it('edgePoint: направление единичное, путь непрерывен между участками', () => {
    for (const e of g.edges.values()) {
      const a = edgePoint(l3, e.id, 0.3);
      expect(Math.hypot(a.dir.x, a.dir.y, a.dir.z)).toBeCloseTo(1, 5);
    }
    const end = edgePoint(l3, 'nk-I', 1).p;
    const start = edgePoint(l3, 'nk-lh-I', 0).p;
    expect(Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z)).toBeLessThan(1e-6);
  });
  it('состав: длина ломаной ≈ длине состава, хвост позади головы', () => {
    const game = new Game(NEKRASOVSKAYA, { mode: 'nk-ng', interval: 180 });
    const lay = buildLayout3d(NEKRASOVSKAYA, game.graph);
    let checked = 0;
    for (const tr of game.sim.trains) {
      const pts = trainPolyline(lay, game.graph, tr);
      expect(pts.length).toBeGreaterThanOrEqual(2);
      let len = 0;
      for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y, pts[i]!.z - pts[i - 1]!.z);
      // На прямых — длина состава; на съездах и депо геометрия сжата, поэтому только верхняя граница.
      expect(len).toBeLessThanOrEqual(tr.params.lengthM + 1);
      if (tr.eh === tr.et && !['turn', 'depot'].includes(game.graph.edge(tr.route[tr.eh]!).track ?? '')) {
        expect(len).toBeGreaterThan(tr.params.lengthM - 15);
        checked++;
      }
      const s = sampleBack(pts, 5)!;
      expect(Math.hypot(s.dir.x, s.dir.y, s.dir.z)).toBeCloseTo(1, 5);
    }
    expect(checked).toBeGreaterThan(0);
  });
  it('sampleBack на расстоянии 0 даёт голову', () => {
    const pts = [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }];
    expect(sampleBack(pts, 0)!.p.x).toBeCloseTo(10);
    expect(sampleBack(pts, 4)!.p.x).toBeCloseTo(6);
    expect(sampleBack([pts[0]!], 1)).toBeUndefined();
  });
  it('учебная линия тоже строится (без правок кода)', () => {
    const cfg = makeMiniLine(4);
    const lay = buildLayout3d(cfg, new Graph(cfg));
    expect(lay.plan.lines.size).toBe(cfg.edges.length);
    expect(lay.structure.get('s0-I')).toBe('ground');
  });
});

describe('статическая сцена', () => {
  const game = new Game(NEKRASOVSKAYA, { mode: 'lh-ok', interval: 180 });
  const active = new Set(game.disp.routes.loop);
  const il = new Interlocking(g, { maxBlock: 400 });
  const stat = buildStatic(NEKRASOVSKAYA, g, l3, il, active, false);
  it('бюджет геометрии для телефона: ≤ 120 тыс. треугольников, ≤ 20 объектов', () => {
    expect(stat.stats.triangles).toBeGreaterThan(5000);
    expect(stat.stats.triangles).toBeLessThan(120_000);
    expect(stat.stats.objects).toBeLessThanOrEqual(20);
  });
  it('светофор на входе в каждый блок-участок активной части', () => {
    const n = [...il.blocks.values()].filter((b) => active.has(b.edge)).length;
    expect(stat.signalBlocks).toHaveLength(n);
    expect(n).toBeGreaterThan(30);
  });
  it('неиспользуемая часть режима не получает светофоров', () => {
    expect(stat.signalBlocks.some((b) => b.startsWith('nk-I#'))).toBe(false);
    expect(stat.signalBlocks.some((b) => b.startsWith('ks-I#') || b.startsWith('lh-I#'))).toBe(true);
  });
});

describe('регулятор качества', () => {
  it('при медленных кадрах снижает разрешение, при быстрых возвращает', () => {
    const gov = new Governor(1.5, 0.5, 28, 1.5);
    let r = 1.5;
    for (let i = 0; i < 200; i++) r = gov.frame(60) ?? r;
    expect(gov.ratio).toBeLessThan(1.5);
    expect(gov.ratio).toBeGreaterThanOrEqual(0.5);
    const low = gov.ratio;
    for (let i = 0; i < 400; i++) gov.frame(8);
    expect(gov.ratio).toBeGreaterThan(low);
    expect(gov.ratio).toBeLessThanOrEqual(1.5);
    void r;
  });
  it('в бюджете — не трогает', () => {
    const gov = new Governor(1, 0.5, 28);
    for (let i = 0; i < 100; i++) gov.frame(22);
    expect(gov.ratio).toBe(1);
  });
});
