# Метро · Диспетчер

Браузерная игра-симулятор поездного диспетчера метро. Первая линия — Некрасовская (15)
Московского метро. Автодиспетчер держит интервал, игрок может вмешиваться вручную:
задавать маршруты, переводить стрелки, задерживать и отправлять поезда.

Играть: https://wifixxyz.github.io/metro-dispatcher/

## Стек

TypeScript (strict) · Vite · PixiJS v8 · PWA · Vitest · Playwright.
Целевая платформа — Android-телефоны, ПК тоже поддерживается.

## Документация

- [docs/SPEC.md](docs/SPEC.md) — спецификация: стек, архитектура, конфиг линии, геймплей, внешний вид, проверки.
- [docs/ROADMAP.md](docs/ROADMAP.md) — план итераций.
- [CHANGELOG.md](CHANGELOG.md) — история версий.
- [reference/v7.5.html](reference/v7.5.html) — прототип v7.5 (справочный, не часть сборки).

## Разработка

```
npm ci
npm run dev        # dev-сервер
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm test           # vitest
npm run build      # сборка в dist/
```

Требуется Node.js 20+.
