# Changelog

Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/), версии — [SemVer](https://semver.org/lang/ru/).

## [0.2.0] — 2026-11-03

Итерация 1: ядро (headless).

### Добавлено
- `src/core/graph.ts` — путевой граф (участки с длиной и ограничением скорости, поиск маршрута).
- `src/core/physics.ts` — параметры состава, тяга, тормозной путь.
- `src/core/sim.ts` — симуляция с фиксированным шагом 50 мс, seeded ГСЧ, журнал событий; один поезд по линии со стоянками.
- `src/lines/` — zod-схема и конфиг Некрасовской (8 станций, пути I/II, упрощённый оборот за конечными). Все длины и ограничения помечены `approx`.
- Тесты ядра: граф, физика, прогон поезда Некрасовка → Нижегородская → Некрасовка.

## [0.1.0] — 2026-11-03

Итерация 0: каркас.

### Добавлено
- Vite + TypeScript (strict), заглушка приложения.
- PWA-оболочка (vite-plugin-pwa): манифест, иконки, офлайн-кэш, полноэкранный режим.
- ESLint (flat config; в `src/core` запрещены DOM-глобалы), Vitest со смоук-тестом.
- CI (GitHub Actions): typecheck, lint, test, build; деплой на GitHub Pages после мержа в main.
- docs/SPEC.md и docs/ROADMAP.md (разложенный README), короткий README.
- reference/v7.5.html — прототип v7.5 (справочный).
