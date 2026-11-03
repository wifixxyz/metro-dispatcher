import { describe, expect, it, vi } from 'vitest';
import { Sound, type Ctx } from '../src/audio/sound';
import { Game, type GameSignal } from '../src/game';
import { Haptics } from '../src/haptics/haptics';
import { NEKRASOVSKAYA } from '../src/lines';
import { DEFAULT_SETTINGS, SaveSchema, Storage, memoryKV } from '../src/storage/save';

function play(g: Game, seconds: number): void {
  g.setSpeed(8);
  const end = g.sim.t + seconds;
  while (g.sim.t < end) g.advance(0.25);
}

/** Смена с вмешательствами игрока. */
function scripted(): Game {
  const g = new Game(NEKRASOVSKAYA, { mode: 'lh-ok', interval: 180, seed: 5 });
  play(g, 300);
  g.setInterval(120);
  play(g, 400);
  g.setNodeManual('ks-I-out', true);
  g.throwPoints('ks-I-out');
  play(g, 200);
  g.setRoute('lh-ud-I#0', 'lh-ud-I#1');
  g.holdTrain(g.sim.trains[0]!.id);
  play(g, 200);
  g.holdTrain(g.sim.trains[0]!.id, false);
  g.sendTrain(g.sim.trains[1]!.id);
  g.recallTrain(g.sim.trains[2]!.id);
  play(g, 600);
  g.setLineManual(true);
  play(g, 300);
  g.setLineManual(false);
  play(g, 500);
  return g;
}

const digest = (g: Game) => ({
  t: g.sim.t,
  steps: g.stepCount,
  trains: g.sim.trains.map((t) => [t.id, t.pos, t.speed, t.phase, t.route.length, t.hold]),
  occupied: g.sim.il.occupiedBlocks().sort(),
  locked: g.sim.il.lockedBlocks().sort(),
  status: g.status(),
  interventions: g.interventions,
  stats: { d: g.stats.delays, a: g.stats.arrivals, f: g.stats.failures.length, st: g.stats.stations().map((s) => [s.count, s.mean]) },
  interval: g.interval,
  manualLine: g.manualLine,
});

describe('сохранение смены', () => {
  it('восстановление воспроизводит состояние точно', async () => {
    const a = scripted();
    const save = JSON.parse(JSON.stringify(a.snapshot()));
    expect(SaveSchema.safeParse(save).success).toBe(true);
    expect(save.actions.length).toBeGreaterThanOrEqual(9);
    const progress: number[] = [];
    const b = await Game.restore(NEKRASOVSKAYA, save, (f) => progress.push(f), 5000);
    a.collectLog();
    expect(digest(b)).toEqual(digest(a));
    expect(progress.at(-1)).toBe(1);
    expect(progress.length).toBeGreaterThan(3);
    // Дальше обе игры идут одинаково.
    play(a, 300);
    play(b, 300);
    expect(digest(b)).toEqual(digest(a));
  }, 120000);

  it('хранилище: круг, повреждённые данные игнорируются', async () => {
    const kv = memoryKV();
    const st = new Storage(kv);
    expect(await st.loadShift()).toBeUndefined();
    const g = new Game(NEKRASOVSKAYA, { mode: 'nk-ks', interval: 300 });
    g.setInterval(120);
    await st.saveShift(g.snapshot());
    const back = await st.loadShift();
    expect(back?.mode).toBe('nk-ks');
    expect(back?.actions).toHaveLength(1);
    await kv.set('shift:v1', { v: 1, mode: 5 });
    expect(await st.loadShift()).toBeUndefined();
    expect(await kv.get('shift:v1')).toBeUndefined();
  });

  it('настройки: по умолчанию и сохранение', async () => {
    const st = new Storage(memoryKV());
    expect(await st.loadSettings()).toEqual(DEFAULT_SETTINGS);
    await st.saveSettings({ sound: false, ambient: false, haptics: true });
    expect((await st.loadSettings()).sound).toBe(false);
  });

  it('недоступное хранилище не ломает игру', async () => {
    const bad = {
      get: () => Promise.reject(new Error('no idb')),
      set: () => Promise.reject(new Error('no idb')),
      del: () => Promise.reject(new Error('no idb')),
    };
    const st = new Storage(bad);
    expect(await st.loadShift()).toBeUndefined();
    expect(await st.loadSettings()).toEqual(DEFAULT_SETTINGS);
    await st.saveSettings(DEFAULT_SETTINGS);
  });
});

describe('статистика', () => {
  it('интервалы по станциям, парк, вмешательства', () => {
    const g = new Game(NEKRASOVSKAYA, { mode: 'lh-ks', interval: 180 });
    play(g, 3600);
    g.collectLog();
    const st = g.stats.stations();
    expect(st).toHaveLength(8);
    const used = st.filter((s) => s.count > 5);
    expect(used.map((x) => x.id)).toEqual(['lh', 'ud', 'ks']); // режим Лухмановская — Косино
    for (const s of used) expect(Math.abs(s.mean - 180)).toBeLessThan(40);
    expect(g.stats.fleetFulfilment()).toBeGreaterThan(0.95);
    expect(g.stats.fleet.length).toBeGreaterThan(30);
    g.setLineManual(true);
    expect(g.interventions).toBe(1);
  });
  it('сбои: экстренное торможение и простой попадают в журнал', () => {
    const g = new Game(NEKRASOVSKAYA, { mode: 'lh-ks', interval: 180 });
    g.holdTrain('нет');
    const seen: GameSignal[] = [];
    g.onSignal = (s) => seen.push(s);
    // Стоящий на перегоне поезд: ручная линия, поезда встанут у светофоров > 120 с.
    g.setLineManual(true);
    play(g, 900);
    expect(g.stats.failures.some((f) => f.text.includes('стоит на перегоне'))).toBe(true);
    expect(seen.some((s) => s.kind === 'alarm')).toBe(true);
  });
});

function fakeCtx(): { ctx: Ctx; nodes: string[]; clock: { t: number } } {
  const nodes: string[] = [];
  const clock = { t: 0 };
  const param = () => ({ value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() });
  const node = (name: string, extra: object = {}) => {
    nodes.push(name);
    return { connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), ...extra };
  };
  const ctx = {
    get currentTime() { return clock.t; },
    sampleRate: 8000,
    destination: {},
    resume: vi.fn(() => Promise.resolve()),
    createGain: () => node('gain', { gain: param() }),
    createOscillator: () => node('osc', { frequency: param(), type: 'sine' }),
    createBiquadFilter: () => node('filter', { frequency: param(), type: 'lowpass' }),
    createBufferSource: () => node('src', { buffer: null, loop: false }),
    createBuffer: (_c: number, len: number) => ({ getChannelData: () => new Float32Array(len) }),
  } as unknown as Ctx;
  return { ctx, nodes, clock };
}

describe('звук', () => {
  it('отключён — контекст не создаётся', () => {
    const f = vi.fn();
    const s = new Sound(f);
    s.enabled = false;
    s.unlock();
    expect(f).not.toHaveBeenCalled();
    expect(s.play('click')).toBe(false);
  });
  it('щелчок, сигнал маршрута, тревога синтезируются; частые повторы отсекаются', () => {
    const { ctx, nodes, clock } = fakeCtx();
    const s = new Sound(() => ctx);
    expect(s.play('click')).toBe(false); // до жеста контекста нет
    s.unlock();
    expect(nodes).toContain('src'); // фон зала
    expect(s.play('click')).toBe(true);
    expect(s.play('click')).toBe(false);
    clock.t = 1;
    expect(s.play('click')).toBe(true);
    expect(s.play('route')).toBe(true);
    const osc = nodes.filter((n) => n === 'osc').length;
    expect(osc).toBe(2);
    expect(s.play('alarm')).toBe(true);
    expect(nodes.filter((n) => n === 'osc').length).toBe(8);
    expect(s.played).toBe(4);
  });
  it('выключение звука и фона', () => {
    const { ctx } = fakeCtx();
    const s = new Sound(() => ctx);
    s.unlock();
    s.setAmbient(false);
    s.setEnabled(false);
    expect(s.play('click')).toBe(false);
  });
});

describe('вибрация', () => {
  it('короткая на действия, длинная на тревогу, выключается, проверяет поддержку', () => {
    const calls: (number | number[])[] = [];
    const h = new Haptics((p) => (calls.push(p), true));
    h.tap();
    h.alarm();
    expect(calls).toEqual([15, [300, 120, 300]]);
    h.enabled = false;
    h.tap();
    expect(calls).toHaveLength(2);
    const none = new Haptics(undefined);
    expect(none.supported).toBe(false);
    none.alarm();
    expect(none.calls).toBe(0);
  });
});
