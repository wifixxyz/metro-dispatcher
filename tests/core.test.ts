import { describe, expect, it } from 'vitest';
import { Graph } from '../src/core/graph';
import { DEFAULT_TRAIN, brakingDistance, speedForDistance, tractionAccel } from '../src/core/physics';
import { Sim, createRng } from '../src/core/sim';
import { NEKRASOVSKAYA, loadLine } from '../src/lines';

const graph = () => new Graph(NEKRASOVSKAYA);

describe('конфиг и граф', () => {
  it('8 станций по порядку', () => {
    expect(NEKRASOVSKAYA.stations.map((s) => s.name)).toEqual([
      'Некрасовка', 'Лухмановская', 'Улица Дмитриевского', 'Косино',
      'Юго-Восточная', 'Окская', 'Стахановская', 'Нижегородская',
    ]);
  });
  it('первые 4 станции островные, остальные береговые', () => {
    expect(NEKRASOVSKAYA.stations.map((s) => s.platform)).toEqual([
      'island', 'island', 'island', 'island', 'shore', 'shore', 'shore', 'shore',
    ]);
  });
  it('zod отклоняет плохой конфиг', () => {
    expect(() => loadLine({ id: 'x' })).toThrow();
  });
  it('граф отклоняет участок с неизвестным узлом', () => {
    expect(() => new Graph({ ...NEKRASOVSKAYA, nodes: [] })).toThrow();
  });
  it('путь Некрасовка I → Некрасовка II проходит все станции и оборот', () => {
    const path = graph().findPath('nk-I', 'nk-II');
    expect(path).toContain('ng-turn');
    expect(path).toContain('st-ng-I');
    expect(path.at(-1)).toBe('nk-II');
  });
  it('нет пути → ошибка', () => {
    const cfg = {
      id: 't', name: 't', nodes: ['a', 'b', 'c'],
      edges: [
        { id: 'ab', from: 'a', to: 'b', length: 100, speedKmh: 40 },
        { id: 'cc', from: 'c', to: 'c', length: 100, speedKmh: 40 },
      ],
      stations: [{ id: 's', name: 's', platform: 'island' as const, stops: [{ edge: 'ab', at: 50 }] }],
    };
    expect(() => new Graph(cfg).findPath('ab', 'cc')).toThrow(/Нет пути/);
  });
});

describe('физика', () => {
  it('тормозной путь v²/2a', () => {
    expect(brakingDistance(20, 0, 1)).toBeCloseTo(200);
    expect(brakingDistance(10, 20, 1)).toBe(0);
  });
  it('speedForDistance обратна brakingDistance', () => {
    const v = speedForDistance(200, 0, 1);
    expect(brakingDistance(v, 0, 1)).toBeCloseTo(200);
  });
  it('ускорение не превышает maxAccel и падает к vmax', () => {
    expect(tractionAccel(DEFAULT_TRAIN, 0)).toBeLessThanOrEqual(DEFAULT_TRAIN.maxAccel);
    expect(tractionAccel(DEFAULT_TRAIN, 22)).toBeLessThan(tractionAccel(DEFAULT_TRAIN, 0));
    expect(tractionAccel({ ...DEFAULT_TRAIN, tractionN: 0 }, 5)).toBe(0);
  });
});

describe('ГСЧ', () => {
  it('детерминирован по seed', () => {
    const a = createRng(7), b = createRng(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe('один поезд по всей линии', () => {
  const run = (seed: number) => {
    const g = graph();
    const sim = new Sim(g, { seed });
    const tr = sim.addTrain('T1', g.findPath('nk-I', 'nk-II'));
    let maxOver = 0;
    let steps = 0;
    while (tr.phase !== 'done' && sim.t < 7200) {
      sim.step();
      steps++;
      maxOver = Math.max(maxOver, tr.speed - tr.limit);
    }
    return { sim, tr, maxOver, steps };
  };

  it('доезжает до конца и останавливается', () => {
    const { tr, sim } = run(1);
    expect(tr.phase).toBe('done');
    expect(tr.speed).toBe(0);
    expect(sim.events.at(-1)?.type).toBe('finish');
  });
  it('останавливается на всех 16 остановках (8 станций × 2 пути)', () => {
    const { sim } = run(1);
    const arrivals = sim.events.filter((e) => e.type === 'arrive');
    expect(arrivals).toHaveLength(15); // стартовая стоянка не считается прибытием
    expect(new Set(arrivals.map((e) => e.type === 'arrive' && e.station)).size).toBe(8);
  });
  it('точность остановки в пределах 0.5 м', () => {
    const { sim } = run(1);
    for (const e of sim.events) if (e.type === 'arrive') expect(Math.abs(e.error)).toBeLessThan(0.5);
  });
  it('не превышает ограничение скорости', () => {
    expect(run(1).maxOver).toBeLessThanOrEqual(1e-9);
  });
  it('детерминирован при одном seed', () => {
    expect(run(3).sim.events).toEqual(run(3).sim.events);
  });
  it('время рейса правдоподобно (30–90 мин в обе стороны)', () => {
    const { sim } = run(1);
    expect(sim.t).toBeGreaterThan(30 * 60);
    expect(sim.t).toBeLessThan(90 * 60);
  });
});
