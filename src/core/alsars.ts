/** АЛС-АРС: код скорости по числу свободных блок-участков впереди. */

const KMH = 1 / 3.6;

export type Aspect = 'green' | 'yellow' | 'red-yellow' | 'red';

/**
 * Код участка по числу свободных блок-участков за ним (до первого занятого/закрытого).
 * ≥2 — разрешено 80, 1 — 60, 0 — 40 (подход к закрытому сигналу, остановка перед ним).
 */
export function codeSpeed(freeBeyond: number): number {
  if (freeBeyond >= 2) return 80 * KMH;
  if (freeBeyond === 1) return 60 * KMH;
  return 40 * KMH;
}

/** Показание светофора по числу свободных блок-участков за защищаемым. */
export function aspectFor(blockFree: boolean, freeBeyond: number): Aspect {
  if (!blockFree) return 'red';
  if (freeBeyond >= 2) return 'green';
  if (freeBeyond === 1) return 'yellow';
  return 'red-yellow';
}
