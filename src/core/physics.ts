/** Параметры состава. Единицы СИ. */
export interface TrainParams {
  massKg: number;
  lengthM: number;
  maxSpeed: number;
  tractionN: number;
  /** Сопротивление движению, Н на кг массы на (м/с) — линейная модель + базовое. */
  resistBaseN: number;
  resistLinear: number;
  /** Служебное торможение, м/с² (положительное число). */
  serviceDecel: number;
  emergencyDecel: number;
  /** Макс. ускорение (ограничение по сцеплению/комфорту), м/с². */
  maxAccel: number;
}

/** Типовой 8-вагонный состав (значения приблизительные). */
export const DEFAULT_TRAIN: TrainParams = {
  massKg: 400_000,
  lengthM: 152,
  maxSpeed: 80 / 3.6,
  tractionN: 340_000,
  resistBaseN: 4_000,
  resistLinear: 120,
  serviceDecel: 1.0,
  emergencyDecel: 1.3,
  maxAccel: 1.0,
};

/** Доступное ускорение тяги при скорости v. */
export function tractionAccel(p: TrainParams, v: number): number {
  const a = (p.tractionN - p.resistBaseN - p.resistLinear * v) / p.massKg;
  return Math.max(0, Math.min(p.maxAccel, a));
}

/** Тормозной путь с v до v1 при замедлении a. */
export function brakingDistance(v: number, v1: number, a: number): number {
  if (v <= v1) return 0;
  return (v * v - v1 * v1) / (2 * a);
}

/** Максимальная скорость, с которой ещё можно успеть снизиться до v1 на расстоянии d. */
export function speedForDistance(d: number, v1: number, a: number): number {
  return Math.sqrt(v1 * v1 + 2 * a * Math.max(0, d));
}
