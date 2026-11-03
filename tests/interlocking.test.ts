import { describe, expect, it } from 'vitest';
import { aspectFor, codeSpeed } from '../src/core/alsars';
import { Graph } from '../src/core/graph';
import { Interlocking } from '../src/core/interlocking';
import { Sim } from '../src/core/sim';
import type { LineConfig } from '../src/lines/schema';

/**
 * Развилка: p1 и p2 сливаются в узле k, участок o, затем расхождение в узле j на u / v.
 *   a ─ p1 ─┐          ┌─ u ─ ue
 *           k ── o ── j
 *   b ─ p2 ─┘          └─ v ─ ve
 */
const Y: LineConfig = {
  id: 'y', name: 'y',
  nodes: ['a', 'b', 'k', 'j', 'ue', 've'],
  edges: [
    { id: 'p1', from: 'a', to: 'k', length: 400, speedKmh: 60 },
    { id: 'p2', from: 'b', to: 'k', length: 400, speedKmh: 60 },
    { id: 'o', from: 'k', to: 'j', length: 400, speedKmh: 60 },
    { id: 'u', from: 'j', to: 'ue', length: 400, speedKmh: 60 },
    { id: 'v', from: 'j', to: 've', length: 400, speedKmh: 60 },
  ],
  stations: [
    { id: 'sa', name: 'A', platform: 'island', stops: [{ edge: 'p1', at: 350 }] },
    { id: 'sb', name: 'B', platform: 'island', stops: [{ edge: 'p2', at: 350 }] },
    { id: 'su', name: 'U', platform: 'island', stops: [{ edge: 'u', at: 350 }] },
    { id: 'sv', name: 'V', platform: 'island', stops: [{ edge: 'v', at: 350 }] },
  ],
};
const il = () => new Interlocking(new Graph(Y), { maxBlock: 400 });

describe('АЛС-АРС', () => {
  it('коды: 80 / 60 / 40 по числу свободных блоков', () => {
    expect(codeSpeed(5) * 3.6).toBeCloseTo(80);
    expect(codeSpeed(2) * 3.6).toBeCloseTo(80);
    expect(codeSpeed(1) * 3.6).toBeCloseTo(60);
    expect(codeSpeed(0) * 3.6).toBeCloseTo(40);
  });
  it('показания светофора', () => {
    expect(aspectFor(false, 3)).toBe('red');
    expect(aspectFor(true, 0)).toBe('red-yellow');
    expect(aspectFor(true, 1)).toBe('yellow');
    expect(aspectFor(true, 2)).toBe('green');
  });
  it('светофор меняется с маршрутом и занятостью блоков впереди', () => {
    const i = il();
    // path[0] = p1#0 (обычный), path[1] = o#0 (управляемый), path[2] = u#0 (управляемый)
    const path = i.pathBlocks(['p1', 'o', 'u']);
    expect(i.aspect(path, 1)).toBe('red'); // нет маршрута
    expect(i.setRoute('r', ['o#0', 'u#0'], 'T').ok).toBe(true);
    expect(i.aspect(path, 1)).toBe('yellow'); // за o#0 свободен только u#0 (дальше конец пути)
    i.occupy('u#0', 'X');
    expect(i.aspect(path, 1)).toBe('red-yellow');
    i.occupy('o#0', 'Y');
    expect(i.aspect(path, 1)).toBe('red');
  });
});

describe('интерлокинг: маршруты', () => {
  it('длинные участки делятся на блок-участки', () => {
    const i = new Interlocking(new Graph(Y), { maxBlock: 150 });
    expect(i.pathBlocks(['o'])).toHaveLength(3);
  });
  it('конфликтующие маршруты (слияние) не открываются одновременно', () => {
    const i = il();
    expect(i.setRoute('r1', ['o#0'], 'T1').ok).toBe(true);
    expect(i.setRoute('r2', ['o#0'], 'T2').ok).toBe(false);
    expect(i.conflicts()).toEqual([]);
  });
  it('стрелка замкнута в одном положении: маршрут по другой ветви отклонён', () => {
    const i = il();
    expect(i.setRoute('r1', ['u#0'], 'T1').ok).toBe(true);
    expect(i.setRoute('r2', ['v#0'], 'T2')).toEqual({ ok: false, reason: 'Стрелка j замкнута в другом положении' });
  });
  it('защита фланга: занятая соседняя ветвь не даёт замкнуть маршрут', () => {
    const i = il();
    i.occupy('v#0', 'T9');
    const r = i.setRoute('r1', ['u#0'], 'T1');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/Фланговая защита/);
  });
  it('занятый блок нельзя замкнуть', () => {
    const i = il();
    i.occupy('o#0', 'T9');
    expect(i.setRoute('r1', ['o#0'], 'T1').ok).toBe(false);
  });
  it('постепенное размыкание: блок отпускается, когда поезд его покинул', () => {
    const i = il();
    i.setRoute('r', ['o#0', 'u#0'], 'T');
    i.occupy('o#0', 'T');
    i.update(1);
    expect(i.lockedBy('o#0')).toBe('T');
    i.occupy('u#0', 'T');
    i.vacate('o#0', 'T');
    i.update(2);
    expect(i.lockedBy('o#0')).toBeUndefined();
    expect(i.lockedBy('u#0')).toBe('T');
    i.vacate('u#0', 'T');
    i.update(3);
    expect(i.routes.size).toBe(0);
  });
  it('отмена маршрута без приближения — сразу', () => {
    const i = il();
    i.setRoute('r', ['u#0'], 'T');
    expect(i.cancelRoute('r', 0).ok).toBe(true);
    expect(i.setRoute('r2', ['v#0'], 'T2').ok).toBe(true);
  });
  it('замыкание приближения: отмена с выдержкой 60 с', () => {
    const i = il();
    i.setRoute('r', ['o#0'], 'T');
    i.occupy('p1#0', 'T'); // поезд подходит
    expect(i.cancelRoute('r', 100).ok).toBe(false);
    i.update(150);
    expect(i.lockedBy('o#0')).toBe('T');
    i.update(160);
    expect(i.lockedBy('o#0')).toBeUndefined();
  });
  it('занятие блока двумя поездами фиксируется как нарушение', () => {
    const i = il();
    i.occupy('o#0', 'A');
    i.occupy('o#0', 'B');
    expect(i.violations).toHaveLength(1);
  });
});

describe('несколько поездов на развилке (автомат ставит маршруты)', () => {
  it('поезда со слияния проходят по очереди без нарушений', () => {
    const sim = new Sim(new Graph(Y), { dwell: 5, dwellJitter: 0, maxBlock: 400 });
    const t1 = sim.addTrain('A', ['p1', 'o', 'u']);
    const t2 = sim.addTrain('B', ['p2', 'o', 'v']);
    sim.runUntil(900);
    expect(t1.phase).toBe('done');
    expect(t2.phase).toBe('done');
    expect(sim.il.violations).toEqual([]);
    expect(sim.il.routes.size).toBe(0);
  });
});

describe('экстренное торможение', () => {
  it('внезапное препятствие в пределах служебного тормозного пути → emergency, остановка до блока', () => {
    const sim = new Sim(new Graph(Y), { dwell: 0, dwellJitter: 0, maxBlock: 400 });
    const t = sim.addTrain('A', ['p1', 'o', 'u']);
    while (t.speed < 15) sim.step();
    const k = t.hi + 1;
    const limit = t.pb[k]?.s0 as number;
    // Поставим препятствие, когда до границы чуть больше экстренного тормозного пути.
    while (limit - 5 - t.pos > 15 * 15 / (2 * 1.3) + 10) sim.step();
    sim.il.occupy(t.pb[k]?.block.id as string, 'obstacle');
    let maxPos = 0;
    for (let i = 0; i < 1000; i++) {
      sim.step();
      maxPos = Math.max(maxPos, t.pos);
    }
    expect(sim.events.some((e) => e.type === 'emergency')).toBe(true);
    expect(maxPos).toBeLessThan(limit);
  });
});
