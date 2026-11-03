import { expect, test, type Page } from '@playwright/test';
import { makeMiniLine } from '../tests/helpers/miniLine';

interface State {
  mode: string;
  simTime: number;
  speed: number;
  paused: boolean;
  interval: number;
  trains: number;
  trainsDrawn: number;
  edgesDrawn: number;
  signalsDrawn: number;
  frames: number;
  violations: number;
}

const state = (page: Page): Promise<State> =>
  page.evaluate(() => (window as unknown as { __metro: { state(): unknown } }).__metro.state() as never);

async function open(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/');
  await page.waitForFunction(() => '__metro' in window);
  await page.waitForFunction(() => (window as unknown as { __metro: { state(): { frames: number } } }).__metro.state().frames > 5);
  return errors;
}

test('игра загружается на 390×844, карта рисуется, ошибок нет', async ({ page }) => {
  const errors = await open(page);
  await expect(page.locator('canvas')).toBeVisible();
  const box = await page.locator('canvas').boundingBox();
  expect(box?.width).toBeGreaterThan(380);
  expect(box?.height).toBeGreaterThan(800);
  const s = await state(page);
  expect(s.edgesDrawn).toBeGreaterThanOrEqual(39);
  expect(s.trains).toBeGreaterThan(5);
  expect(s.trainsDrawn).toBe(s.trains);
  expect(s.violations).toBe(0);
  // Полотно не пустое: чистый фон жмётся в крошечный PNG.
  const png = await page.locator('canvas').screenshot();
  expect(png.length).toBeGreaterThan(8_000);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('кнопки не меньше 44 px и помещаются в экран', async ({ page }) => {
  await open(page);
  const boxes = await page.locator('button:not(.sheet button), select').evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return { w: r.width, h: r.height, right: r.right, bottom: r.bottom, id: (e as HTMLElement).dataset['testid'] ?? e.tagName };
    }),
  );
  expect(boxes.length).toBeGreaterThanOrEqual(12);
  for (const b of boxes) {
    expect(b.w, b.id).toBeGreaterThanOrEqual(43.5);
    expect(b.h, b.id).toBeGreaterThanOrEqual(43.5);
    expect(b.right, b.id).toBeLessThanOrEqual(390);
    expect(b.bottom, b.id).toBeLessThanOrEqual(844);
  }
});

test('скорость, пауза, интервал, режим, журнал', async ({ page }) => {
  await open(page);
  const rate = async (): Promise<number> => {
    const a = await state(page);
    await page.waitForTimeout(1000);
    const b = await state(page);
    return b.simTime - a.simTime;
  };
  await page.getByTestId('speed-1').click();
  const r1 = await rate();
  await page.getByTestId('speed-8').click();
  expect((await state(page)).speed).toBe(8);
  const r8 = await rate();
  expect(r1).toBeGreaterThan(0.5);
  expect(r1).toBeLessThan(1.6);
  expect(r8).toBeGreaterThan(r1 * 4);
  await page.getByTestId('pause').click();
  expect((await state(page)).paused).toBe(true);
  expect(await rate()).toBe(0);
  await page.getByTestId('pause').click();

  const before = await page.getByTestId('status').textContent();
  await page.getByTestId('interval-2').click();
  expect((await state(page)).interval).toBe(120);
  await expect.poll(() => page.getByTestId('status').textContent()).not.toBe(before);

  await page.getByTestId('mode').selectOption('lh-ks');
  await expect.poll(async () => (await state(page)).mode).toBe('lh-ks');
  const s = await state(page);
  expect(s.trains).toBeGreaterThan(2);
  await page.waitForTimeout(300);
  expect((await state(page)).trainsDrawn).toBe((await state(page)).trains);

  await page.getByTestId('sheet-toggle').click();
  await expect(page.getByTestId('sheet')).toHaveClass(/open/);
  await expect(page.locator('.log .line').first()).toBeVisible();
});

test('масштаб кнопками меняет зум', async ({ page }) => {
  await open(page);
  const z = async (): Promise<number> => (await page.evaluate(() => (window as unknown as { __metro: { state(): { scale: number } } }).__metro.state().scale));
  const z0 = await z();
  await page.getByTestId('zoom-in').click();
  expect(await z()).toBeGreaterThan(z0 * 1.3);
  await page.getByTestId('zoom-fit').click();
  expect(Math.abs((await z()) - z0)).toBeLessThan(z0 * 0.05);
});

test('PWA: манифест валиден, иконки доступны', async ({ page, request }) => {
  await open(page);
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBeTruthy();
  const res = await request.get(new URL(href as string, page.url()).toString());
  expect(res.ok()).toBe(true);
  const m = (await res.json()) as {
    name: string; short_name: string; start_url: string; display: string; lang: string;
    icons: { src: string; sizes: string; type: string }[];
  };
  expect(m.name).toBe('Метро · Диспетчер');
  expect(m.display).toBe('fullscreen');
  expect(m.lang).toBe('ru');
  expect(m.icons.map((i) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));
  for (const icon of m.icons) {
    const r = await request.get(new URL(icon.src, new URL(href as string, page.url())).toString());
    expect(r.ok(), icon.src).toBe(true);
    expect(r.headers()['content-type']).toContain('image/png');
  }
});

type Pt = { x: number; y: number } | undefined;
const call = <T>(page: Page, fn: string, arg?: string): Promise<T> =>
  page.evaluate(([f, a]) => (window as unknown as Record<string, Record<string, (x?: string) => unknown>>)['__metro']![f!]!(a) as never, [fn, arg] as const);

test('ручное управление: переключатель линии, маршрут по касаниям, карточки', async ({ page }) => {
  await open(page);
  await page.getByTestId('pause').click();

  // Переключатель авто/ручной для всей линии.
  await page.getByTestId('auto-toggle').click();
  await expect(page.getByTestId('auto-toggle')).toHaveText('Ручной режим');
  await expect(page.getByTestId('toast')).toContainText('ручном режиме');
  expect(((await state(page)) as unknown as { manualLine: boolean }).manualLine).toBe(true);
  await page.getByTestId('auto-toggle').click();
  await expect(page.getByTestId('auto-toggle')).toHaveText('Автомат: вкл');

  // Маршрут: коснуться начального, затем конечного светофора.
  await page.evaluate(() => (window as never as { __metro: { focus(n: string, s: number): void } }).__metro.focus('lh-I-out', 1.6));
  const a = await call<Pt>(page, 'signalScreen', 'lh-ud-I#0');
  const b = await call<Pt>(page, 'signalScreen', 'lh-ud-I#1');
  expect(a && b).toBeTruthy();
  await page.touchscreen.tap(a!.x, a!.y);
  await expect.poll(async () => ((await state(page)) as unknown as { selected: string | null }).selected).toBe('lh-ud-I#0');
  await page.touchscreen.tap(b!.x, b!.y);
  await expect.poll(async () => ((await state(page)) as unknown as { selected: string | null }).selected).toBeNull();
  await expect(page.getByTestId('toast')).toHaveClass(/show/);
  const toast = (await page.getByTestId('toast').textContent()) ?? '';
  expect(toast.length).toBeGreaterThan(5); // «Маршрут установлен» либо причина отказа
  const routes = ((await state(page)) as unknown as { routes: number }).routes;
  if (toast.includes('Маршрут установлен')) {
    expect(routes).toBeGreaterThan(0);
    await page.touchscreen.tap(a!.x, a!.y);
    await expect(page.getByTestId('route-cancel')).toBeVisible();
    await page.getByTestId('route-cancel').click();
  }

  // Стрелка: карточка и перевод.
  // Берём первую стрелку, у которой в точке касания нет поезда (иначе откроется карточка поезда).
  let opened = false;
  for (const node of ['ks-I-out', 'ok-I-out', 'ks-II-in', 'ok-II-in', 'lh-II-out']) {
    await page.evaluate((n) => (window as never as { __metro: { focus(n: string, s: number): void } }).__metro.focus(n, 1.6), node);
    const p = await call<Pt>(page, 'switchScreen', node);
    await page.touchscreen.tap(p!.x, p!.y);
    if (await page.getByTestId('throw').isVisible()) {
      opened = true;
      break;
    }
    if (await page.getByTestId('card-close').isVisible()) await page.getByTestId('card-close').dispatchEvent('click');
  }
  expect(opened).toBe(true);
  await page.getByTestId('throw').click();
  await expect(page.getByTestId('toast')).toHaveClass(/show/);
  await page.getByTestId('node-mode').click();
  await expect(page.getByTestId('node-mode')).toHaveText('Узел: ручной');
  await page.getByTestId('card-close').dispatchEvent('click');

  // Поезд: карточка, задержка.
  await page.getByTestId('zoom-fit').click();
  const tr = await call<{ id: string; x: number; y: number } | undefined>(page, 'trainScreen');
  expect(tr).toBeTruthy();
  expect(tr!.x).toBeGreaterThan(0);
  expect(tr!.x).toBeLessThan(390);
  {
    await page.touchscreen.tap(tr.x, tr.y);
    await expect(page.getByTestId('train-hold')).toBeVisible();
    await page.getByTestId('train-hold').click();
    await expect(page.getByTestId('train-hold')).toHaveText('Снять задержку');
  }
});

test('смена и настройки переживают перезапуск; статистика; новая смена', async ({ page }) => {
  await open(page);
  await page.getByTestId('interval-2').click();
  await page.getByTestId('mode').selectOption('lh-ks');
  await expect.poll(async () => (await state(page)).mode).toBe('lh-ks');
  await page.getByTestId('interval-2').click();
  await page.getByTestId('speed-8').click();
  await page.getByTestId('sheet-toggle').click();
  await page.getByTestId('set-sound').click();
  await expect(page.getByTestId('set-sound')).not.toHaveClass(/on/);
  await expect(page.getByTestId('stats-summary')).toContainText('Парк выполнен');
  await expect(page.getByTestId('chart')).toBeVisible();
  await page.waitForTimeout(3000); // автосохранение раз в 2 с
  const before = await state(page);
  expect(before.simTime).toBeGreaterThan(60);

  await page.reload();
  await page.waitForFunction(() => '__metro' in window);
  await page.waitForFunction(() => (window as unknown as { __metro: { state(): { frames: number } } }).__metro.state().frames > 3);
  const after = await state(page);
  expect(after.mode).toBe('lh-ks');
  expect(after.interval).toBe(120);
  expect(after.simTime).toBeGreaterThan(before.simTime - 40); // последнее автосохранение ≤ 2 с (≈16 с модели) назад
  expect(after.violations).toBe(0);
  await page.getByTestId('sheet-toggle').click();
  await expect(page.getByTestId('set-sound')).not.toHaveClass(/on/);

  await page.getByTestId('new-shift').click();
  await expect.poll(async () => (await state(page)).simTime).toBeLessThan(before.simTime);
});

test('редактор: ошибки понятны, правка формами, запуск своей линии и возврат', async ({ page }) => {
  await open(page);
  await page.getByTestId('editor-open').click();
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(page.getByTestId('editor-preview')).toBeVisible();
  await expect(page.getByTestId('editor-status')).toContainText('Ошибок: 0');

  // Сломанный JSON.
  await page.getByTestId('editor-json').fill('{\n "id": "x",\n "name": \n}');
  await page.getByTestId('editor-apply').click();
  await expect(page.getByTestId('editor-errors')).toContainText('некорректный JSON (строка');
  await expect(page.getByTestId('editor-note')).toContainText('не применён');

  // Схема не сходится: понятные сообщения с путём.
  await page.getByTestId('editor-json').fill('{"id":"x","name":5}');
  await page.getByTestId('editor-apply').click();
  await expect(page.getByTestId('editor-errors')).toContainText('name: ожидалось: строка');
  await expect(page.getByTestId('editor-errors')).toContainText('edges: нет обязательного поля');

  // Своя линия из JSON.
  await page.getByTestId('editor-json').fill(JSON.stringify(makeMiniLine(4)));
  await page.getByTestId('editor-apply').click();
  await expect(page.getByTestId('editor-status')).toContainText('Ошибок: 0');
  await expect(page.getByTestId('editor').locator('.pv .hint')).toContainText('4 станций');

  // Правка формами: добавить станцию.
  await page.getByTestId('add-st-name').fill('Тестовая');
  await page.getByTestId('add-st').click();
  await expect(page.getByTestId('editor').locator('.pv .hint')).toContainText('5 станций');
  await expect(page.getByTestId('editor-status')).toContainText('Ошибок: 0');

  // Ошибка из-за формы блокирует запуск.
  await page.getByTestId('st-at-s0').fill('9999');
  await page.getByTestId('st-at-s0').dispatchEvent('change');
  await expect(page.getByTestId('editor-errors')).toContainText('за пределами участка');
  await expect(page.getByTestId('editor-play')).toBeDisabled();
  await page.getByTestId('st-at-s0').fill('150');
  await page.getByTestId('st-at-s0').dispatchEvent('change');
  await expect(page.getByTestId('editor-status')).toContainText('Ошибок: 0');

  // Запуск: страница перезагружается уже с новой линией.
  await page.getByTestId('editor-play').click();
  await page.waitForFunction(() => '__metro' in window && (window as never as { __metro: { state(): { line: string; frames: number } } }).__metro.state().frames > 3);
  const s = (await state(page)) as unknown as { line: string; mode: string; trains: number; trainsDrawn: number; violations: number };
  expect(s.line).toBe('mini');
  expect(s.mode).toBe('all');
  expect(s.trains).toBeGreaterThan(2);
  expect(s.trainsDrawn).toBe(s.trains);
  expect(s.violations).toBe(0);

  // Возврат к Некрасовской.
  await page.getByTestId('editor-open').click();
  await page.getByTestId('editor-reset').click();
  await expect
    .poll(() => page.evaluate(() => (window as never as { __metro?: { state(): { line: string } } }).__metro?.state().line).catch(() => undefined), { timeout: 15000 })
    .toBe('nekrasovskaya');
});
