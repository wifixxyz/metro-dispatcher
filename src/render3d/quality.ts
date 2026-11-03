/**
 * Регулятор качества: держит время кадра в бюджете, меняя разрешение рендера.
 * Для телефона цель — 30+ fps (≈ 33 мс на кадр); запас оставляем до 28 мс.
 */
export class Governor {
  ratio: number;
  private avg: number;
  private n = 0;

  constructor(
    readonly max: number,
    readonly min = 0.5,
    private readonly targetMs = 28,
    start?: number,
  ) {
    this.ratio = Math.min(max, start ?? max);
    this.avg = targetMs;
  }

  /** Сообщить время кадра, мс. Возвращает новый коэффициент, если он изменился. */
  frame(ms: number): number | undefined {
    this.avg = this.avg * 0.9 + Math.min(ms, 200) * 0.1;
    if (++this.n < 20) return undefined;
    this.n = 0;
    let next = this.ratio;
    if (this.avg > this.targetMs * 1.15) next = Math.max(this.min, this.ratio - 0.15);
    else if (this.avg < this.targetMs * 0.6) next = Math.min(this.max, this.ratio + 0.1);
    if (Math.abs(next - this.ratio) < 1e-6) return undefined;
    this.ratio = next;
    return next;
  }

  get averageMs(): number {
    return this.avg;
  }
}
