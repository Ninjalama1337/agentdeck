import { clsx } from 'clsx';
import { useAppStore } from '../store/appStore';

/** Horizontal scroller of project chips — picks the active project. */
export function ProjectPicker({ className }: { className?: string }) {
  const projects = useAppStore((s) => s.projects);
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const setActiveProject = useAppStore((s) => s.setActiveProject);

  if (projects.length === 0) return null;

  return (
    <div className={clsx('no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 py-0.5', className)}>
      {projects.map((p) => {
        const active = p.id === activeProjectId;
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => setActiveProject(p.id)}
            className={clsx(
              'press tap flex shrink-0 items-center rounded-full border px-3.5 text-[13px] font-medium',
              active ? 'border-accent/45 bg-accent/15 text-ink' : 'border-line bg-white/[0.04] text-dim',
            )}
          >
            <span className="max-w-[180px] truncate">{p.name}</span>
          </button>
        );
      })}
    </div>
  );
}
