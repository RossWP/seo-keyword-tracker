/**
 * Invented but plausible rank history. Deterministic: the same page, keyword and dates always
 * give the same positions, on any machine, so re-running the seed is reproducible.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Snapshots are taken at 02:30 UTC: the previous evening in Toronto, which exercises time zones. */
export const CAPTURE_HOUR_UTC = 2;
export const CAPTURE_MINUTE_UTC = 30;
const NOT_RANKING_CHANCE = 0.05;
/** Shared "algorithm update" days move every keyword at once, as real ones do. */
const UPDATE_DAY_CHANCE = 0.02;

export interface SnapshotRow {
  snapshotDate: string;
  capturedAt: Date;
  position: number | null;
}

/** Days of history needed so that `pairs` page–keyword pairs produce at least `minRows` rows. */
export function historyDays(pairs: number, minRows: number, minDays = 365): number {
  if (pairs <= 0) return minDays;
  return Math.max(minDays, Math.ceil(minRows / pairs));
}

/** UTC calendar days ending today, oldest first, as YYYY-MM-DD. */
export function snapshotDates(today: Date, days: number): string[] {
  const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Array.from({ length: days }, (_, i) =>
    new Date(end - (days - 1 - i) * DAY_MS).toISOString().slice(0, 10),
  );
}

/**
 * A mean-reverting random walk around a base position: stronger keywords (lower rank order)
 * sit higher, days move by a few places, update days jump 5–15 places, and about 5% of days
 * the page is outside the top 100 (null).
 */
export function generateSeries(seedKey: string, rankOrder: number, dates: string[]): SnapshotRow[] {
  const random = mulberry32(hash(seedKey));
  const base = Math.min(90, 2 + rankOrder * 6 + random() * 15);
  const direction = random() < 0.5 ? -1 : 1;
  let position = base + (random() - 0.5) * 10;

  return dates.map((snapshotDate) => {
    position += 0.15 * (base - position) + (random() + random() + random() - 1.5) * 2;
    if (dayRandom(snapshotDate) < UPDATE_DAY_CHANCE) position += direction * (5 + random() * 10);
    position = Math.min(100, Math.max(1, position));
    const ranked = random() >= NOT_RANKING_CHANCE;
    return {
      snapshotDate,
      capturedAt: new Date(`${snapshotDate}T0${CAPTURE_HOUR_UTC}:${CAPTURE_MINUTE_UTC}:00Z`),
      position: ranked ? Math.round(position) : null,
    };
  });
}

function dayRandom(date: string): number {
  return mulberry32(hash(`update:${date}`))();
}

/** FNV-1a: a small, stable string hash for seeding. */
function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Tiny seeded PRNG; Math.random can't be seeded. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
