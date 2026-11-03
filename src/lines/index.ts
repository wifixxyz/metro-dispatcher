import nekrasovskaya from './nekrasovskaya.json';
import { LineConfigSchema, type LineConfig } from './schema';

export function loadLine(raw: unknown): LineConfig {
  return LineConfigSchema.parse(raw);
}

export const NEKRASOVSKAYA: LineConfig = loadLine(nekrasovskaya);
