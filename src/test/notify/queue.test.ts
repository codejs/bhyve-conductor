import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualClock } from '../../clock.ts';
import { log } from '../../log.ts';
import { DeliveryQueue, type DropReason } from '../../notify/queue.ts';
import { TelegramPermanentError, TelegramRateLimitError } from '../../notify/telegram.ts';

const START = new Date('2026-07-01T12:00:00Z');

const setup = (opts = {}) => {
  const clock = new VirtualClock(START);
  const deliveries: { text: string; at: number }[] = [];
  const send = vi.fn(async (text: string) => {
    deliveries.push({ text, at: clock.now().getTime() - START.getTime() });
  });
  const dropped: DropReason[] = [];
  const queue = new DeliveryQueue({ send }, { minIntervalMs: 1000, retryDelaysMs: [5000, 30000], maxQueued: 3, ...opts }, (d) => dropped.push(d), clock);
  return { clock, send, deliveries, dropped, queue };
};

describe('DeliveryQueue', () => {
  beforeEach(() => {
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    vi.spyOn(log, 'error').mockImplementation(() => {});
  });

  it('delivers in order, at most one message per interval', async () => {
    const t = setup();
    t.queue.enqueue('a');
    await t.clock.advanceBy(100);
    t.queue.enqueue('b');
    await t.clock.advanceBy(1500);
    t.queue.enqueue('c');

    await t.clock.advanceBy(10_000);

    expect(t.deliveries).toEqual([
      { text: 'a', at: 0 },
      { text: 'b', at: 1000 },
      { text: 'c', at: 2000 }, // not before 1 s after 'b'
    ]);
  });

  it('combines messages that pile up into one (a burst of alerts is one ping)', async () => {
    const t = setup();
    t.queue.enqueue('first');
    t.queue.enqueue('storm: sensor A');
    t.queue.enqueue('storm: sensor B');
    t.queue.enqueue('storm: sensor C');

    await t.clock.advanceBy(10_000);

    expect(t.deliveries).toEqual([
      { text: 'first', at: 0 }, // sending started before the others arrived
      { text: 'storm: sensor A\n\nstorm: sensor B\n\nstorm: sensor C', at: 1000 },
    ]);
  });

  it('keeps combined messages under the size limit', async () => {
    const t = setup({ maxBatchChars: 25, maxQueued: 10 });
    t.send.mockImplementationOnce(async () => {}); // let the queue build up behind the first send
    for (const m of ['x', '1234567890', '1234567890', '1234567890']) t.queue.enqueue(m);

    await t.clock.advanceBy(10_000);

    expect(t.deliveries.map((d) => d.text)).toEqual(['1234567890\n\n1234567890', '1234567890']);
  });

  it('retries a failed message with back-off, keeping the order', async () => {
    const t = setup();
    t.send.mockRejectedValueOnce(new Error('timed out')).mockRejectedValueOnce(new Error('HTTP 502'));
    t.queue.enqueue('a');
    t.queue.enqueue('b'); // arrives while 'a' is failing: goes out with it on the retry

    await t.clock.advanceBy(60_000);

    expect(t.deliveries).toEqual([{ text: 'a\n\nb', at: 35_000 }]); // after waiting 5s, then 30s
    expect(t.dropped).toEqual([]);
  });

  it('drops a message after the last retry and reports it, then carries on', async () => {
    const t = setup();
    t.send.mockRejectedValueOnce(new Error('x')).mockRejectedValueOnce(new Error('y')).mockRejectedValueOnce(new Error('z'));
    t.queue.enqueue('a');

    await t.clock.advanceBy(60_000);
    t.queue.enqueue('b');
    await t.clock.advanceBy(1_000);

    expect(t.dropped).toEqual([{ text: 'a', error: 'z', attempts: 3 }]);
    expect(t.deliveries.map((d) => d.text)).toEqual(['b']);
  });

  it('counts attempts per message correctly when a combined message fails', async () => {
    const t = setup({ retryDelaysMs: [5000] });
    t.send.mockImplementation(() => Promise.reject(new Error('down')));
    t.queue.enqueue('a');
    t.queue.enqueue('b');
    t.queue.enqueue('c');

    await t.clock.advanceBy(60_000);

    // 'a' fails alone; b and c join its retry; all three are dropped after that second failure
    expect(t.dropped.map((d) => [d.text, d.attempts])).toEqual([
      ['a', 2],
      ['b', 2],
      ['c', 2],
    ]);
  });

  it('honours Telegram’s retry_after', async () => {
    const t = setup();
    t.send.mockRejectedValueOnce(new TelegramRateLimitError(17));
    t.queue.enqueue('a');

    await t.clock.advanceBy(60_000);

    expect(t.deliveries).toEqual([{ text: 'a', at: 17_000 }]);
  });

  it('does not retry a message Telegram will never accept', async () => {
    const t = setup();
    t.send.mockRejectedValueOnce(new TelegramPermanentError('Telegram sendMessage failed: 400 Bad Request: chat not found'));
    t.queue.enqueue('a');

    await t.clock.advanceBy(60_000);

    expect(t.send).toHaveBeenCalledTimes(1);
    expect(t.dropped[0]).toMatchObject({ text: 'a', attempts: 1, error: expect.stringContaining('chat not found') });
  });

  it('drops the oldest waiting messages when too many pile up, never the one being sent', async () => {
    const t = setup({ maxQueued: 3 });
    t.send.mockImplementation(() => new Promise(() => {})); // Telegram hangs on '1'
    for (const m of ['1', '2', '3', '4', '5']) t.queue.enqueue(m);

    await t.clock.advanceBy(1000);

    expect(t.queue.size).toBe(3); // 3, 4, 5 waiting; 1 in flight
    expect(t.dropped.map((d) => [d.text, d.error])).toEqual([['2', 'queue full']]);
  });

  it('does not lose messages that arrive while one is being sent and the queue is full', async () => {
    const t = setup({ maxQueued: 3 });
    let release!: () => void;
    t.send.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    t.queue.enqueue('first');
    for (const m of ['A', 'B', 'C']) t.queue.enqueue(m);

    release();
    await t.clock.advanceBy(10_000);

    expect(t.dropped).toEqual([]);
    expect(t.send.mock.calls.map(([text]) => text)).toEqual(['first', 'A\n\nB\n\nC']);
  });

  it('flush() resolves once everything is delivered', async () => {
    const t = setup();
    t.queue.enqueue('a');
    t.queue.enqueue('b');
    let flushed = false;
    void t.queue.flush().then(() => (flushed = true));

    await t.clock.advanceBy(500);
    expect(flushed).toBe(false);
    await t.clock.advanceBy(2000);
    expect(flushed).toBe(true);
  });

  it('stop() drops what is left, reports it, and accepts nothing more', async () => {
    const t = setup();
    t.send.mockRejectedValue(new Error('down'));
    t.queue.enqueue('a');
    await t.clock.advanceBy(100);

    t.queue.stop();
    t.queue.enqueue('b');
    await t.clock.advanceBy(60_000);

    expect(t.dropped.map((d) => [d.text, d.error])).toEqual([['a', 'stopped']]);
    expect(t.send).toHaveBeenCalledTimes(1);
  });
});
