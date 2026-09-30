import { useEffect, useState } from 'react';
import { FolderPlus, Github, Loader2, Search } from 'lucide-react';
import { clsx } from 'clsx';
import { useAppStore, errorMessage } from '../../store/appStore';
import { Sheet } from '../../components/ui/Sheet';
import { RepoPicker } from '../github/RepoPicker';

interface NewProjectSheetProps {
  open: boolean;
  onClose: () => void;
}

export function NewProjectSheet({ open, onClose }: NewProjectSheetProps) {
  const createProject = useAppStore((s) => s.createProject);
  const cloneProject = useAppStore((s) => s.cloneProject);
  const openProject = useAppStore((s) => s.openProject);
  const navigate = useAppStore((s) => s.navigate);
  const toast = useAppStore((s) => s.toast);

  const [tab, setTab] = useState<'blank' | 'clone'>('blank');
  const [name, setName] = useState('');
  const [initGit, setInitGit] = useState(true);
  const [cloneUrl, setCloneUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setName('');
      setCloneUrl('');
      setTab('blank');
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const project = await createProject({ name: name.trim(), initGit });
      await openProject(project.id);
      onClose();
      navigate({ name: 'chat' });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const clone = async (url: string, suggestedName?: string) => {
    if (!url.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const project = await cloneProject({ url: url.trim(), name: suggestedName ?? (name.trim() || undefined) });
      toast('info', `Cloning ${project.name}… it will appear shortly`);
      await openProject(project.id);
      onClose();
      navigate({ name: 'home' });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="New project" subtitle="Blank workspace or clone from GitHub">
      {/* tabs */}
      <div className="mb-4 flex rounded-2xl border border-line bg-white/[0.04] p-1">
        {(
          [
            { key: 'blank', label: 'Blank', icon: FolderPlus },
            { key: 'clone', label: 'Clone', icon: Github },
          ] as const
        ).map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={clsx(
              'press tap flex flex-1 items-center justify-center gap-1.5 rounded-xl text-[13.5px] font-medium',
              tab === key ? 'bg-accent/20 text-ink' : 'text-dim',
            )}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
      </div>

      {error && (
        <p className="mb-3 rounded-xl border border-danger/30 bg-danger/10 p-3 text-[13px] text-danger" role="alert">
          {error}
        </p>
      )}

      {tab === 'blank' ? (
        <div className="flex flex-col gap-3">
          <div>
            <label className="mb-1.5 block text-[12px] font-medium uppercase tracking-wider text-dim">Name</label>
            <input
              className="field"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-app"
              autoFocus
              autoComplete="off"
            />
          </div>
          <SwitchRow label="Initialize git repository" hint="Runs git init in the new project" checked={initGit} onChange={setInitGit} />
          <button
            type="button"
            disabled={!name.trim() || busy}
            onClick={() => void create()}
            className="press tap mt-1 flex items-center justify-center gap-2 rounded-2xl text-[15px] font-semibold text-white disabled:opacity-40 btn-primary"
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : <FolderPlus size={16} />}
            Create project
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div>
            <label className="mb-1.5 block text-[12px] font-medium uppercase tracking-wider text-dim">
              Repository URL
            </label>
            <input
              className="field font-mono text-[13px]"
              value={cloneUrl}
              onChange={(e) => setCloneUrl(e.target.value)}
              placeholder="https://github.com/owner/repo.git"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <button
            type="button"
            disabled={!cloneUrl.trim() || busy}
            onClick={() => void clone(cloneUrl)}
            className="press tap flex items-center justify-center gap-2 rounded-2xl text-[15px] font-semibold text-white disabled:opacity-40 btn-primary"
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Github size={16} />}
            Clone repository
          </button>

          <div className="flex items-center gap-3 py-1">
            <div className="h-px flex-1 bg-line" />
            <span className="text-[11px] uppercase tracking-wider text-dim">or pick a repo</span>
            <div className="h-px flex-1 bg-line" />
          </div>

          <RepoPicker onPick={(repo) => void clone(repo.url ?? `https://github.com/${repo.nameWithOwner}.git`, repo.nameWithOwner.split('/')[1])} />
        </div>
      )}
    </Sheet>
  );
}

export function SwitchRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="press tap flex w-full items-center justify-between gap-3 rounded-2xl border border-line bg-white/[0.04] px-4 py-2 text-left"
    >
      <span className="min-w-0">
        <span className="block text-[14px] font-medium">{label}</span>
        {hint && <span className="block text-[12px] text-dim">{hint}</span>}
      </span>
      <span
        className={clsx(
          'relative h-7 w-12 shrink-0 rounded-full transition-colors',
          checked ? 'bg-accent' : 'bg-white/15',
        )}
      >
        <span
          className={clsx(
            'absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all',
            checked ? 'left-[22px]' : 'left-0.5',
          )}
        />
      </span>
    </button>
  );
}

export function SearchField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative">
      <Search size={15} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-dim" />
      <input
        className="field pl-10"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
      />
    </div>
  );
}
