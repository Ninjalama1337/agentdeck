import { useMemo, useState } from 'react';
import { clsx } from 'clsx';

const PAGE = 1500;

/** Colored unified diff (add/del/hunk/meta lines), paged for huge diffs. */
export function DiffView({ diff, truncated }: { diff: string; truncated?: boolean }) {
  const lines = useMemo(() => diff.replace(/\n$/, '').split('\n'), [diff]);
  const [limit, setLimit] = useState(PAGE);
  if (!diff.trim()) return <p className="py-6 text-center text-[13px] text-dim">No textual changes.</p>;
  return (
    <div>
      <div className="diff">
        {lines.slice(0, limit).map((line, i) => (
          <div
            key={i}
            className={clsx(
              line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')
                ? 'meta'
                : line.startsWith('+')
                  ? 'add'
                  : line.startsWith('-')
                    ? 'del'
                    : line.startsWith('@@')
                      ? 'hunk'
                      : undefined,
            )}
          >
            {line || ' '}
          </div>
        ))}
      </div>
      {lines.length > limit && (
        <button
          type="button"
          onClick={() => setLimit((l) => l + PAGE)}
          className="press tap mt-2 w-full rounded-2xl border border-line text-[13px] font-medium text-dim"
        >
          Show {Math.min(PAGE, lines.length - limit)} more lines
        </button>
      )}
      {truncated && <p className="mt-2 text-center text-[12px] text-warn">Diff truncated by the server.</p>}
    </div>
  );
}

/** +/- counts of a unified diff. */
export function diffStats(diff: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) add++;
    else if (line.startsWith('-') && !line.startsWith('---')) del++;
  }
  return { add, del };
}
