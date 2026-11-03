import { expect, test, type Page } from '@playwright/test';

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
  const boxes = await page.locator('button, select').evaluateAll((els) =>
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
