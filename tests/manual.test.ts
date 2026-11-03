import { describe, expect, it } from 'vitest';
import { Game } from '../src/game';
import { Graph } from '../src/core/graph';
import { Interlocking } from '../src/core/interlocking';
import { Sim, createRng } from '../src/core/sim';
import { NEKRASOVSKAYA } from '../src/lines';
import type { LineConfig } from '../src/lines/schema';

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
    { id: 'su', name: 'U', platform: 'island', stops: [{ edge: 'u', at: 350 }] },
  ],
};

describe('стрелки', () => {
  const il = () => new Interlocking(new Graph(Y), { maxBlock: 400 });
  it('перевод свободной стрелки', () => {
    const i = il();
    expect(i.pointPosition('j')).toBe('u');
    expect(i.throwPoints('j', 'v')).toEqual({ ok: true });
    expect(i.pointPosition('j')).toBe('v');
  });
  it('нельзя: участок занят', () => {
    const i = il();
    i.occupy('u#0', 'T');
    expect(i.throwPoints('j', 'v').ok).toBe(false);
    expect(i.pointPosition('j')).toBe('u');
  });
  it('нельзя: стрелка замкнута маршрутом', () => {
    const i = il();
    i.setRoute('r', ['u#0'], 'T');
    const r = i.throwPoints('j', 'v');
    expect(r.ok).toBe(false);
  });
  it('маршрут сам переводит свободную стрелку; занятую — отказ', () => {
    const i = il();
    expect(i.setRoute('r', ['v#0'], 'T').ok).toBe(true);
    expect(i.pointPosition('j')).toBe('v');
    const i2 = il();
    i2.occupy('u#0', 'X');
    expect(i2.setRoute('r', ['v#0'], 'T').ok).toBe(false);
  });
  it('маршрут «для любого поезда» (*)', () => {
    const i = il();
    i.setRoute('m', ['o#0'], '*');
    expect(i.permits('o#0', 'whoever')).toBe(true);
    expect(i.permits('o#0', 'x')).toBe(true);
  });
});

describe('ручной узел в симуляции', () => {
  it('без маршрута поезд стоит перед светофором, с маршрутом игрока проходит', () => {
    const sim = new Sim(new Graph(Y), { dwell: 5, dwellJitter: 0, maxBlock: 400 });
    sim.manualNodes.add('k');
    const t = sim.addTrain('A', ['p1', 'o', 'u']);
    sim.runUntil(300);
    expect(t.phase).not.toBe('done');
    expect(t.pos).toBeLessThan(400);
    expect(t.speed).toBe(0);
    expect(sim.il.setRoute('m', ['o#0'], '*').ok).toBe(true);
    sim.runUntil(900);
    expect(t.phase).toBe('done');
    expect(sim.il.violations).toEqual([]);
  });
  it('удержание и отправка поезда', () => {
    const sim = new Sim(new Graph(Y), { dwell: 5, dwellJitter: 0, maxBlock: 400 });
    const t = sim.addTrain('A', ['p1', 'o', 'u']);
    t.hold = true;
    sim.runUntil(100);
    expect(t.phase).toBe('dwell');
    t.hold = false;
    t.send = true;
    sim.runUntil(102);
    expect(t.phase).toBe('run');
  });
});

describe('Game: ручное управление', () => {
  it('ручная линия: автомат не выпускает составы, стрелки не ставятся сами', () => {
    const g = new Game(NEKRASOVSKAYA, { mode: 'lh-ks', interval: 180 });
    g.setLineManual(true);
    expect(g.disp.auto).toBe(false);
    const spawned = g.disp.spawnLog.length;
    g.setInterval(120);
    g.setSpeed(8);
    for (let i = 0; i < 1500; i++) g.advance(1 / 60);
    expect(g.disp.spawnLog.length).toBe(spawned);
    expect(g.sim.il.violations).toEqual([]);
    expect(g.interventions).toBeGreaterThanOrEqual(1);
    // Поезда встали у маршрутных светофоров.
    expect(g.sim.trains.some((t) => t.phase === 'run' && t.waitT > 60)).toBe(true);
  });
  it('маршрут: два светофора, отказ при занятости и объяснение', () => {
    const g = new Game(NEKRASOVSKAYA, { mode: 'nk-ng', interval: 180 });
    const bad = g.setRoute('lh-ud-I#0', 'lh-ud-I#0');
    expect(bad.ok).toBe(false);
    const r = g.setRoute('lh-ud-I#0', 'lh-ud-I#1');
    if (!r.ok) expect(r.reason).toMatch(/занят|замкнут/);
    expect(g.log.length).toBeGreaterThan(0);
    const wrongWay = g.setRoute('lh-ud-I#1', 'lh-ud-I#0');
    expect(wrongWay.ok).toBe(false);
  });
  it('отмена маршрута игрока', () => {
    const g = new Game(NEKRASOVSKAYA, { mode: 'nk-ng', interval: 180 });
    g.setLineManual(true);
    g.sim.il.violations.length = 0;
    // Найдём свободный маршрутный светофор без приближающихся составов.
    const start = 'ks-turn#0';
    const r = g.setRoute(start, 'ks-II#0');
    if (r.ok) {
      expect(g.sim.il.routeOf(start)).toBeDefined();
      const c = g.cancelRoute(start);
      expect(c.ok || /приближения/.test((c as { reason: string }).reason)).toBe(true);
    }
    expect(g.cancelRoute('ng-I#0').ok).toBe(false);
  });
  it('задержать / отправить / вернуть в депо', () => {
    const g = new Game(NEKRASOVSKAYA, { mode: 'lh-ok', interval: 180 });
    const dwelling = g.sim.trains.find((t) => t.phase === 'dwell');
    const id = (dwelling ?? g.sim.trains[0])!.id;
    expect(g.holdTrain(id).ok).toBe(true);
    expect(g.holdTrain('нет').ok).toBe(false);
    g.holdTrain(id, false);
    expect(g.recallTrain(id).ok).toBe(true);
    expect(g.recallTrain(id).ok).toBe(false);
    g.setSpeed(8);
    for (let i = 0; i < 1000; i++) g.advance(0.5);
    expect(g.sim.trains.some((t) => t.id === id)).toBe(false);
    expect(g.sim.il.violations).toEqual([]);
  });
  it('перевод стрелки через Game', () => {
    const g = new Game(NEKRASOVSKAYA, { mode: 'nk-ng', interval: 300 });
    expect(g.throwPoints('ng-turn').ok).toBe(false);
    const r = g.throwPoints('ks-I-out');
    expect(typeof r.ok).toBe('boolean');
  });
});

describe('Интерлокинг не даёт игроку конфликтов (случайные действия)', () => {
  it.each([1, 2, 3])('seed %i: 2 ч, случайные вмешательства', (seed) => {
    const g = new Game(NEKRASOVSKAYA, { mode: 'lh-ok', interval: 180, seed });
    const rnd = createRng(seed);
    const nodes = g.sim.il.controlledNodes();
    const blocks = [...g.sim.il.blocks.values()].filter((b) => b.controlled || b.index === 0).map((b) => b.id);
    g.setSpeed(8);
    let conflicts = 0;
    for (let k = 0; k < 7200 / 5; k++) {
      for (let i = 0; i < 100; i++) g.advance(0.05 / 8 * 8 / 1); // ≈ 5 с модели
      const r = rnd();
      if (r < 0.25) g.setRoute(blocks[Math.floor(rnd() * blocks.length)]!, blocks[Math.floor(rnd() * blocks.length)]!);
      else if (r < 0.35) g.cancelRoute(blocks[Math.floor(rnd() * blocks.length)]!);
      else if (r < 0.5) g.throwPoints(nodes[Math.floor(rnd() * nodes.length)]!);
      else if (r < 0.6) g.setNodeManual(nodes[Math.floor(rnd() * nodes.length)]!, rnd() < 0.5);
      else if (r < 0.7) g.holdTrain(g.sim.trains[Math.floor(rnd() * g.sim.trains.length)]?.id ?? '', rnd() < 0.5);
      else if (r < 0.8) g.sendTrain(g.sim.trains[Math.floor(rnd() * g.sim.trains.length)]?.id ?? '');
      else if (r < 0.82) g.recallTrain(g.sim.trains[Math.floor(rnd() * g.sim.trains.length)]?.id ?? '');
      conflicts += g.sim.il.conflicts().length;
    }
    expect(g.sim.il.violations).toEqual([]);
    expect(conflicts).toBe(0);
    expect(g.sim.events.filter((e) => e.type === 'emergency')).toEqual([]);
  }, 120000);
});
