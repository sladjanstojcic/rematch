export type RunLog = {
  errors: { stage: string; source?: string; message: string }[];
  stats: Record<string, number>;
  addError(e: RunLog['errors'][number]): void;
  inc(key: string, n?: number): void;
};

export function createRunLog(): RunLog {
  const errors: RunLog['errors'] = [];
  const stats: Record<string, number> = {};
  return {
    errors,
    stats,
    addError: (error) => { errors.push(error); },
    inc: (key, n = 1) => { Object.defineProperty(stats, key, {
      value: (Object.hasOwn(stats, key) ? stats[key] : 0) + n,
      writable: true, enumerable: true, configurable: true,
    }); },
  };
}
