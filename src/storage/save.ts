import { del, get, set } from 'idb-keyval';
import { z } from 'zod';
import type { SaveData } from '../game';

const ActionSchema = z.discriminatedUnion('k', [
  z.object({ n: z.number().int().nonnegative(), k: z.literal('interval'), v: z.number().positive() }),
  z.object({ n: z.number().int().nonnegative(), k: z.literal('lineManual'), v: z.boolean() }),
  z.object({ n: z.number().int().nonnegative(), k: z.literal('nodeManual'), node: z.string(), v: z.boolean() }),
  z.object({ n: z.number().int().nonnegative(), k: z.literal('route'), from: z.string(), to: z.string() }),
  z.object({ n: z.number().int().nonnegative(), k: z.literal('cancel'), block: z.string() }),
  z.object({ n: z.number().int().nonnegative(), k: z.literal('points'), node: z.string(), edge: z.string().optional() }),
  z.object({ n: z.number().int().nonnegative(), k: z.literal('hold'), id: z.string(), v: z.boolean() }),
  z.object({ n: z.number().int().nonnegative(), k: z.literal('send'), id: z.string() }),
  z.object({ n: z.number().int().nonnegative(), k: z.literal('recall'), id: z.string() }),
]);

export const SaveSchema = z.object({
  v: z.literal(1),
  mode: z.string().min(1),
  seed: z.number().int(),
  startInterval: z.number().positive(),
  steps: z.number().int().nonnegative(),
  actions: z.array(ActionSchema),
  savedAt: z.number(),
});

export const SettingsSchema = z.object({
  sound: z.boolean(),
  ambient: z.boolean(),
  haptics: z.boolean(),
});
export type Settings = z.infer<typeof SettingsSchema>;
export const DEFAULT_SETTINGS: Settings = { sound: true, ambient: true, haptics: true };

/** Хранилище ключ → значение; в браузере — IndexedDB, в тестах — память. */
export interface KV {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
}

export const idbKV: KV = {
  get: (k) => get(k),
  set: (k, v) => set(k, v),
  del: (k) => del(k),
};

export function memoryKV(): KV {
  const m = new Map<string, unknown>();
  return {
    get: (k) => Promise.resolve(m.get(k)),
    set: (k, v) => {
      m.set(k, structuredClone(v));
      return Promise.resolve();
    },
    del: (k) => {
      m.delete(k);
      return Promise.resolve();
    },
  };
}

const SAVE_KEY = 'shift:v1';
const SETTINGS_KEY = 'settings:v1';

/** Сохранение смены и настроек. Повреждённые данные игнорируются (и удаляются). */
export class Storage {
  constructor(private readonly kv: KV = idbKV) {}

  async saveShift(data: SaveData): Promise<void> {
    await this.kv.set(SAVE_KEY, data);
  }

  async loadShift(): Promise<SaveData | undefined> {
    try {
      const raw = await this.kv.get(SAVE_KEY);
      if (raw === undefined) return undefined;
      const r = SaveSchema.safeParse(raw);
      if (r.success) return r.data as SaveData;
    } catch {
      /* IndexedDB недоступна (приватный режим) — играем без сохранения */
    }
    await this.clearShift();
    return undefined;
  }

  async clearShift(): Promise<void> {
    try {
      await this.kv.del(SAVE_KEY);
    } catch {
      /* нечего чистить */
    }
  }

  async loadSettings(): Promise<Settings> {
    try {
      const r = SettingsSchema.safeParse(await this.kv.get(SETTINGS_KEY));
      if (r.success) return r.data;
    } catch {
      /* значения по умолчанию */
    }
    return { ...DEFAULT_SETTINGS };
  }

  async saveSettings(s: Settings): Promise<void> {
    try {
      await this.kv.set(SETTINGS_KEY, s);
    } catch {
      /* не критично */
    }
  }
}
