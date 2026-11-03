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

export const LineConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  nodes: z.array(z.string().min(1)),
  edges: z.array(EdgeSchema).min(1),
  stations: z.array(StationSchema).min(1),
});

export type EdgeConfig = z.infer<typeof EdgeSchema>;
export type StationConfig = z.infer<typeof StationSchema>;
export type LineConfig = z.infer<typeof LineConfigSchema>;
