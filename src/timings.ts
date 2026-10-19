export interface TimingEntry {
  ms: number;
  count: number;
}

// Stages are wall-clock time on the main thread. Work is time summed across
// every thread, so it can exceed the stage it ran inside
export interface Timings {
  stages: Record<string, TimingEntry>;
  work: Record<string, TimingEntry>;
}

let totals: Timings = { stages: {}, work: {} };

function add(group: Record<string, TimingEntry>, name: string, ms: number, count = 1): void {
  const entry = (group[name] ??= { ms: 0, count: 0 });

  entry.ms += ms;
  entry.count += count;
}

function measure<T>(group: Record<string, TimingEntry>, name: string, run: () => T): T {
  const startedAt = performance.now();
  const finish = (): void => add(group, name, performance.now() - startedAt);

  let result: T;

  try {
    result = run();
  } catch (error) {
    finish();
    throw error;
  }

  if (result instanceof Promise) return result.finally(finish) as T;

  finish();

  return result;
}

export function addStageTiming(name: string, ms: number): void {
  add(totals.stages, name, ms);
}

export function timeStage<T>(name: string, run: () => T): T {
  return measure(totals.stages, name, run);
}

export function timeWork<T>(name: string, run: () => T): T {
  return measure(totals.work, name, run);
}

// Splits a stage into the phases its progress reports, each ending when the next begins
export function phaseTimer(stage: string): { mark(phase: string): void; end(): void } {
  let current: string | null = null;
  let startedAt = 0;

  const end = (): void => {
    if (current) addStageTiming(`${stage}/${current}`, performance.now() - startedAt);

    current = null;
  };

  return {
    mark(phase) {
      if (phase === current) return;

      end();
      current = phase;
      startedAt = performance.now();
    },

    end,
  };
}

export function mergeTimings(other: Timings): void {
  for (const [name, entry] of Object.entries(other.stages)) add(totals.stages, name, entry.ms, entry.count);
  for (const [name, entry] of Object.entries(other.work)) add(totals.work, name, entry.ms, entry.count);
}

export function takeTimings(): Timings {
  const taken = totals;
  totals = { stages: {}, work: {} };

  return taken;
}
