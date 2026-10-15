import { useEffect, useState } from 'react';
import { LogIn, Plus, UserRound } from 'lucide-react';
import { clsx } from 'clsx';
import type { Account } from '@agentdeck/shared';
import { api } from '../../api/client';
import { errorMessage, useAppStore } from '../../store/appStore';
import { usePrefs } from '../../store/prefs';
import { estimateSize } from '../code/termInput';

/**
 * Switch the account an agent runs on (after Orca's account switcher): new
 * chats, new terminals and this usage readout follow the active one. "Add"
 * creates an account with its own config folder and opens a terminal to log
 * in once. Older servers without the API show nothing.
 */
export function AccountSwitcher({ agentId }: { agentId: 'claude' | 'codex' }) {
  const accounts = useAppStore((s) => s.accounts);
  const loaded = useAppStore((s) => s.accountsLoaded);
  const [active, setActive] = useState<string | null | undefined>(undefined);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<Account | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loaded) void useAppStore.getState().refreshAccounts().catch(() => undefined);
    let live = true;
    api
      .activeAccounts()
      .then((all) => live && setActive(all[agentId] ?? null))
      .catch(() => live && setActive(undefined));
    return () => {
      live = false;
    };
  }, [agentId, loaded]);

  // Older server: no switcher.
  if (active === undefined) return null;
  const mine = accounts.filter((a) => a.agentId === agentId);

  const choose = async (id: string | null) => {
    if (id === active || busy) return;
    setBusy(true);
    const store = useAppStore.getState();
    try {
      const all = await api.setActiveAccount(agentId, id);
      setActive(all[agentId] ?? null);
      void store.refreshUsage();
    } catch (err) {
      store.toast('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (!name.trim()) return;
    setBusy(true);
    const store = useAppStore.getState();
    try {
      const account = await api.quickAccount(agentId, name.trim());
      await store.refreshAccounts();
      setFresh(account);
      setAdding(false);
      setName('');
    } catch (err) {
      store.toast('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  /** A terminal on the new account: the CLI asks for the login on its first start. */
  const logIn = async (account: Account) => {
    const store = useAppStore.getState();
    const projectId = store.activeProjectId;
    if (!projectId) return store.toast('info', 'Pick a project first — the login runs in a terminal.');
    try {
      const { cols, rows } = estimateSize(usePrefs.getState().termFontSize);
      const term = await store.createTerminal(projectId, cols, rows, { presetId: agentId, accountId: account.id, title: `Log in · ${account.name}` });
      setFresh(null);
      store.setUsageSheetOpen(false);
      store.openTarget(`terminal:${term.id}`);
    } catch (err) {
      store.toast('error', errorMessage(err));
    }
  };

  const chip = (selected: boolean) =>
    clsx(
      'press flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12px] font-medium disabled:opacity-50',
      selected ? 'border-accent/50 bg-accent/20 text-ink' : 'border-line bg-white/[0.04] text-dim',
    );

  return (
    <div className="mb-3 rounded-xl border border-line bg-black/20 p-2.5">
      <p className="mb-2 flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-dim">
        <UserRound size={12} /> Account
      </p>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" disabled={busy} onClick={() => void choose(null)} className={chip(active === null)}>
          Default login
        </button>
        {mine.map((a) => (
          <button key={a.id} type="button" disabled={busy} onClick={() => void choose(a.id)} className={chip(active === a.id)}>
            {a.name}
          </button>
        ))}
        {!adding && (
          <button type="button" onClick={() => setAdding(true)} className="press flex h-8 items-center gap-1 rounded-full border border-dashed border-line px-3 text-[12px] text-dim">
            <Plus size={12} /> Add
          </button>
        )}
      </div>
      {adding && (
        <div className="mt-2 flex gap-1.5">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void add()}
            placeholder="Name, e.g. Work"
            className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-black/30 px-2.5 text-[13px] outline-none focus:border-accent/50"
          />
          <button type="button" disabled={busy || !name.trim()} onClick={() => void add()} className="press btn-primary h-9 rounded-lg px-3 text-[12.5px] font-semibold text-white disabled:opacity-50">
            Create
          </button>
        </div>
      )}
      {fresh && (
        <div className="mt-2 flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/10 px-2.5 py-2">
          <span className="min-w-0 flex-1 text-[12px]">“{fresh.name}” needs a login once.</span>
          <button type="button" onClick={() => void logIn(fresh)} className="press flex h-8 items-center gap-1 rounded-lg bg-accent/25 px-2.5 text-[12px] font-semibold text-accent">
            <LogIn size={13} /> Log in
          </button>
        </div>
      )}
      <p className="mt-2 text-[11px] leading-relaxed text-dim">New chats, terminals and this usage use the selected account. Running ones keep theirs.</p>
    </div>
  );
}
