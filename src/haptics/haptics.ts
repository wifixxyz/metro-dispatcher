/** Вибрация: короткая на действия, длинная на тревоги. Проверяет поддержку. */
export class Haptics {
  enabled = true;
  /** Сколько раз реально вызвали вибрацию (для проверок). */
  calls = 0;

  constructor(
    private readonly vibrate: ((p: number | number[]) => boolean) | undefined = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function'
      ? (p) => navigator.vibrate(p)
      : undefined,
  ) {}

  get supported(): boolean {
    return this.vibrate !== undefined;
  }

  tap(): void {
    this.fire(15);
  }

  alarm(): void {
    this.fire([300, 120, 300]);
  }

  private fire(p: number | number[]): void {
    if (!this.enabled || !this.vibrate) return;
    this.calls++;
    this.vibrate(p);
  }
}
