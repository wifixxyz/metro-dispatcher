import { test } from '@playwright/test';

// Скриншоты для отчёта: SHOTS=docs/screenshots npm run e2e -- screens
const dir = process.env['SHOTS'];

for (const [name, vp] of [['mobile-390x844', { width: 390, height: 844 }], ['desktop-1440x900', { width: 1440, height: 900 }]] as const) {
  test(`скриншоты ${name}`, async ({ page }) => {
    test.skip(!dir, 'SHOTS не задан');
    await page.setViewportSize(vp);
    await page.goto('/');
    await page.waitForFunction(() => '__metro' in window);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${dir}/${name}-tour.png` });
    await page.getByTestId('tour-skip').click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${dir}/${name}-start.png` });
    await page.getByTestId('route-mode').click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${dir}/${name}-route.png` });
    await page.getByTestId('route-mode').click();
    await page.getByTestId('view-toggle').click();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `${dir}/${name}-3d.png` });
  });
}
