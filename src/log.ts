const levels = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof levels;

const threshold = levels[(process.env.LOG_LEVEL as Level | undefined) ?? 'info'] ?? levels.info;

const emit =
  (level: Level) =>
  (msg: string, extra?: unknown): void => {
    if (levels[level] < threshold) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}`;
    const out = level === 'error' || level === 'warn' ? console.error : console.log;
    if (extra === undefined) out(line);
    else out(line, extra);
  };

export const log = {
  debug: emit('debug'),
  info: emit('info'),
  warn: emit('warn'),
  error: emit('error'),
};
