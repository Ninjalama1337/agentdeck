import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, CircleDot, Search, Sparkles, Star, Wand2, Zap } from 'lucide-react';
import { clsx } from 'clsx';
import type { AgentInfo, ModelPreset, Session } from '@agentdeck/shared';
import { api } from '../../api/client';
import { Spinner } from '../../components/ui/Spinner';
import { useAppStore } from '../../store/appStore';
import { effortLabel } from './ModelBar';
import {
  filterModels,
  groupModels,
  isDefaultModelSelection,
  pinnedModels,
  savedDefaultModel,
  selectableModels,
} from './modelPicker';

/** Rendering hundreds of OpenCode models at once makes the sheet sluggish; search narrows them. */
const MAX_VISIBLE_MODELS = 150;

/** Pick a model + thinking effort for the current session. Applies on next turn. */
export function ModelSheet({
  open,
  onClose,
  session,
  agent,
}: {
  open: boolean;
  onClose: () => void;
  session: Session;
  agent: AgentInfo | undefined;
}) {
  const setSessionModel = useAppStore((s) => s.setSessionModel);
  const setSessionEffort = useAppStore((s) => s.setSessionEffort);
  const modelRecents = useAppStore((s) => s.modelRecents);
  const modelFavorites = useAppStore((s) => s.modelFavorites);
  const toggleModelFavorite = useAppStore((s) => s.toggleModelFavorite);
  const usage = useAppStore((s) => s.usage);
  const refreshUsage = useAppStore((s) => s.refreshUsage);
  const toast = useAppStore((s) => s.toast);
  const projects = useAppStore((s) => s.projects);
  const modelPrefs = useAppStore((s) => s.modelPrefs);
  const setModelPref = useAppStore((s) => s.setModelPref);
  const [presets, setPresets] = useState<ModelPreset[]>(agent?.models ?? []);
  const [defaultModel, setDefaultModel] = useState<ModelPreset | undefined>(agent?.defaultModel);
  const [custom, setCustom] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [switchingPlan, setSwitchingPlan] = useState<string | null>(null);

  const projectPath = projects.find((p) => p.id === session.projectId)?.path;

  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }
    setPresets(agent?.models ?? []);
    setDefaultModel(agent?.defaultModel);
    if (!agent) return;
    let alive = true;
    setLoading(true);
    // A live catalog (OpenCode) also resolves the model a run would use.
    api
      .models(agent.id, projectPath)
      .then((res) => {
        if (!alive) return;
        setPresets(res.models);
        setDefaultModel(res.defaultModel ?? agent.defaultModel);
      })
      .catch(() => {
        /* keep AgentInfo.models */
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, agent, projectPath]);

  const current = session.model;
  const locked = session.status === 'running' || session.status === 'queued';
  const efforts = agent?.efforts ?? [];
  const effort = session.thinkingEffort ?? 'default';
  const zcodeUsage = agent?.id === 'zcode' ? usage?.find((u) => u.agentId === 'zcode') : undefined;
  const isDefault = isDefaultModelSelection(current);
  const defaultPreset = defaultModel ?? agent?.defaultModel;

  const selectable = useMemo(() => selectableModels(presets), [presets]);
  const savedDefault = savedDefaultModel(agent ? modelPrefs[agent.id] : undefined, presets);
  const filtered = useMemo(() => filterModels(selectable, query), [selectable, query]);
  const shown = filtered.slice(0, MAX_VISIBLE_MODELS);
  const favoriteIds = agent ? (modelFavorites[agent.id] ?? []) : [];
  const recentIds = agent ? (modelRecents[agent.id] ?? []) : [];
  const searching = query.trim().length > 0;
  const pinned = useMemo(
    () => pinnedModels(selectable, favoriteIds, recentIds),
    [selectable, favoriteIds, recentIds],
  );
  const pinnedIds = new Set([...pinned.favorites, ...pinned.recents].map((m) => m.id));
  // While searching the provider list already holds everything, so the pinned
  // shortcuts step aside; otherwise favorites and recents sit on top.
  const groups = groupModels(searching ? shown : shown.filter((m) => !pinnedIds.has(m.id)), defaultPreset?.provider);
  const toggleFav = (id: string) => {
    if (agent) toggleModelFavorite(agent.id, id);
  };

  // Allowed while a run is active: the model is per turn, so the pick applies
  // from the next message (including one that is already queued).
  const pick = (model: string | undefined) => {
    setSessionModel(session.id, model);
    onClose();
  };

  const pickEffort = (level: string) => {
    if (locked) return;
    setSessionEffort(session.id, level === 'default' ? 'default' : level);
  };

  const makeDefault = (model: string | undefined, label: string) => {
    if (!agent) return;
    setModelPref(agent.id, model);
    toast('info', `Default model for new chats: ${label}`);
  };

  return (
    <>
      {agent?.id === 'zcode' && zcodeUsage?.plans && zcodeUsage.plans.length > 0 && (
        <div className="mb-3 rounded-2xl border border-line bg-white/[0.03] p-3">
          <div className="mb-2 flex items-center justify-between text-[12px] font-medium text-dim">
            <span className="flex items-center gap-1.5 uppercase tracking-wider text-ink">
              <Zap size={12} className="text-accent" />
              ZCode Modus
            </span>
            <span className="text-[11px] text-dim">{zcodeUsage.activePlanId === 'subscription' ? 'Abo aktiv' : 'Free Tokens aktiv'}</span>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {zcodeUsage.plans.map((p) => {
              const active = p.active;
              return (
                <button
                  key={p.id}
                  type="button"
                  disabled={locked || switchingPlan !== null}
                  onClick={async () => {
                    if (active) return;
                    setSwitchingPlan(p.id);
                    try {
                      await api.switchPlan('zcode', p.id);
                      toast('info', `ZCode Modus gewechselt: ${p.label}`);
                      await refreshUsage();
                    } catch (e) {
                      toast('error', (e as Error).message);
                    } finally {
                      setSwitchingPlan(null);
                    }
                  }}
                  className={clsx(
                    'press tap flex flex-col items-start rounded-xl border p-2 text-left transition-all',
                    active
                      ? 'border-accent/60 bg-accent/20 text-ink shadow-[0_0_12px_rgba(124,92,255,0.2)]'
                      : 'border-line/70 bg-white/[0.02] text-dim hover:text-ink',
                    locked && 'opacity-50',
                  )}
                >
                  <div className="flex w-full items-center justify-between">
                    <span className="text-[12.5px] font-semibold">{p.id === 'subscription' ? 'Abo-Modell' : 'Free Tokens'}</span>
                    {active && <Check size={12} className="text-accent" />}
                  </div>
                  <span className="mt-0.5 truncate text-[11px] opacity-75">{p.id === 'subscription' ? 'Unbegrenzt' : '100M Tokens'}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="mb-2 flex items-center gap-2 rounded-2xl border border-line bg-white/[0.03] px-3.5 py-2">
        <CircleDot size={13} className="shrink-0 text-accent" aria-hidden />
        <span className="text-[12px] text-dim">Default model for new chats</span>
        <span className="ml-auto min-w-0 truncate text-[12.5px] font-semibold text-ink">
          {savedDefault?.label ?? defaultPreset?.label ?? 'Agent default'}
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <ModelRow
          label={`Agent default${defaultPreset ? `: ${defaultPreset.label}` : ''}`}
          description={defaultPreset?.id ?? "The agent's configured model"}
          mono={defaultPreset !== undefined}
          selected={isDefault}
          isDefault={!savedDefault}
          onToggleDefault={() => makeDefault(undefined, defaultPreset?.label ?? 'Agent default')}
          onClick={() => pick(undefined)}
        />
      </div>

      {selectable.length > 8 && (
        <div className="relative mt-2">
          <Search size={14} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-dim" aria-hidden />
          <input
            className="field w-full pl-9 text-[13.5px]"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${selectable.length} models…`}
            autoComplete="off"
            spellCheck={false}
            aria-label="Search models"
          />
        </div>
      )}

      {loading && (
        <p className="mt-2 flex items-center gap-2 px-1 text-[12px] text-dim">
          <Spinner size={14} /> Loading models…
        </p>
      )}

      <div className="mt-1 flex flex-col gap-1.5">
        {!searching && pinned.favorites.length > 0 && (
          <ModelSection title="Favorites" icon={<Star size={11} className="fill-current" />}>
            {pinned.favorites.map((preset) => (
              <ModelRow
                key={preset.id}
                label={preset.label}
                description={preset.description ?? preset.id}
                mono
                selected={current === preset.id}
                fav
                isDefault={savedDefault?.id === preset.id}
                onToggleDefault={() => makeDefault(preset.id, preset.label)}
                onToggleFav={() => toggleFav(preset.id)}
                onClick={() => pick(preset.id)}
              />
            ))}
          </ModelSection>
        )}

        {!searching && pinned.recents.length > 0 && (
          <ModelSection title="Recently used">
            {pinned.recents.map((preset) => (
              <ModelRow
                key={preset.id}
                label={preset.label}
                description={preset.description ?? preset.id}
                mono
                selected={current === preset.id}
                fav={false}
                isDefault={savedDefault?.id === preset.id}
                onToggleDefault={() => makeDefault(preset.id, preset.label)}
                onToggleFav={() => toggleFav(preset.id)}
                onClick={() => pick(preset.id)}
              />
            ))}
          </ModelSection>
        )}

        {groups.map((group) => (
          <section key={group.provider || 'models'}>
            {group.provider && (
              <div className="mb-1 mt-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-dim">
                {group.provider}
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              {group.models.map((preset) => (
                <ModelRow
                  key={preset.id}
                  label={preset.label}
                  description={preset.description ?? preset.id}
                  mono
                  selected={current === preset.id}
                  fav={favoriteIds.includes(preset.id)}
                  isDefault={savedDefault?.id === preset.id}
                  onToggleDefault={() => makeDefault(preset.id, preset.label)}
                  onToggleFav={() => toggleFav(preset.id)}
                  onClick={() => pick(preset.id)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>

      {filtered.length === 0 && !loading && (
        <p className="mt-3 px-1 text-[12.5px] text-dim">
          {query.trim() ? `No model matches “${query.trim()}”.` : 'No models to choose from.'}
        </p>
      )}
      {filtered.length > shown.length && (
        <p className="mt-2 px-1 text-[11.5px] text-dim">
          Showing {shown.length} of {filtered.length} — type above to narrow the list.
        </p>
      )}

      <div className="mt-3 flex gap-2">
        <input
          className="field flex-1 font-mono text-[13px]"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="Custom model id…"
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          disabled={!custom.trim()}
          onClick={() => pick(custom.trim())}
          className="press tap shrink-0 rounded-[14px] bg-accent/20 px-4 text-[13px] font-semibold text-accent disabled:opacity-40"
        >
          Use
        </button>
      </div>

      {efforts.length > 0 && (
        <section className="mt-4">
          <div className="mb-2 flex items-center gap-1.5 px-1 text-[12px] font-medium uppercase tracking-wider text-dim">
            <Sparkles size={12} aria-hidden />
            Thinking effort
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Thinking effort">
            {efforts.map((level) => {
              const selected = effort === level;
              return (
                <button
                  key={level}
                  type="button"
                  disabled={locked}
                  onClick={() => pickEffort(level)}
                  className={clsx(
                    'press tap flex h-10 min-w-[72px] items-center justify-center gap-1 rounded-[14px] border text-[13px] font-semibold capitalize',
                    selected
                      ? 'border-accent/60 bg-accent/25 text-ink shadow-[0_0_16px_rgba(124,92,255,0.25)]'
                      : 'border-line bg-white/[0.04] text-dim',
                    locked && 'opacity-50',
                  )}
                >
                  {effortLabel(level)}
                  {selected && <Check size={13} aria-hidden />}
                </button>
              );
            })}
          </div>
          <p className="mt-2 px-1 text-[11.5px] leading-relaxed text-dim">
            Higher effort thinks longer (better for complex work, slower + more quota). Auto uses the
            CLI default. Applies from your next message.
          </p>
        </section>
      )}

      <p className="mt-3 flex items-start gap-1.5 px-1 text-[12px] leading-relaxed text-dim">
        <Wand2 size={13} className="mt-0.5 shrink-0" />
        {locked
          ? 'A run is active — your model pick applies from the next message; effort stays locked until it finishes.'
          : 'Changes take effect on your next message. The ◉ button sets a model as the default for new chats.'}
      </p>
    </>
  );
}

function ModelSection({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mt-2">
      <div className="mb-1 flex items-center gap-1.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-dim">
        {icon}
        {title}
      </div>
      <div className="flex flex-col gap-1.5">{children}</div>
    </section>
  );
}

function ModelRow({
  label,
  description,
  mono,
  selected,
  fav,
  isDefault,
  onToggleDefault,
  onToggleFav,
  onClick,
}: {
  label: string;
  description?: string;
  mono?: boolean;
  selected: boolean;
  fav?: boolean;
  isDefault?: boolean;
  onToggleDefault?: () => void;
  onToggleFav?: () => void;
  onClick: () => void;
}) {
  return (
    <div
      className={clsx(
        'flex w-full items-center gap-2 rounded-2xl border px-4 py-3',
        selected ? 'border-accent/45 bg-accent/12' : 'border-line bg-white/[0.04]',
      )}
    >
      <button type="button" onClick={onClick} className="press tap flex min-w-0 flex-1 items-center gap-3 text-left">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-medium">{label}</span>
          {description && <span className={clsx('block truncate text-[11.5px] text-dim', mono && 'font-mono')}>{description}</span>}
        </span>
        {selected && <Check size={16} className="shrink-0 text-accent" />}
      </button>
      {onToggleDefault && (
        <button
          type="button"
          onClick={onToggleDefault}
          aria-pressed={isDefault === true}
          aria-label={isDefault ? `Default model for new chats: ${label}` : `Set ${label} as default model for new chats`}
          title={isDefault ? 'Default model for new chats' : 'Set as default model for new chats'}
          className={clsx(
            'press tap shrink-0 rounded-full p-1.5',
            isDefault ? 'bg-accent/15 text-accent' : 'text-dim hover:text-ink',
          )}
        >
          <CircleDot size={15} />
        </button>
      )}
      {onToggleFav && (
        <button
          type="button"
          onClick={onToggleFav}
          aria-pressed={fav === true}
          aria-label={fav ? `Remove ${label} from favorites` : `Add ${label} to favorites`}
          title={fav ? 'Remove from favorites' : 'Add to favorites'}
          className={clsx('press tap shrink-0 rounded-full p-1.5', fav ? 'text-warn' : 'text-dim hover:text-ink')}
        >
          <Star size={15} className={fav ? 'fill-current' : undefined} />
        </button>
      )}
    </div>
  );
}
