import type { ScanProgress } from "./types";

const ANSI = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  magenta: "\u001b[35m",
  green: "\u001b[32m",
};

function paint(value: string, code: string): string {
  return `${code}${value}${ANSI.reset}`;
}

function visibleLength(value: string): number {
  return value.replace(/\u001b\[[0-9;]*m/g, "").length;
}

function truncateMiddle(value: string, width: number): string {
  if (width <= 0) return "";
  if (value.length <= width) return value;
  if (width <= 3) return value.slice(0, width);
  const left = Math.ceil((width - 1) / 2);
  const right = Math.floor((width - 1) / 2);
  return `${value.slice(0, left)}…${value.slice(value.length - right)}`;
}

export function formatScanProgress(progress: ScanProgress, terminalWidth = 120, colorized = false): string {
  const total = Math.max(0, progress.total);
  const current = Math.max(0, Math.min(progress.current, total || progress.current));
  const ratio = total === 0 ? 1 : current / total;
  const percent = Math.round(ratio * 100);
  const counter = `${current}/${total}`;
  const prefix = `${progress.label ?? `Scanning${progress.phase ? ` ${progress.phase}` : ""}`} `;
  const suffix = `${percent.toString().padStart(3)}% ${counter}`;
  const fileBudget = Math.max(0, terminalWidth - prefix.length - suffix.length - 38);
  const file = progress.file && fileBudget >= 8 ? ` ${truncateMiddle(progress.file, fileBudget)}` : "";
  const barWidth = Math.max(12, Math.min(28, terminalWidth - prefix.length - suffix.length - file.length - 8));
  const filled = Math.max(0, Math.min(barWidth, Math.round(ratio * barWidth)));
  const active = "█".repeat(filled);
  const remaining = "░".repeat(barWidth - filled);
  const coloredActive = active ? paint(active, progress.partial ? ANSI.magenta : current >= total ? ANSI.green : ANSI.magenta) : "";
  const coloredRemaining = remaining ? paint(remaining, ANSI.dim) : "";
  const bar = colorized ? `${coloredActive}${coloredRemaining}` : `${active}${remaining}`;
  const line = `${prefix}[${bar}] ${suffix}${file}`;
  return visibleLength(line) <= terminalWidth ? line : `${prefix}[${bar}] ${suffix}`;
}

interface ProgressStream {
  isTTY?: boolean;
  columns?: number;
  write(value: string): unknown;
}

export interface ProgressRenderer {
  update(progress: ScanProgress): void;
  clear(): void;
}

export function createProgressRenderer(options: {
  stream?: ProgressStream;
  enabled?: boolean;
  colorized?: boolean;
  throttleMs?: number;
} = {}): ProgressRenderer {
  const stream = options.stream ?? process.stdout;
  const enabled = options.enabled ?? Boolean(stream.isTTY && !process.env.CI);
  const colorized = options.colorized ?? false;
  const throttleMs = options.throttleMs ?? 40;
  let lastWriteAt = 0;
  let lastProgress: ScanProgress | null = null;
  let visible = false;

  function render(progress: ScanProgress, force = false): void {
    if (!enabled) return;
    lastProgress = progress;
    const now = performance.now();
    if (!force && progress.current < progress.total && now - lastWriteAt < throttleMs) return;
    lastWriteAt = now;
    const line = formatScanProgress(progress, stream.columns || 120, colorized);
    stream.write(`\r\u001b[2K${line}`);
    visible = true;
  }

  return {
    update(progress) {
      const phaseChanged = lastProgress?.phase !== progress.phase || lastProgress?.label !== progress.label;
      render(progress, phaseChanged || progress.current >= progress.total || Boolean(progress.partial));
    },
    clear() {
      if (!enabled || !visible) return;
      stream.write("\r\u001b[2K");
      visible = false;
    },
  };
}
