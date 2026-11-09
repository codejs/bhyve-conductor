import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

// The log level is read once at import time, so each test re-imports the module.
const loadLog = async (level?: string) => {
  vi.resetModules();
  vi.stubEnv('LOG_LEVEL', level);
  return (await import('../log.ts')).log;
};

describe('log', () => {
  let stdout: MockInstance<typeof console.log>;
  let stderr: MockInstance<typeof console.error>;

  beforeEach(() => {
    stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
    stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('defaults to info: hides debug, shows info', async () => {
    const log = await loadLog(undefined);
    log.debug('hidden');
    log.info('shown');

    expect(stdout).toHaveBeenCalledTimes(1);
    expect(stdout.mock.calls[0]?.[0]).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z INFO {2}shown$/);
  });

  it('sends warn and error to stderr, info and debug to stdout', async () => {
    const log = await loadLog('debug');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');

    expect(stdout).toHaveBeenCalledTimes(2);
    expect(stderr).toHaveBeenCalledTimes(2);
  });

  it('respects a higher threshold', async () => {
    const log = await loadLog('error');
    log.warn('hidden');
    log.error('shown');

    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stdout).not.toHaveBeenCalled();
  });

  it('passes extra data as a second argument', async () => {
    const log = await loadLog('info');
    const extra = { a: 1 };
    log.info('with extra', extra);

    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('with extra'), extra);
  });

  it('falls back to info for an unknown level', async () => {
    const log = await loadLog('verbose');
    log.debug('hidden');
    log.info('shown');

    expect(stdout).toHaveBeenCalledTimes(1);
  });
});
