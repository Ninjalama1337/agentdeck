import { useState } from 'react';
import { Check, ChevronDown, FolderGit2, GitBranch, Plus } from 'lucide-react';
import { clsx } from 'clsx';
import { useAppStore } from '../store/appStore';
import { Sheet } from './ui/Sheet';
import { NewProjectSheet } from '../features/projects/NewProjectSheet';
import { haptic } from '../util/haptics';

/**
 * Compact project switcher for screen headers: the active project's name as
 * a title-sized button, tap → sheet with every project (+ new project).
 * Replaces the old full-width chip scroller that cost a whole row.
 */
export function ProjectSwitcher({ subtitle, className }: { subtitle?: string; className?: string }) {
  const projects = useAppStore((s) => s.projects);
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const openProject = useAppStore((s) => s.openProject);
  const [open, setOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const project = projects.find((p) => p.id === activeProjectId);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={clsx('press flex min-w-0 flex-col items-start rounded-xl py-0.5 text-left', className)}
        aria-label="Switch project"
      >
        <span className="flex max-w-full items-center gap-1">
          <span className="truncate text-[19px] font-bold tracking-tight">{project?.name ?? 'No project'}</span>
          <ChevronDown size={17} className="mt-0.5 shrink-0 text-dim" />
        </span>
        {subtitle !== undefined ? (
          <span className="max-w-full truncate text-[12px] text-dim">{subtitle}</span>
        ) : project?.git?.branch ? (
          <span className="flex max-w-full items-center gap-1 truncate text-[12px] text-dim">
            <GitBranch size={11} /> {project.git.branch}
            {project.git.dirty ? <span className="text-warn">· {project.git.dirty} changed</span> : null}
          </span>
        ) : null}
      </button>

      <Sheet open={open} onClose={() => setOpen(false)} title="Projects" subtitle={`${projects.length} on this server`}>
        <div className="flex flex-col gap-1.5">
          {projects.map((p) => {
            const active = p.id === activeProjectId;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  haptic();
                  setOpen(false);
                  if (!active) void openProject(p.id);
                }}
                className={clsx(
                  'press tap flex w-full items-center gap-3 rounded-2xl border px-3.5 py-2.5 text-left',
                  active ? 'border-accent/40 bg-accent/10' : 'border-line bg-white/[0.03] active:bg-white/[0.07]',
                )}
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/[0.06] text-dim">
                  <FolderGit2 size={17} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14.5px] font-semibold">{p.name}</span>
                  <span className="block truncate text-[12px] text-dim">
                    {p.git?.branch ? `${p.git.branch}${p.git.dirty ? ` · ${p.git.dirty} changed` : ''}` : 'no git'}
                  </span>
                </span>
                {active && <Check size={17} className="shrink-0 text-accent" />}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setNewOpen(true);
            }}
            className="press tap mt-1 flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-line-strong px-4 py-2.5 text-[14px] font-medium text-dim active:bg-white/[0.05]"
          >
            <Plus size={16} /> New or cloned project
          </button>
        </div>
      </Sheet>
      <NewProjectSheet open={newOpen} onClose={() => setNewOpen(false)} />
    </>
  );
}
