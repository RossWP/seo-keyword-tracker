import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { RankHistory } from './page-detail-api';
import { shortDate } from './dates';

/**
 * Categorical palette (validated for colour-blind separation, in fixed order). A keyword keeps
 * its colour by its rank on the page, never by what else is selected.
 */
export const SERIES_COLORS = [
  '#2a78d6',
  '#eb6834',
  '#1baf7a',
  '#eda100',
  '#e87ba4',
  '#008300',
  '#4a3aa7',
  '#e34948',
];

export const seriesColor = (index: number) =>
  SERIES_COLORS[index % SERIES_COLORS.length] ?? '#52514e';

type Row = Record<string, string | number | null>;

/** One row per local day, one column per keyword: the shape a multi-line chart needs. */
export function toRows(series: RankHistory['series']): Row[] {
  const byDate = new Map<string, Row>();
  for (const { keywordId, points } of series) {
    for (const { date, position } of points) {
      const row = byDate.get(date) ?? { date };
      row[String(keywordId)] = position;
      byDate.set(date, row);
    }
  }
  return [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

export function RankChart({
  series,
  colorIndex,
}: {
  series: RankHistory['series'];
  colorIndex: Map<number, number>;
}) {
  const rows = toRows(series);
  const worst = Math.max(
    1,
    ...series.flatMap((line) => line.points.map((point) => point.position ?? 1)),
  );
  // Fit the scale to the data (never past 100) with round ticks that always include #1.
  const step = worst <= 20 ? 5 : worst <= 50 ? 10 : 25;
  const bottom = Math.min(100, Math.ceil((worst + 1) / step) * step);
  const ticks = [1, ...Array.from({ length: bottom / step }, (_, i) => (i + 1) * step)];
  return (
    <div
      className="h-80 w-full"
      role="img"
      aria-label="Rank position history; the table view lists the same values"
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
          <CartesianGrid stroke="#e7e5e4" vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={(value: string) => shortDate(value)}
            tick={{ fontSize: 12, fill: '#52514e' }}
            minTickGap={24}
            stroke="#d6d3d1"
          />
          {/* Position 1 is the best, so it sits at the top. */}
          <YAxis
            reversed
            domain={[1, bottom]}
            ticks={ticks}
            interval={0}
            width={40}
            tick={{ fontSize: 12, fill: '#52514e' }}
            stroke="#d6d3d1"
          />
          <Tooltip
            labelFormatter={(value) => (typeof value === 'string' ? shortDate(value) : '')}
            formatter={(value, name) => [value ?? 'Not in top 100', name]}
            contentStyle={{ fontSize: 12 }}
            itemStyle={{ color: '#0b0b0b' }}
          />
          {series.map((line) => (
            <Line
              key={line.keywordId}
              type="monotone"
              dataKey={String(line.keywordId)}
              name={line.term}
              stroke={seriesColor(colorIndex.get(line.keywordId) ?? 0)}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function RankTable({ series }: { series: RankHistory['series'] }) {
  const rows = toRows(series).reverse();
  return (
    <div className="max-h-80 overflow-auto rounded border border-slate-200">
      <table className="w-full text-left text-sm" aria-label="Position history">
        <thead className="sticky top-0 bg-slate-50 text-slate-600">
          <tr>
            <th className="px-3 py-2 font-medium">Date</th>
            {series.map((line) => (
              <th key={line.keywordId} className="px-3 py-2 font-medium">
                {line.term}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.date)} className="border-t border-slate-100">
              <td className="px-3 py-1.5 tabular-nums">{String(row.date)}</td>
              {series.map((line) => {
                const value = row[String(line.keywordId)];
                return (
                  <td key={line.keywordId} className="px-3 py-1.5 tabular-nums">
                    {value === undefined ? '' : value === null ? '—' : `#${value}`}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
