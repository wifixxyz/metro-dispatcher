# Changelog

Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/), версии — [SemVer](https://semver.org/lang/ru/).

## [0.1.0] — 2026-11-03

Итерация 0: каркас.

### Добавлено
- Vite + TypeScript (strict), заглушка приложения.
- PWA-оболочка (vite-plugin-pwa): манифест, иконки, офлайн-кэш, полноэкранный режим.
- ESLint (flat config; в `src/core` запрещены DOM-глобалы), Vitest со смоук-тестом.
- CI (GitHub Actions): typecheck, lint, test, build; деплой на GitHub Pages после мержа в main.
- docs/SPEC.md и docs/ROADMAP.md (разложенный README), короткий README.
- reference/v7.5.html — прототип v7.5 (справочный).
