import { useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRightLeft, Check, ChevronDown, Plus, Server, Settings2 } from 'lucide-react';
import { clsx } from 'clsx';
import { serverLabel, useAppStore, type SavedServer } from '../store/appStore';
import { Sheet } from './ui/Sheet';
import { MenuRow } from './ui/MenuRow';

/** Address line under a server name ('' base = the server serving this page). */
export function serverAddress(server: Pick<SavedServer, 'base'>): string {
  return server.base || window.location.origin;
}

/**
 * The other paired servers on this device, one tap each. Shown where the
 * active server cannot help: on the pairing screen and while connecting.
 * Renders nothing when there is no other paired server.
 */
export function OtherServers({ className }: { className?: string }) {
  const servers = useAppStore((s) => s.servers);
  const activeId = useAppStore((s) => s.activeServerId);
  const switchServer = useAppStore((s) => s.switchServer);
  const others = servers.filter((s) => s.id !== activeId && s.paired);
  if (others.length === 0) return null;
  return (
    <div className={clsx('glass-soft p-3', className)}>
      <p className="mb-2 flex items-center gap-1.5 px-1 text-[12px] font-medium uppercase tracking-wider text-dim">
        <ArrowRightLeft size={13} /> Switch to a saved server
      </p>
      <div className="flex flex-col gap-1.5">
        {others.map((server) => (
          <button
            key={server.id}
            type="button"
            onClick={() => switchServer(server.id)}
            className="press tap flex w-full items-center gap-3 rounded-2xl border border-line bg-white/[0.04] px-3.5 py-2.5 text-left text-ink active:bg-white/[0.08]"
          >
            <Server size={16} className="shrink-0 text-accent" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-medium">{serverLabel(server)}</span>
              <span className="block truncate font-mono text-[11px] text-dim">{serverAddress(server)}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Top-bar chip naming the active server; opens the list of saved servers.
 * Hidden while only one server is saved — nothing to switch to.
 */
export function ServerSwitcher() {
  const servers = useAppStore((s) => s.servers);
  const activeId = useAppStore((s) => s.activeServerId);
  const switchServer = useAppStore((s) => s.switchServer);
  const addServer = useAppStore((s) => s.addServer);
  const navigate = useAppStore((s) => s.navigate);
  const [open, setOpen] = useState(false);

  const active = servers.find((s) => s.id === activeId);
  if (servers.length < 2 || !active) return null;

  return (
    <>
      <button
        type="button"
        aria-label={`Server: ${serverLabel(active)} — switch server`}
        onClick={() => setOpen(true)}
        className="press mx-2 inline-flex min-w-0 items-center gap-1.5 rounded-full border border-line bg-white/[0.06] px-2.5 py-1 text-xs font-medium text-ink active:bg-white/[0.1]"
      >
        <Server size={13} className="shrink-0 text-accent" />
        <span className="truncate">{serverLabel(active)}</span>
        <ChevronDown size={13} className="shrink-0 text-dim" />
      </button>
      {/* Portal: the top bar's backdrop-filter would otherwise trap the fixed sheet inside the bar. */}
      {createPortal(
        <Sheet open={open} onClose={() => setOpen(false)} title="Servers" subtitle="Each server keeps its own login on this device">
          <div className="flex flex-col gap-0.5 pb-2">
            {servers.map((server) => (
              <MenuRow
                key={server.id}
                icon={server.id === activeId ? <Check size={18} strokeWidth={1.8} /> : <Server size={18} strokeWidth={1.8} />}
                label={serverLabel(server)}
                description={
                  server.id === activeId
                    ? `${serverAddress(server)} · connected now`
                    : server.paired
                      ? serverAddress(server)
                      : `${serverAddress(server)} · not paired`
                }
                onClick={() => {
                  setOpen(false);
                  switchServer(server.id);
                }}
              />
            ))}
            <MenuRow
              icon={<Plus size={18} strokeWidth={1.8} />}
              label="Add server"
              description="Pair another AgentDeck server — pairing works on its local network"
              onClick={() => {
                setOpen(false);
                addServer();
              }}
            />
            <MenuRow
              icon={<Settings2 size={18} strokeWidth={1.8} />}
              label="Manage servers"
              description="Change an address or remove a server"
              onClick={() => {
                setOpen(false);
                navigate({ name: 'settings' });
              }}
            />
          </div>
        </Sheet>,
        document.body,
      )}
    </>
  );
}
