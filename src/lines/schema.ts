import { z } from 'zod';

/** Рельсовый участок: направленное ребро графа. */
export const EdgeSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  /** Длина, м. */
  length: z.number().positive(),
  /** Ограничение скорости, км/ч. */
  speedKmh: z.number().positive(),
  track: z.string().optional(),
  /** Значение приблизительное (нет точных открытых данных). */
  approx: z.boolean().optional(),
});

export const StationSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  platform: z.enum(['island', 'shore']),
  /** Точки остановки головы поезда: участок и смещение от его начала, м. */
  stops: z.array(z.object({ edge: z.string(), at: z.number().nonnegative() })).min(1),
});

/**
 * Режим работы: пара оборотных станций. Путь I — `stops[0]`, путь II — `stops[1]` станции.
 * `turnWest`/`turnEast` — съезды оборота (II → I у западной, I → II у восточной).
 */
export const ModeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  west: z.string().min(1),
  east: z.string().min(1),
  turnWest: z.string().min(1),
  turnEast: z.string().min(1),
});

/** Депо: вход (с пути II у станции), деповские пути, выход на путь I в сторону конечной. */
export const DepotSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  station: z.string().min(1),
  entry: z.string().min(1),
  exit: z.string().min(1),
  /** Участок пути I, на который выходит состав из депо (контрольная точка выпуска). */
  join: z.string().min(1),
  tracks: z.array(z.object({ edge: z.string(), at: z.number().nonnegative() })).min(1),
  /** Парк депо, составов. */
  fleet: z.number().int().positive(),
  approx: z.boolean().optional(),
});

/** Точка схемы относительно центра станции (единицы схемы). */
export const AnchorSchema = z.object({ station: z.string(), dx: z.number(), dy: z.number() });

/**
 * Расположение на схеме. Станции и их пути размещаются автоматически;
 * здесь — узлы вне станций (депо) и изгибы отдельных участков.
 */
export const LayoutSchema = z.object({
  nodes: z.record(z.string(), AnchorSchema).optional(),
  bends: z.record(z.string(), z.array(AnchorSchema)).optional(),
});

export const LineConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  nodes: z.array(z.string().min(1)),
  edges: z.array(EdgeSchema).min(1),
  stations: z.array(StationSchema).min(1),
  modes: z.array(ModeSchema).optional(),
  depot: DepotSchema.optional(),
  layout: LayoutSchema.optional(),
  /** Макс. длина блок-участка (расстояние между светофорами), м. По умолчанию 400. */
  blockLength: z.number().min(100).max(2000).optional(),
});

export type EdgeConfig = z.infer<typeof EdgeSchema>;
export type StationConfig = z.infer<typeof StationSchema>;
export type ModeConfig = z.infer<typeof ModeSchema>;
export type LayoutConfig = z.infer<typeof LayoutSchema>;
export type DepotConfig = z.infer<typeof DepotSchema>;
export type LineConfig = z.infer<typeof LineConfigSchema>;
