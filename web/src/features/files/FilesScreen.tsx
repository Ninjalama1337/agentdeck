import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  File as FileIcon,
  FileArchive,
  FileCode,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Image as ImageIcon,
  Loader2,
  MoreVertical,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react';
import { clsx } from 'clsx';
import type { FileEntry } from '@agentdeck/shared';
import { api, ApiError, fetchBlob, uploadFile } from '../../api/client';
import { errorMessage, useAppStore } from '../../store/appStore';
import { EmptyState } from '../../components/ui/EmptyState';
import { Button, IconButton } from '../../components/ui/Button';
import { MenuRow } from '../../components/ui/MenuRow';
import { Modal } from '../../components/ui/Modal';
import { ProjectSwitcher } from '../../components/ProjectSwitcher';
import { Sheet } from '../../components/ui/Sheet';
import { FileEditorSheet } from './FileEditorSheet';
import { bytes, fileVisualKind, relTime, type FileVisualKind } from '../../util/format';

const KIND_ICONS: Record<FileVisualKind, typeof FileIcon> = {
  image: ImageIcon,
  code: FileCode,
  text: FileText,
  archive: FileArchive,
  file: FileIcon,
};

export function FilesScreen() {
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  if (!activeProjectId) {
    return (
      <div className="flex min-h-full flex-col px-4 pb-8">
        <header className="py-4">
          <h1 className="text-[20px] font-bold tracking-tight">Files</h1>
        </header>
        <div className="glass">
          <EmptyState
            icon={FolderPlus}
            title="No project selected"
            hint="Pick or create a project to browse its files."
            action={
              <button
                type="button"
                onClick={() => useAppStore.getState().navigate({ name: 'home' })}
                className="press tap rounded-2xl px-5 text-[14px] font-semibold text-white btn-primary"
              >
                Go to projects
              </button>
            }
          />
        </div>
      </div>
    );
  }
  return <FilesScreenInner key={activeProjectId} projectId={activeProjectId} />;
}

function FilesScreenInner({ projectId }: { projectId: string }) {
  const toast = useAppStore((s) => s.toast);
  const setLightbox = useAppStore((s) => s.setLightbox);
  const filesVersion = useAppStore((s) => s.filesVersion[projectId] ?? 0);

  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDot, setShowDot] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [actionEntry, setActionEntry] = useState<FileEntry | null>(null);
  const [editorPath, setEditorPath] = useState<string | null>(null);
  const [createKind, setCreateKind] = useState<'file' | 'dir' | null>(null);
  const [createName, setCreateName] = useState('');
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);
  const [deleting, setDeleting] = useState(false);
  const uploadInput = useRef<HTMLInputElement | null>(null);


  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      setError(null);
      try {
        const list = await api.files(projectId, path || undefined, showDot);
        const sorted = [...list].sort((a, b) => {
          if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        setEntries(sorted);
      } catch (err) {
        setError(errorMessage(err));
        setEntries([]);
      } finally {
        setLoading(false);
      }
    },
    [projectId, path, showDot],
  );

  useEffect(() => {
    void load();
  }, [load]);

  /* Live updates: watcher batches + agent-run ends bump filesVersion; the
     500 ms debounce coalesces optimistic bumps and watcher echoes so the
     listing never double-flashes. */
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  useEffect(() => {
    if (filesVersion === 0) return;
    const t = window.setTimeout(() => void loadRef.current(true), 500);
    return () => window.clearTimeout(t);
  }, [filesVersion]);

  const crumbs = path ? path.split('/') : [];

  const enter = (entry: FileEntry) => {
    if (entry.kind === 'dir') setPath(entry.path);
    else void openFile(entry);
  };

  /** Images open the lightbox via the raw URL; everything else the editor. */
  const openFile = async (entry: FileEntry) => {
    if (fileVisualKind(entry.name, 'file') === 'image') {
      try {
        const blob = await fetchBlob(api.fileRawPath(projectId, entry.path));
        const url = URL.createObjectURL(blob);
        setLightbox({ url, name: entry.name });
      } catch (err) {
        toast('error', errorMessage(err));
      }
      return;
    }
    setEditorPath(entry.path);
  };

  const download = async (entry: FileEntry) => {
    setActionEntry(null);
    try {
      const blob = await fetchBlob(api.fileRawPath(projectId, entry.path));
      const file = new File([blob], entry.name, { type: blob.type || 'application/octet-stream' });
      const canShare = typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
      if (canShare) {
        await navigator.share({ files: [file], title: entry.name });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = entry.name;
        a.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 8000);
      }
    } catch (err) {
      if (err instanceof ApiError) toast('error', errorMessage(err));
      /* user cancelled the share sheet — ignore */
    }
  };

  const upload = async (files: File[]) => {
    for (const file of files) {
      setUploading((n) => n + 1);
      try {
        await uploadFile(projectId, file, path || 'uploads');
        toast('info', `Uploaded ${file.name}`);
      } catch (err) {
        toast('error', `Upload failed: ${errorMessage(err)}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
    useAppStore.getState().bumpFilesVersion(projectId);
  };

  const submitCreate = async () => {
    if (createKind === null || creating) return;
    const clean = createName.trim().replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
    const invalid =
      clean === '' || clean.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
    if (invalid) {
      toast('error', 'Enter a valid relative path (no “..”)');
      return;
    }
    const full = path ? `${path}/${clean}` : clean;
    setCreating(true);
    try {
      await api.createEntry(projectId, full, createKind);
      toast('info', `Created ${full}`);
      setCreateKind(null);
      setCreateName('');
      // Optimistic refresh; the watcher echo coalesces in the debounced effect.
      useAppStore.getState().bumpFilesVersion(projectId);
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const submitDelete = async () => {
    const target = deleteTarget;
    if (!target || deleting) return;
    setDeleting(true);
    try {
      await api.deleteEntry(projectId, target.path, target.kind === 'dir');
      toast('info', `Deleted ${target.path}`);
      setDeleteTarget(null);
      useAppStore.getState().bumpFilesVersion(projectId);
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex min-h-full flex-col px-4 pb-8">
      <header className="flex items-center justify-between gap-1 py-2">
        <ProjectSwitcher className="min-w-0 flex-1" subtitle="Files" />
        <div className="flex shrink-0 items-center">
          <IconButton
            label={showDot ? 'Hide dotfiles' : 'Show dotfiles'}
            onClick={() => setShowDot((v) => !v)}
            className={showDot ? 'text-accent' : ''}
          >
            {showDot ? <Eye size={18} /> : <EyeOff size={18} />}
          </IconButton>
          <IconButton label="Refresh" onClick={() => void load()}>
            {loading ? <Loader2 size={18} className="animate-spin" /> : <RefreshCw size={18} />}
          </IconButton>
          <IconButton
            label="Upload files"
            onClick={() => uploadInput.current?.click()}
            className={uploading > 0 ? 'text-accent' : ''}
          >
            {uploading > 0 ? <Loader2 size={18} className="animate-spin" /> : <Upload size={18} />}
          </IconButton>
        </div>
      </header>


      {/* breadcrumbs + create actions */}
      <nav aria-label="Breadcrumb" className="no-scrollbar mb-2.5 flex items-center gap-0.5 overflow-x-auto text-[12.5px]">
        <button type="button" onClick={() => setPath('')} className="tap flex h-9 shrink-0 items-center rounded-lg px-2 font-medium text-dim active:text-ink">
          root
        </button>
        {crumbs.map((seg, i) => {
          const target = crumbs.slice(0, i + 1).join('/');
          const isLast = i === crumbs.length - 1;
          return (
            <span key={target} className="flex shrink-0 items-center">
              <ChevronRight size={12} className="text-dim/50" />
              <button
                type="button"
                onClick={() => setPath(target)}
                className={clsx('tap flex h-9 items-center rounded-lg px-2', isLast ? 'font-semibold text-ink' : 'text-dim active:text-ink')}
              >
                {seg}
              </button>
            </span>
          );
        })}
        <span className="ml-auto flex shrink-0 items-center gap-0.5 pl-1">
          <IconButton label="New file" onClick={() => { setCreateName(''); setCreateKind('file'); }} className="h-9 w-9">
            <FilePlus2 size={16} />
          </IconButton>
          <IconButton label="New folder" onClick={() => { setCreateName(''); setCreateKind('dir'); }} className="h-9 w-9">
            <FolderPlus size={16} />
          </IconButton>
        </span>
      </nav>

      {/* list */}
      {error ? (
        <div className="glass">
          <EmptyState
            icon={FolderOpen}
            title="Could not load files"
            hint={error}
            action={
              <button type="button" onClick={() => void load()} className="press tap rounded-2xl border border-line bg-white/[0.06] px-5 text-[14px] font-semibold">
                Retry
              </button>
            }
          />
        </div>
      ) : loading && entries === null ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="skeleton h-14" />
          ))}
        </div>
      ) : entries !== null && entries.length === 0 ? (
        <div className="glass">
          <EmptyState icon={FolderOpen} title="Empty folder" hint="Nothing here yet — upload a file, create one, or let an agent do it." />
        </div>
      ) : entries !== null ? (
        <div className="flex flex-col gap-1.5">
          {entries.map((entry) => {
            const kind = entry.kind === 'dir' ? 'dir' : fileVisualKind(entry.name, 'file');
            const Icon = kind === 'dir' ? Folder : KIND_ICONS[kind];
            const isImage = kind === 'image';
            return (
              <div key={entry.path} className="glass-soft press flex items-center transition-colors active:bg-white/[0.08]">
                <button
                  type="button"
                  onClick={() => enter(entry)}
                  className="tap flex min-w-0 flex-1 items-center gap-3 px-3.5 py-2.5 text-left"
                >
                  <span
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
                    style={{
                      background: kind === 'dir' ? 'rgba(78,140,255,0.14)' : isImage ? 'rgba(45,212,191,0.14)' : 'rgba(124,92,255,0.12)',
                      color: kind === 'dir' ? '#4E8CFF' : isImage ? '#2DD4BF' : '#7C5CFF',
                    }}
                  >
                    <Icon size={17} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-medium">{entry.name}</span>
                    <span className="block text-[11.5px] text-dim">
                      {entry.kind === 'dir' ? 'Folder' : [bytes(entry.size), entry.modifiedAt ? relTime(entry.modifiedAt) : ''].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  {entry.kind === 'dir' ? <ChevronRight size={15} className="shrink-0 text-dim" /> : null}
                </button>
                <IconButton
                  label={`${entry.name} actions`}
                  onClick={() => setActionEntry(entry)}
                  className="mr-1 h-9 w-9 shrink-0"
                >
                  <MoreVertical size={16} />
                </IconButton>
              </div>
            );
          })}
        </div>
      ) : null}

      {/* file / folder actions */}
      <Sheet open={actionEntry !== null} onClose={() => setActionEntry(null)} title={actionEntry?.name} subtitle={actionEntry?.path}>
        {actionEntry && (
          <div className="flex flex-col gap-1.5">
            {actionEntry.kind === 'file' && (
              <>
                <MenuRow
                  icon={<Eye size={18} strokeWidth={1.8} />}
                  label={fileVisualKind(actionEntry.name, 'file') === 'image' ? 'View image' : 'Open in editor'}
                  onClick={() => {
                    const target = actionEntry;
                    setActionEntry(null);
                    void openFile(target);
                  }}
                />
                <MenuRow
                  icon={<Download size={18} strokeWidth={1.8} />}
                  label="Download"
                  onClick={() => void download(actionEntry)}
                />
              </>
            )}
            <MenuRow
              icon={<Trash2 size={18} strokeWidth={1.8} />}
              label="Delete"
              danger
              onClick={() => {
                const target = actionEntry;
                setActionEntry(null);
                setDeleteTarget(target);
              }}
            />
            <p className="px-1 pt-1 text-[12px] text-dim">
              {actionEntry.kind === 'dir'
                ? 'Folders are deleted with all their contents.'
                : `${bytes(actionEntry.size)} · text files open in the built-in editor.`}
            </p>
          </div>
        )}
      </Sheet>

      {/* create file / folder */}
      <Sheet
        open={createKind !== null}
        onClose={() => setCreateKind(null)}
        title={createKind === 'dir' ? 'New folder' : 'New file'}
        subtitle={path ? `Inside ${path}/` : 'Inside the project root'}
      >
        <div className="flex flex-col gap-3 px-1 pb-1">
          <input
            className="field font-mono text-[13.5px]"
            placeholder={createKind === 'dir' ? 'e.g. src/components' : 'e.g. src/utils/helpers.ts'}
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitCreate();
            }}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-label="Relative path for the new entry"
          />
          <Button variant="primary" full loading={creating} disabled={!createName.trim()} onClick={() => void submitCreate()}>
            Create
          </Button>
        </div>
      </Sheet>

      {/* delete confirm */}
      <Modal open={deleteTarget !== null} onClose={() => (deleting ? null : setDeleteTarget(null))} title={deleteTarget?.kind === 'dir' ? 'Delete folder' : 'Delete file'}>
        {deleteTarget && (
          <div className="flex flex-col gap-3 pt-1">
            <p className="text-[14px]">
              Delete <span className="font-semibold">{deleteTarget.name}</span>?
              {deleteTarget.kind === 'dir' && ' The folder and all its contents will be removed (recursive).'}
            </p>
            <p className="break-all font-mono text-[12px] text-dim">{deleteTarget.path}</p>
            <div className="flex gap-2 pt-1">
              <Button variant="danger" full loading={deleting} onClick={() => void submitDelete()}>
                Delete
              </Button>
              <Button variant="glass" full disabled={deleting} onClick={() => setDeleteTarget(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* in-app editor */}
      <FileEditorSheet open={editorPath !== null} projectId={projectId} path={editorPath ?? ''} onClose={() => setEditorPath(null)} />

      <input
        ref={uploadInput}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length) void upload(files);
        }}
      />
    </div>
  );
}
