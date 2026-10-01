import { useMemo, useState } from 'react';
import { FolderGit2, FolderOpen, Github, GitBranch, MessageSquare, MoreVertical, Plus, Repeat, Settings, SquareTerminal, Trash2 } from 'lucide-react';
import { useAppStore } from '../../store/appStore';
import { AgentAvatar } from '../../components/ui/Avatar';
import { GlassCard } from '../../components/ui/GlassCard';
import { EmptyState } from '../../components/ui/EmptyState';
import { MenuRow } from '../../components/ui/MenuRow';
import { Sheet } from '../../components/ui/Sheet';
import { Chip } from '../../components/ui/Chip';
import { NewProjectSheet } from '../projects/NewProjectSheet';
import { AgentSheet } from './AgentSheet';
import { RoutinesSheet, scheduleLabel } from '../routines/RoutinesSheet';
import { greeting, relTime } from '../../util/format';
import { InboxButton } from '../inbox/InboxSheet';
import { PresetGlyph } from '../code/Launcher';
import { estimateSize } from '../code/termInput';
import { usePrefs } from '../../store/prefs';
import { haptic } from '../../util/haptics';
import type { AgentId, Project } from '@agentdeck/shared';

export function HomeScreen() {
  const projects = useAppStore((s) => s.projects);
  const agents = useAppStore((s) => s.agents);
  const agentOrder = useAppStore((s) => s.agentOrder);
  const sessionsByProject = useAppStore((s) => s.sessionsByProject);
  const routines = useAppStore((s) => s.routines);
  const routinesLoaded = useAppStore((s) => s.routinesLoaded);
  const openProject = useAppStore((s) => s.openProject);
  const openSession = useAppStore((s) => s.openSession);
  const navigate = useAppStore((s) => s.navigate);
  const deleteProject = useAppStore((s) => s.deleteProject);
  const presets = useAppStore((s) => s.terminalPresets);
  const terminals = useAppStore((s) => s.terminals);
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const createTerminal = useAppStore((s) => s.createTerminal);
  const setActiveTerminal = useAppStore((s) => s.setActiveTerminal);
  const toast = useAppStore((s) => s.toast);

  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [routinesOpen, setRoutinesOpen] = useState(false);
  const [agentSheetId, setAgentSheetId] = useState<AgentId | null>(null);
  const [projectMenu, setProjectMenu] = useState<Project | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const greetingText = useMemo(() => greeting(), []);
  const sortedProjects = useMemo(() => [...projects].sort((a, b) => b.updatedAt - a.updatedAt), [projects]);
  const runningNow = useMemo(
    () =>
      projects.flatMap((p) =>
        (sessionsByProject[p.id] ?? [])
          .filter((s) => s.status === 'running' || s.status === 'queued')
          .map((s) => ({ session: s, project: p })),
      ),
    [projects, sessionsByProject],
  );
  const routineList = useMemo(
    () => Object.values(routines).sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity)),
    [routines],
  );

  const quickAgents = (presets ?? []).filter((p) => p.kind === 'agent' && p.available);
  const activeProject = projects.find((p) => p.id === activeProjectId);

  const quickLaunch = async (presetId: string) => {
    if (!activeProjectId) {
      toast('info', 'Create or pick a project first');
      return;
    }
    haptic('medium');
    const { cols, rows } = estimateSize(usePrefs.getState().termFontSize);
    try {
      await createTerminal(activeProjectId, cols, rows, { presetId });
      navigate({ name: 'code' });
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Failed to start');
    }
  };

  const openProjectAndChat = async (id: string) => {
    await openProject(id);
    navigate({ name: 'chat' });
  };

  return (
    <div className="flex min-h-full flex-col px-4 pb-8">
      {/* header */}
      <header className="flex items-center gap-1 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[22px] font-bold tracking-tight">{greetingText}</h1>
        </div>
        <InboxButton />
        <button
          type="button"
          aria-label="Settings"
          onClick={() => navigate({ name: 'settings' })}
          className="press tap flex h-11 w-11 items-center justify-center rounded-xl text-dim active:bg-white/[0.08] active:text-ink"
        >
          <Settings size={20} />
        </button>
      </header>

      {/* quick start: one tap → agent TUI in the active project */}
      {quickAgents.length > 0 && (
        <section aria-label="Quick start" className="mb-5">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="section-title">Start in {activeProject?.name ?? 'project'}</h2>
            <button type="button" onClick={() => navigate({ name: 'code' })} className="press text-[12px] font-medium text-accent">
              All launchers
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {quickAgents.slice(0, 4).map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => void quickLaunch(p.id)}
                className="press glass flex items-center gap-2.5 p-2.5 text-left active:bg-surface-2"
              >
                <PresetGlyph preset={p} size={36} />
                <span className="min-w-0">
                  <span className="block truncate text-[13.5px] font-semibold">{p.label}</span>
                  <span className="block truncate text-[11px] text-dim">Terminal session</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* live terminals */}
      {terminals.length > 0 && (
        <section aria-label="Live terminals" className="mb-5">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="section-title">Live terminals</h2>
            <span className="rounded-full bg-ok/15 px-2 py-[1px] text-[11px] font-semibold text-ok">{terminals.length}</span>
          </div>
          <div className="flex flex-col gap-2">
            {terminals.slice(0, 4).map((t) => {
              const preset = presets?.find((p) => p.id === t.presetId);
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    setActiveTerminal(t.id);
                    navigate({ name: 'code' });
                  }}
                  className="press tap glass flex items-center gap-3 p-3 text-left active:bg-surface-2"
                >
                  {preset ? <PresetGlyph preset={preset} size={32} /> : <SquareTerminal size={18} className="text-dim" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-semibold">{t.title ?? 'shell'}</span>
                    <span className="block truncate text-[11.5px] text-dim">
                      {projects.find((p) => p.id === t.projectId)?.name ?? 'project'}
                      {t.lastOutputAt ? ` · active ${relTime(t.lastOutputAt)}` : ''}
                    </span>
                  </span>
                  {t.attention ? (
                    <span className="rounded-full bg-warn/15 px-2 py-0.5 text-[11px] font-semibold text-warn">waiting</span>
                  ) : (
                    <span className="h-2 w-2 shrink-0 rounded-full bg-ok" />
                  )}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* agent status row */}
      <section aria-label="Agent status" className="no-scrollbar -mx-4 mb-4 flex gap-2.5 overflow-x-auto px-4 py-0.5">
        {agentOrder.map((id) => {
          const agent = agents[id];
          return (
            <button
              key={id}
              type="button"
              onClick={() => setAgentSheetId(id)}
              className="press tap flex w-[78px] shrink-0 flex-col items-center gap-1.5 rounded-2xl pt-1"
            >
              <AgentAvatar agent={agent} agentId={id} size="lg" showDot />
              <span className="w-full truncate text-center text-[11px] font-medium text-dim">
                {agent?.label ?? id}
              </span>
            </button>
          );
        })}
        {agentOrder.length === 0 && <p className="py-3 text-[13px] text-dim">No agents reported by the server.</p>}
      </section>

      {/* running now — BridgeMind's "dashboard of every agent running" */}
      {runningNow.length > 0 && (
        <section aria-label="Running now" className="mb-5">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="section-title">Running now</h2>
            <span className="rounded-full bg-accent/15 px-2 py-[1px] text-[11px] font-semibold text-accent">
              {runningNow.length}
            </span>
          </div>
          <div className="flex flex-col gap-2">
            {runningNow.map(({ session, project }) => (
              <button
                key={session.id}
                type="button"
                onClick={() => void openSession(session.id)}
                className="press tap glass flex items-center gap-3 p-3 text-left active:bg-surface-2"
              >
                <AgentAvatar agent={agents[session.agentId]} agentId={session.agentId} size="sm" glow />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-semibold">{session.title || 'Session'}</span>
                  <span className="block truncate text-[11.5px] text-dim">{project.name}</span>
                </span>
                <span className="h-2 w-2 shrink-0 rounded-full bg-accent pulse-dot" />
              </button>
            ))}
          </div>
        </section>
      )}

      {/* routines */}
      <section aria-label="Routines" className="mb-5">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="section-title">Routines</h2>
          <button
            type="button"
            onClick={() => setRoutinesOpen(true)}
            className="press flex items-center gap-1 text-[12px] font-medium text-accent"
          >
            <Repeat size={12} /> Manage
          </button>
        </div>
        {routineList.length === 0 ? (
          <button
            type="button"
            onClick={() => setRoutinesOpen(true)}
            className="press tap glass flex w-full items-center gap-3 p-3.5 text-left active:bg-surface-2"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent">
              <Repeat size={16} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13.5px] font-semibold">Put a job on a routine</span>
              <span className="block text-[12px] leading-snug text-dim">
                {routinesLoaded ? 'Recurring agent runs — e.g. a morning build check.' : 'Loading…'}
              </span>
            </span>
          </button>
        ) : (
          <div className="flex flex-col gap-2">
            {routineList.slice(0, 3).map((routine) => (
              <button
                key={routine.id}
                type="button"
                onClick={() => setRoutinesOpen(true)}
                className="press tap glass flex items-center gap-3 p-3 text-left active:bg-surface-2"
              >
                <AgentAvatar agent={agents[routine.agentId]} agentId={routine.agentId} size="sm" glow={false} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-semibold">{routine.name}</span>
                  <span className="block truncate text-[11.5px] text-dim">
                    {scheduleLabel(routine.schedule)}
                    {routine.enabled && routine.nextRunAt
                      ? ` · next ${relTime(routine.nextRunAt)}`
                      : routine.enabled
                        ? ''
                        : ' · paused'}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* projects */}
      <section aria-label="Projects" className="flex-1">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold">Projects</h2>
          <span className="text-[12px] text-dim">{projects.length}</span>
        </div>

        {sortedProjects.length === 0 ? (
          <GlassCard>
            <EmptyState
              icon={FolderGit2}
              title="No projects yet"
              hint="Create a blank project or clone one from GitHub to start driving agents."
              action={
                <button
                  type="button"
                  onClick={() => setNewProjectOpen(true)}
                  className="press tap btn-primary inline-flex items-center gap-2 rounded-2xl px-5 text-[14px] font-semibold text-white"
                >
                  <Plus size={16} /> New project
                </button>
              }
            />
          </GlassCard>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {sortedProjects.map((project) => {
              const sessionCount = sessionsByProject[project.id]?.length;
              return (
                <div key={project.id} className="glass press relative p-4" onClick={() => void openProjectAndChat(project.id)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && void openProjectAndChat(project.id)}>
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="min-w-0 flex-1 truncate text-[15px] font-semibold leading-tight">{project.name}</h3>
                    <button
                      type="button"
                      aria-label={`Project ${project.name} options`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setProjectMenu(project);
                        setConfirmDelete(false);
                      }}
                      className="-mr-1.5 -mt-1.5 tap flex h-11 w-11 items-center justify-center rounded-xl text-dim active:bg-white/10 active:text-ink"
                    >
                      <MoreVertical size={17} />
                    </button>
                  </div>
                  <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                    {project.git?.branch && (
                      <Chip dot="#4E8CFF">
                        <GitBranch size={11} className="-ml-0.5" />
                        {project.git.branch}
                      </Chip>
                    )}
                    {sessionCount !== undefined && sessionCount > 0 && (
                      <Chip>
                        <MessageSquare size={11} className="-ml-0.5" />
                        {sessionCount} {sessionCount === 1 ? 'session' : 'sessions'}
                      </Chip>
                    )}
                  </div>
                  <p className="mt-2.5 text-[11.5px] text-dim/80">Updated {relTime(project.updatedAt)}</p>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* FAB — right edge of the centered column, above the tab bar */}
      <button
        type="button"
        aria-label="Add project"
        onClick={() => setNewProjectOpen(true)}
        className="press btn-primary fixed left-1/2 bottom-[calc(88px+var(--ad-safe-bottom))] z-20 flex h-14 w-14 items-center justify-center rounded-full text-white"
        style={{ transform: 'translateX(calc(min(50vw, 18rem) - 76px))' }}
      >
        <Plus size={26} />
      </button>

      {/* project actions */}
      <Sheet open={projectMenu !== null} onClose={() => setProjectMenu(null)} title={projectMenu?.name}>
        {projectMenu && (
          <div className="flex flex-col gap-1.5">
            <MenuRow
              icon={<MessageSquare size={18} strokeWidth={1.8} />}
              label="Sessions"
              description="Continue chats"
              onClick={() => {
                const id = projectMenu.id;
                setProjectMenu(null);
                void openProjectAndChat(id);
              }}
            />
            <MenuRow
              icon={<FolderOpen size={18} strokeWidth={1.8} />}
              label="Files"
              description="Browse & edit"
              onClick={() => {
                const id = projectMenu.id;
                setProjectMenu(null);
                void openProjectAndChat(id).then(() => navigate({ name: 'files' }));
              }}
            />
            <MenuRow
              icon={<Github size={18} strokeWidth={1.8} />}
              label="Git"
              description="Changes, branches, history"
              onClick={() => {
                const id = projectMenu.id;
                setProjectMenu(null);
                void openProjectAndChat(id).then(() => navigate({ name: 'git' }));
              }}
            />
            <div className="my-1.5 h-px bg-line" />
            {confirmDelete ? (
              <button
                type="button"
                onClick={() => {
                  const id = projectMenu.id;
                  setProjectMenu(null);
                  void deleteProject(id);
                }}
                className="press tap flex w-full items-center rounded-2xl bg-danger/12 px-4 py-3 text-left text-[14.5px] font-medium text-danger active:bg-danger/20"
              >
                Tap again to remove “{projectMenu.name}”
              </button>
            ) : (
              <MenuRow
                icon={<Trash2 size={18} strokeWidth={1.8} />}
                label="Remove from deck"
                description="Unregister on this server"
                danger
                onClick={() => setConfirmDelete(true)}
              />
            )}
          </div>
        )}
      </Sheet>

      <NewProjectSheet open={newProjectOpen} onClose={() => setNewProjectOpen(false)} />
      <RoutinesSheet open={routinesOpen} onClose={() => setRoutinesOpen(false)} />
      <AgentSheet agentId={agentSheetId} open={agentSheetId !== null} onClose={() => setAgentSheetId(null)} />
    </div>
  );
}
