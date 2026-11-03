import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APP_TITLE } from '../src/meta';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};
const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');

describe('каркас', () => {
  it('название игры задано', () => {
    expect(APP_TITLE).toBe('Метро · Диспетчер');
  });

  it('версия в package.json — semver', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('текущая версия описана в CHANGELOG.md', () => {
    expect(changelog).toContain(`## [${pkg.version}]`);
  });
});
