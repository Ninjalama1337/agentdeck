import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3,
  Cpu,
  FileText,
  Folder,
  FolderGit2,
  Gauge,
  Home,
  MessageSquare,
  Search,
  Settings,
  SquareTerminal,
  TerminalSquare,
  type LucideIcon,
} from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../api/client';
import { useAppStore } from '../store/appStore';
import { registerOverlayClose } from '../util/overlayHistory';
import { rankItems } from '../util/quickOpen';
import { FileEditorSheet } from '../features/files/FileEditorSheet';
import { openResources } from '../features/code/ResourcesSheet';

/** Event that opens quick open (shortcut, search buttons). */
export const OPEN_QUICK_OPEN = 'agentdeck:quick-open';

export function openQuickOpen(): void {
  window.dispatchEvent(new Event(OPEN_QUICK_OPEN));
}

interface Item {
  id: string;
  group: string;
  title: string;
  detail?: string;
  icon: LucideIcon;
  color?: string;
  text: string;
  boost?: number;
  run: () => void;
}

/** File lists per project, reused for a minute — typing must not refetch. */
const indexCache = new Map<string, { at: number; paths: string[] }>();

/**
 * Quick open (Ctrl/Cmd+P, the search buttons): one search over screens,
 * projects, terminals, chats and the active project's files.
 */
export function QuickOpen() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [files, setFiles] = useState<string[]>([]);
  const [filePath, setFilePath] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const projects = useAppStore((s) => s.projects);
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const terminals = useAppStore((s) => s.terminals);
  const presets = useAppStore((s) => s.terminalPresets);
  const sessionsByProject = useAppStore((s) => s.sessionsByProject);

  // Keys typed right after the shortcut, before the field is up, belong to the search.
  const stopBuffering = useRef<(() => void) | null>(null);
  useEffect(() => {
    const show = () => {
      setQuery('');
      setCursor(0);
      setOpen(true);
      stopBuffering.current?.();
      const buffer = (e: KeyboardEvent) => {
        if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
        e.preventDefault();
        e.stopPropagation();
        setQuery((q) => q + e.key);
      };
      window.addEventListener('keydown', buffer, true);
      stopBuffering.current = () => {
        window.removeEventListener('keydown', buffer, true);
        stopBuffering.current = null;
      };
    };
    window.addEventListener(OPEN_QUICK_OPEN, show);
    return () => {
      window.removeEventListener(OPEN_QUICK_OPEN, show);
      stopBuffering.current?.();
    };
  }, []);

  // The field has focus once it rendered (autoFocus) — it takes the keys from here on.
  useEffect(() => {
    if (open) stopBuffering.current?.();
  }, [open]);

  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    const store = useAppStore.getState();
    store.pushOverlay();
    const releaseBack = registerOverlayClose(() => setOpen(false));
    return () => {
      releaseBack();
      useAppStore.getState().popOverlay();
    };
  }, [open]);

  // The active project's files, fetched once per open (cached for a minute).
  useEffect(() => {
    if (!open || !activeProjectId) return;
    const cached = indexCache.get(activeProjectId);
    if (cached && Date.now() - cached.at < 60_000) {
      setFiles(cached.paths);
      return;
    }
    let live = true;
    void api
      .fileIndex(activeProjectId)
      .then(({ paths }) => {
        indexCache.set(activeProjectId, { at: Date.now(), paths });
        if (live) setFiles(paths);
      })
      .catch(() => live && setFiles([]));
    return () => {
      live = false;
    };
  }, [open, activeProjectId]);

  const items = useMemo<Item[]>(() => {
    const store = useAppStore.getState();
    const go = (name: 'home' | 'chat' | 'code' | 'git' | 'files' | 'settings') => () => store.navigate({ name });
    const projectName = (id: string) => projects.find((p) => p.id === id)?.name;
    const list: Item[] = [
      { id: 'go:home', group: 'Go to', title: 'Home', icon: Home, text: 'home', run: go('home') },
      { id: 'go:chat', group: 'Go to', title: 'Chat', icon: MessageSquare, text: 'chat', run: go('chat') },
      { id: 'go:code', group: 'Go to', title: 'Code — terminals', icon: TerminalSquare, text: 'code terminals', run: go('code') },
      { id: 'go:git', group: 'Go to', title: 'Git — changes & history', icon: FolderGit2, text: 'git changes history', run: go('git') },
      { id: 'go:files', group: 'Go to', title: 'Files', icon: Folder, text: 'files', run: go('files') },
      { id: 'go:settings', group: 'Go to', title: 'Settings', icon: Settings, text: 'settings', run: go('settings') },
      { id: 'go:usage', group: 'Go to', title: 'Usage limits', icon: Gauge, text: 'usage limits', run: () => store.setUsageSheetOpen(true) },
      { id: 'go:resources', group: 'Go to', title: 'Resources — CPU & memory', icon: Cpu, text: 'resources cpu memory processes', run: openResources },
      { id: 'go:activity', group: 'Go to', title: 'Activity — runs, tokens, cost', icon: BarChart3, text: 'activity stats cost tokens', run: () => store.setActivitySheetOpen(true) },
    ];
    for (const t of terminals) {
      list.push({
        id: `term:${t.id}`,
        group: 'Terminals',
        title: t.title ?? 'shell',
        detail: projectName(t.projectId),
        icon: SquareTerminal,
        color: presets?.find((p) => p.id === t.presetId)?.accent,
        text: `${t.title ?? 'shell'} ${projectName(t.projectId) ?? ''}`,
        boost: 4,
        run: () => store.openTarget(`terminal:${t.id}`),
      });
    }
    for (const p of projects) {
      list.push({
        id: `project:${p.id}`,
        group: 'Projects',
        title: p.name,
        detail: p.id === activeProjectId ? 'current' : undefined,
        icon: Folder,
        text: p.name,
        boost: 2,
        run: () => store.setActiveProject(p.id),
      });
    }
    const chats = Object.values(sessionsByProject)
      .flat()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 40);
    for (const s of chats) {
      list.push({
        id: `chat:${s.id}`,
        group: 'Chats',
        title: s.title || 'Chat',
        detail: projectName(s.projectId),
        icon: MessageSquare,
        text: `${s.title} ${projectName(s.projectId) ?? ''}`,
        boost: 1,
        run: () => store.openTarget(`session:${s.id}`),
      });
    }
    for (const path of files) {
      list.push({
        id: `file:${path}`,
        group: 'Files',
        title: path.slice(path.lastIndexOf('/') + 1),
        detail: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : undefined,
        icon: FileText,
        text: path,
        run: () => setFilePath(path),
      });
    }
    return list;
  }, [projects, activeProjectId, terminals, presets, sessionsByProject, files]);

  const results = useMemo(() => {
    // Without a query: places and live things, not thousands of files.
    if (!query.trim()) return items.filter((i) => i.group !== 'Files' && i.group !== 'Chats').slice(0, 30);
    return rankItems(items, query, 60);
  }, [items, query]);

  useEffect(() => setCursor(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${cursor}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const choose = (item: Item | undefined) => {
    if (!item) return;
    close();
    item.run();
  };

  return (
    <>
      {open && (
        <div className="modal-backdrop flex items-start justify-center p-3 pt-[10dvh]" onClick={close}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Quick open"
            className="modal-card glass flex max-h-[70dvh] w-full max-w-xl flex-col overflow-hidden p-0"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2.5 border-b border-line px-3.5">
              <Search size={17} className="shrink-0 text-dim" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setCursor((c) => Math.min(results.length - 1, c + 1));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setCursor((c) => Math.max(0, c - 1));
                  } else if (e.key === 'Enter') {
                    e.preventDefault();
                    choose(results[cursor]);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    close();
                  }
                }}
                placeholder="Search terminals, projects, chats, files…"
                className="h-12 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-dim/60"
                aria-controls="quick-open-results"
                aria-activedescendant={results[cursor] ? `qo-${cursor}` : undefined}
              />
            </div>
            <ul id="quick-open-results" ref={listRef} role="listbox" className="no-scrollbar overflow-y-auto p-1.5">
              {results.length === 0 && <li className="px-3 py-6 text-center text-[13px] text-dim">Nothing found.</li>}
              {results.map((item, i) => {
                const Icon = item.icon;
                const showGroup = i === 0 || results[i - 1]!.group !== item.group;
                return (
                  <li key={item.id} role="presentation">
                    {showGroup && !query.trim() && (
                      <p className="px-2.5 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wide text-dim">{item.group}</p>
                    )}
                    <button
                      id={`qo-${i}`}
                      type="button"
                      role="option"
                      aria-selected={i === cursor}
                      data-index={i}
                      onMouseMove={() => setCursor(i)}
                      onClick={() => choose(item)}
                      className={clsx(
                        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left',
                        i === cursor ? 'bg-white/[0.08]' : 'active:bg-white/[0.06]',
                      )}
                    >
                      <Icon size={15} className="shrink-0 text-dim" style={item.color ? { color: item.color } : undefined} />
                      <span className="min-w-0 flex-1 truncate text-[13.5px]">
                        {item.title}
                        {item.detail && <span className="text-dim"> · {item.detail}</span>}
                      </span>
                      {query.trim() && <span className="shrink-0 text-[10.5px] text-dim">{item.group}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
      {activeProjectId && (
        <FileEditorSheet
          open={filePath !== null}
          projectId={activeProjectId}
          path={filePath ?? ''}
          onClose={() => setFilePath(null)}
        />
      )}
    </>
  );
}
