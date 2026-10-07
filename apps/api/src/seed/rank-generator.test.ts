import { describe, expect, it } from 'vitest';
import { generateSeries, historyDays, snapshotDates } from './rank-generator.js';

describe('historyDays', () => {
  it('keeps a year of history and grows it when there are few pairs', () => {
    expect(historyDays(240, 50_000)).toBe(365);
    expect(historyDays(100, 50_000)).toBe(500);
    expect(historyDays(0, 50_000)).toBe(365);
  });
});

describe('snapshotDates', () => {
  it('lists UTC days ending today, oldest first', () => {
    expect(snapshotDates(new Date('2026-10-07T23:59:00Z'), 3)).toEqual([
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
    ]);
  });
});

describe('generateSeries', () => {
  const dates = snapshotDates(new Date('2026-10-07T12:00:00Z'), 365);
  const series = generateSeries('https://a.example/post/|keyword research', 1, dates);

  it('is deterministic for the same page and keyword', () => {
    expect(generateSeries('https://a.example/post/|keyword research', 1, dates)).toEqual(series);
    expect(generateSeries('https://a.example/post/|link building', 1, dates)).not.toEqual(series);
  });

  it('captures at 02:30 UTC, which is the previous evening in Toronto', () => {
    expect(series.at(-1)).toMatchObject({ snapshotDate: '2026-10-07' });
    expect(series.at(-1)?.capturedAt.toISOString()).toBe('2026-10-07T02:30:00.000Z');
  });

  it('stays within 1–100 or null, with some days not ranking', () => {
    const positions = series.map((row) => row.position);
    expect(positions.every((value) => value === null || (value >= 1 && value <= 100))).toBe(true);
    const missing = positions.filter((value) => value === null).length;
    expect(missing).toBeGreaterThan(5);
    expect(missing).toBeLessThan(40);
  });

  it('ranks stronger keywords higher on average', () => {
    const average = (rankOrder: number) => {
      const values = Array.from({ length: 20 }, (_, i) =>
        generateSeries(`page-${i}|term`, rankOrder, dates).flatMap((row) =>
          row.position === null ? [] : [row.position],
        ),
      ).flat();
      return values.reduce((sum, value) => sum + value, 0) / values.length;
    };
    expect(average(1)).toBeLessThan(average(8));
  });
});
