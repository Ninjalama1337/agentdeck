import { useEffect, useState } from 'react';
import {
  Check,
  ChevronRight,
  Copy,
  Gauge,
  Globe,
  LogOut,
  Monitor,
  Plus,
  Server,
  Settings2,
  Smartphone,
  Trash2,
} from 'lucide-react';
import { clsx } from 'clsx';
import type { AgentId, TunnelStatus } from '@agentdeck/shared';
import { api, getApiBase } from '../../api/client';
import { ADMIN_KIND_LABELS, agentDisplayName, errorMessage, serverLabel, useAppStore } from '../../store/appStore';
import { serverAddress } from '../../components/SavedServers';
import { AgentAvatar } from '../../components/ui/Avatar';
import { Chip } from '../../components/ui/Chip';
import { ApkCard } from '../../components/ApkCard';
import { AgentSheet } from '../home/AgentSheet';
import { AgentAdminSheet, ElapsedLabel } from './AgentAdminSheet';
import { UsageSheet } from './UsageSheet';
import { AccountSheet } from './AccountSheet';
import { relTime } from '../../util/format';
import { PreferencesSection } from './PreferencesSection';
import { PairCodeCard } from '../pairing/PairCodeCard';
import { ServerUpdateSection } from './ServerUpdateSection';
import { PowerSection } from './PowerSection';
import { ArrowLeft } from 'lucide-react';
import { DesktopSection } from './DesktopSection';
import { useDesktopLayout } from '../../hooks/useDesktopLayout';
import { desktopBridge } from '../../util/desktop';

/** Dot + label colors for the tunnel status row. */
const TUNNEL_DOTS: Record<TunnelStatus, string> = {
  disabled: '#98a2b8',
  starting: '#F59E0B',
  connected: '#34D399',
  error: '#F43F5E',
};

export function SettingsScreen() {
  const serverInfo = useAppStore((s) => s.serverInfo);
  const serverBase = useAppStore((s) => s.serverBase);
  const setServerBase = useAppStore((s) => s.setServerBase);
  const servers = useAppStore((s) => s.servers);
  const activeServerId = useAppStore((s) => s.activeServerId);
  const switchServer = useAppStore((s) => s.switchServer);
  const addServer = useAppStore((s) => s.addServer);
  const removeServer = useAppStore((s) => s.removeServer);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const devices = useAppStore((s) => s.devices);
  const refreshDevices = useAppStore((s) => s.refreshDevices);
  const agents = useAppStore((s) => s.agents);
  const agentOrder = useAppStore((s) => s.agentOrder);
  const unpair = useAppStore((s) => s.unpair);
  const toast = useAppStore((s) => s.toast);
  const apkRelease = useAppStore((s) => s.apkRelease);
  const refreshApkRelease = useAppStore((s) => s.refreshApkRelease);
  const adminJobs = useAppStore((s) => s.adminJobs);
  const refreshAdminJobs = useAppStore((s) => s.refreshAdminJobs);
  const startAdminJob = useAppStore((s) => s.startAdminJob);
  const accounts = useAppStore((s) => s.accounts);
  const refreshAccounts = useAppStore((s) => s.refreshAccounts);
  const deleteAccount = useAppStore((s) => s.deleteAccount);
  const [accountSheetOpen, setAccountSheetOpen] = useState(false);

  useEffect(() => {
    void refreshAccounts().catch(() => undefined);
  }, [refreshAccounts]);

  const [baseUrl, setBaseUrl] = useState(serverBase);
  const [checking, setChecking] = useState(false);
  const [healthOk, setHealthOk] = useState<boolean | null>(null);
  const [agentSheetId, setAgentSheetId] = useState<AgentId | null>(null);
  const [adminSheetId, setAdminSheetId] = useState<AgentId | null>(null);
  const [usageOpen, setUsageOpen] = useState(false);
  const [confirmUnpair, setConfirmUnpair] = useState(false);
  const [tunnel, setTunnel] = useState<{ status: TunnelStatus; publicUrl?: string } | null>(null);

  useEffect(() => {
    setBaseUrl(serverBase);
  }, [serverBase]);

  // One-shot refresh when settings opens (no polling loop).
  useEffect(() => {
    void refreshApkRelease();
    void refreshAdminJobs();
    void (async () => {
      try {
        const info = await api.tunnel();
        setTunnel({ status: info.status, publicUrl: info.publicUrl });
      } catch {
        // Older server or unauthorized — health carries the same info publicly.
        try {
          const h = await api.health();
          setTunnel(h.tunnel ? { status: h.tunnel.status, publicUrl: h.tunnel.publicUrl } : null);
        } catch {
          /* offline — row stays hidden */
        }
      }
    })();
  }, [refreshApkRelease, refreshAdminJobs]);

  const saveBase = () => {
    setServerBase(baseUrl);
    toast('info', 'Server address saved — reconnecting…');
  };

  // The server runs one admin job at a time — surface it above the agent list.
  const runningAdminJob = adminJobs.find((j) => j.status === 'queued' || j.status === 'running');
  const adminBusy = runningAdminJob !== undefined;

  /** Inline "Install" chip: fire the job, then open the sheet to watch it. */
  const installAgent = (id: AgentId) => {
    void startAdminJob(id, 'install').catch(() => undefined); // store toasts (409 etc.)
    setAdminSheetId(id);
  };

  const check = async () => {
    setChecking(true);
    setHealthOk(null);
    try {
      await api.health();
      setHealthOk(true);
    } catch (err) {
      setHealthOk(false);
      toast('error', errorMessage(err));
    } finally {
      setChecking(false);
    }
  };

  /** Two taps: the first arms the button, the second forgets the server. */
  const removeSavedServer = (id: string) => {
    if (confirmRemoveId === id) {
      setConfirmRemoveId(null);
      removeServer(id);
      return;
    }
    setConfirmRemoveId(id);
    window.setTimeout(() => setConfirmRemoveId((cur) => (cur === id ? null : cur)), 3000);
  };

  const useTunnelUrl = () => {
    if (!tunnel?.publicUrl) return;
    setServerBase(tunnel.publicUrl);
    toast('info', 'Now using the remote address — reconnecting…');
  };

  const copyTunnelUrl = async () => {
    if (!tunnel?.publicUrl) return;
    try {
      await navigator.clipboard.writeText(tunnel.publicUrl);
      toast('info', 'Remote access URL copied');
    } catch {
      toast('error', 'Clipboard unavailable');
    }
  };

  const desktop = useDesktopLayout();
  const bridge = desktopBridge();
  const inDesktopApp = bridge !== null;

  const desktopSection = (
    <>
      {bridge && <DesktopSection bridge={bridge} />}
    </>
  );

  const preferencesSection = (
    <>
      <PreferencesSection />
    </>
  );

  const serverSection = (
    <>
      {/* server */}
      <section className="glass mb-4 p-4" aria-label="Server">
        <h2 className="mb-3 flex items-center gap-2 text-[14px] font-semibold">
          <Server size={15} className="text-accent" /> Server
        </h2>
        <div className="mb-3 grid grid-cols-3 gap-2 text-center">
          <InfoCell label="Name" value={serverInfo?.name ?? 'AgentDeck'} />
          <InfoCell label="Version" value={serverInfo?.version ?? '—'} />
          <InfoCell label="Host" value={serverInfo?.host ?? (getApiBase() || 'same origin')} mono />
        </div>

        {/* remote access via tunnel (cloudflared), hidden while disabled */}
        {tunnel && tunnel.status !== 'disabled' && (
          <div className="mb-3 flex items-center gap-2.5 rounded-xl border border-line bg-white/[0.04] px-3 py-2.5">
            <span
              aria-hidden
              className="h-2 w-2 shrink-0 rounded-full"
              style={{
                background: TUNNEL_DOTS[tunnel.status],
                boxShadow: `0 0 8px ${TUNNEL_DOTS[tunnel.status]}88`,
              }}
            />
            <span className="min-w-0 flex-1">
              <span className="block text-[10px] uppercase tracking-wider text-dim">
                Remote access · {tunnel.status}
              </span>
              <span
                className="block truncate font-mono text-[11.5px] text-ink"
                title={tunnel.publicUrl ?? tunnel.status}
              >
                {tunnel.publicUrl ?? tunnel.status}
              </span>
            </span>
            {tunnel.publicUrl && tunnel.publicUrl !== serverBase && (
              <button
                type="button"
                onClick={useTunnelUrl}
                className="press shrink-0 rounded-full border border-accent/40 bg-accent/15 px-3 py-1.5 text-[12px] font-semibold text-accent"
              >
                Use
              </button>
            )}
            {tunnel.publicUrl && (
              <button
                type="button"
                aria-label="Copy remote access URL"
                onClick={() => void copyTunnelUrl()}
                className="tap flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-dim active:text-ink"
              >
                <Copy size={15} />
              </button>
            )}
          </div>
        )}

        <label className="mb-1.5 block text-[12px] font-medium uppercase tracking-wider text-dim">
          API address
        </label>
        <div className="flex gap-2">
          <input
            className="field flex-1 font-mono text-[13px]"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="(same origin — default for PWA)"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            onClick={() => void check()}
            disabled={checking}
            className="press tap flex h-[46px] shrink-0 items-center gap-1.5 rounded-[14px] border border-line bg-white/[0.06] px-3.5 text-[13px] font-medium active:bg-white/[0.1]"
          >
            <Globe size={14} />
            Test
          </button>
        </div>
        <div className="mt-2 flex items-center justify-between">
          {healthOk !== null && (
            <span className={clsx('inline-flex items-center gap-1 text-[12.5px]', healthOk ? 'text-ok' : 'text-danger')}>
              <Check size={13} /> {healthOk ? 'Server reachable' : 'Not reachable'}
            </span>
          )}
          <button
            type="button"
            onClick={saveBase}
            disabled={baseUrl === serverBase}
            className="press tap ml-auto rounded-xl bg-accent/20 px-4 py-2 text-[13px] font-semibold text-accent disabled:opacity-35"
          >
            Save &amp; reconnect
          </button>
        </div>
      </section>

      <PowerSection />
      <ServerUpdateSection />
    </>
  );

  const savedServersSection = (
    <>
      {/* saved servers: one login each, switch without pairing again */}
      <section className="glass mb-4 p-4" aria-label="Saved servers">
        <h2 className="mb-1 flex items-center gap-2 text-[14px] font-semibold">
          <Server size={15} className="text-accent" /> Saved servers
        </h2>
        <p className="mb-3 text-[12px] leading-snug text-dim">
          Each server keeps its own login on this device. Notifications come from the one you are connected to.
        </p>
        <div className="flex flex-col gap-1.5">
          {servers.map((server) => {
            const active = server.id === activeServerId;
            return (
              <div
                key={server.id}
                className={clsx(
                  'flex items-center gap-1 rounded-2xl border pl-3.5',
                  active ? 'border-accent/40 bg-accent/10' : 'border-line bg-bg-raise',
                )}
              >
                <button
                  type="button"
                  disabled={active}
                  onClick={() => switchServer(server.id)}
                  className="press tap flex min-w-0 flex-1 items-center gap-3 py-2.5 text-left"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-semibold">{serverLabel(server)}</span>
                    <span className="block truncate font-mono text-[10.5px] text-dim">
                      {serverAddress(server)}
                      {active ? ' · connected now' : server.paired ? '' : ' · not paired'}
                    </span>
                  </span>
                  {active && <Check size={16} className="shrink-0 text-accent" />}
                </button>
                <button
                  type="button"
                  aria-label={
                    confirmRemoveId === server.id
                      ? `Tap again to remove ${serverLabel(server)}`
                      : `Remove ${serverLabel(server)}`
                  }
                  onClick={() => removeSavedServer(server.id)}
                  className={clsx(
                    'tap flex h-11 shrink-0 items-center justify-center rounded-xl px-3 text-[12px] font-semibold',
                    confirmRemoveId === server.id ? 'bg-danger text-white' : 'text-dim active:bg-danger/10 active:text-danger',
                  )}
                >
                  {confirmRemoveId === server.id ? 'Remove?' : <Trash2 size={15} />}
                </button>
              </div>
            );
          })}
          <button
            type="button"
            onClick={addServer}
            className="press tap mt-1 flex items-center justify-center gap-1.5 rounded-2xl border border-line bg-surface-2 py-2.5 text-[13.5px] font-semibold active:bg-surface-3"
          >
            <Plus size={15} /> Add server
          </button>
        </div>
      </section>
    </>
  );

  const androidSection = (
    <>
      {/* android app: the APK ships on the public GitHub release */}
      <section className="glass mb-4 p-4" aria-label="Android app">
        <h2 className="mb-3 flex items-center gap-2 text-[14px] font-semibold">
          <Smartphone size={15} className="text-accent" /> Android app
        </h2>

        {apkRelease ? (
          <>
            {inDesktopApp && (
              <p className="mb-3 text-[13px] leading-snug text-dim">
                Phones install the Android app from GitHub, in their browser.
              </p>
            )}
            <ApkCard release={apkRelease} />
          </>
        ) : (
          <p className="text-[13px] text-dim">
            {inDesktopApp
              ? 'Phones install the Android app from the public GitHub releases.'
              : 'Could not read the latest app release from GitHub.'}
          </p>
        )}
      </section>
    </>
  );

  const usageSection = (
    <>
      {/* subscription usage */}
      <section className="glass mb-4 p-4" aria-label="Subscription usage">
        <h2 className="mb-2 text-[14px] font-semibold">Subscription usage</h2>
        <button
          type="button"
          onClick={() => setUsageOpen(true)}
          className="press tap flex w-full items-center gap-3 rounded-2xl border border-line bg-white/[0.04] px-3.5 py-3 text-left"
        >
          <Gauge size={17} className="shrink-0 text-accent" />
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-medium">Plan limits & activity</span>
            <span className="block truncate text-[12px] text-dim">
              Claude session/week limits, resets, request stats
            </span>
          </span>
          <ChevronRight size={16} className="shrink-0 text-dim" />
        </button>
      </section>
    </>
  );

  const agentsSection = (
    <>
      {/* agents */}
      <section className="glass mb-4 p-4" aria-label="Agents">
        <h2 className="mb-3 text-[14px] font-semibold">Agents</h2>
        {runningAdminJob && (
          <button
            type="button"
            onClick={() => setAdminSheetId(runningAdminJob.agentId)}
            className="press tap mb-2.5 flex w-full items-center gap-2.5 rounded-xl border border-accent/30 bg-accent/10 px-3 py-2 text-left"
          >
            <span aria-hidden className="pulse-dot h-2 w-2 shrink-0 rounded-full bg-accent" />
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-accent">
              Running: {agentDisplayName(agents[runningAdminJob.agentId], runningAdminJob.agentId)}{' '}
              {ADMIN_KIND_LABELS[runningAdminJob.kind].toLowerCase()} ·{' '}
              <ElapsedLabel from={runningAdminJob.startedAt} />
            </span>
            <ChevronRight size={14} className="shrink-0 text-accent/70" />
          </button>
        )}
        <div className="flex flex-col gap-1.5">
          {agentOrder.map((id) => {
            const agent = agents[id];
            const label = agentDisplayName(agent, id);
            const canInstall = !agent?.available && agent?.admin?.some((c) => c.kind === 'install');
            return (
              <div key={id} className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setAgentSheetId(id)}
                  className="press tap flex min-w-0 flex-1 items-center gap-3 rounded-2xl px-1 py-1.5 text-left active:bg-white/[0.06]"
                >
                  <AgentAvatar agent={agent} agentId={id} size="md" showDot />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14.5px] font-semibold">{label}</span>
                    <span className="block truncate text-[12px] text-dim">
                      {agent?.available
                        ? [agent.version ? `v${agent.version}` : null, agent.capabilities.headless ? 'headless' : 'IDE mode']
                            .filter(Boolean)
                            .join(' · ')
                        : (agent?.reason ?? 'unavailable')}
                    </span>
                  </span>
                  {agent?.capabilities.headless && agent?.available && <Chip tone="ok">chat</Chip>}
                </button>
                {canInstall && (
                  <button
                    type="button"
                    disabled={adminBusy}
                    onClick={() => installAgent(id)}
                    className="press tap shrink-0 rounded-full border border-accent/40 bg-accent/15 px-3 py-1.5 text-[12px] font-semibold text-accent disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    Install
                  </button>
                )}
                <button
                  type="button"
                  aria-label={`Manage ${label}`}
                  onClick={() => setAdminSheetId(id)}
                  className="tap flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-dim active:bg-white/[0.08] active:text-ink"
                >
                  <Settings2 size={17} />
                </button>
              </div>
            );
          })}
          {agentOrder.length === 0 && <p className="text-[13px] text-dim">No agents reported.</p>}
        </div>
      </section>
    </>
  );

  const accountsSection = (
    <>
      {/* accounts (multi-account switching) */}
      <section className="glass mb-4 p-4" aria-label="Accounts">
        <h2 className="mb-1 text-[14px] font-semibold">Accounts</h2>
        <p className="mb-3 text-[12px] leading-snug text-dim">
          Run threads on a second login — usage limits become a choice. Logins happen in a Code-shell.
        </p>
        <div className="flex flex-col gap-1.5">
          {accounts.map((acc) => (
            <div key={acc.id} className="flex items-center gap-3 rounded-2xl border border-line bg-bg-raise px-3.5 py-2.5">
              <AgentAvatar agent={agents[acc.agentId]} agentId={acc.agentId} size="sm" glow={false} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-semibold">{acc.name}</span>
                <span className="block truncate font-mono text-[10.5px] text-dim">
                  {Object.keys(acc.env).join(' ')}
                </span>
              </span>
              <button
                type="button"
                aria-label={`Remove account ${acc.name}`}
                onClick={() => void deleteAccount(acc.id).catch((err) => toast('error', errorMessage(err)))}
                className="tap flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-dim active:bg-danger/10 active:text-danger"
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          {accounts.length === 0 && <p className="text-[13px] text-dim">No extra accounts yet.</p>}
          <button
            type="button"
            onClick={() => setAccountSheetOpen(true)}
            className="press tap mt-1 flex items-center justify-center gap-1.5 rounded-2xl border border-line bg-surface-2 py-2.5 text-[13.5px] font-semibold active:bg-surface-3"
          >
            <Plus size={15} /> Add account
          </button>
        </div>
      </section>
    </>
  );

  const devicesSection = (
    <>
      {/* devices */}
      <section className="glass mb-4 p-4" aria-label="Devices">
        <h2 className="mb-3 text-[14px] font-semibold">Paired devices</h2>
        <div className="flex flex-col gap-1.5">
          {devices.map((device) => (
            <div key={device.id} className="flex items-center gap-3 rounded-2xl px-1 py-1.5">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-white/[0.07] text-dim">
                {/android|ios|iphone|ipad|phone/i.test(device.name) ? <Smartphone size={17} /> : <Monitor size={17} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-medium">{device.name}</span>
                <span className="block text-[11.5px] text-dim">Last seen {relTime(device.lastSeenAt)}</span>
              </span>
              <button
                type="button"
                aria-label={`Revoke ${device.name}`}
                onClick={() => {
                  void api
                    .deleteDevice(device.id)
                    .then(() => refreshDevices())
                    .then(() => toast('info', 'Device revoked'))
                    .catch((err: unknown) => toast('error', errorMessage(err)));
                }}
                className="tap flex h-11 w-11 items-center justify-center rounded-xl text-dim active:text-danger"
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
          {devices.length === 0 && <p className="text-[13px] text-dim">Loading devices…</p>}
        </div>
        <PairCodeCard />
      </section>
    </>
  );

  const dangerSection = (
    <>
      {/* danger + about */}
      <section className="glass mb-4 p-4" aria-label="Danger zone">
        <h2 className="mb-3 text-[14px] font-semibold text-danger">Danger zone</h2>
        <button
          type="button"
          onClick={() => {
            if (confirmUnpair) {
              unpair();
            } else {
              setConfirmUnpair(true);
              window.setTimeout(() => setConfirmUnpair(false), 3000);
            }
          }}
          className={clsx(
            'press tap flex w-full items-center justify-center gap-2 rounded-2xl border text-[14.5px] font-semibold',
            confirmUnpair ? 'border-danger bg-danger text-white' : 'border-danger/35 bg-danger/10 text-danger',
          )}
        >
          <LogOut size={16} />
          {confirmUnpair ? 'Tap again to unpair this device' : 'Unpair device'}
        </button>
      </section>

      <section className="glass-soft p-4 text-center" aria-label="About">
        <p className="text-[13px] font-semibold">AgentDeck</p>
        <p className="mt-0.5 text-[11.5px] text-dim">
          Remote control deck for coding agents{serverInfo?.version ? ` · server v${serverInfo.version}` : ''}
        </p>
      </section>
    </>
  );

  return (
    <div className="flex min-h-full flex-col px-4 pb-8">
      <header className="flex items-center gap-1 py-3">
        <button
          type="button"
          aria-label="Back"
          onClick={() => useAppStore.getState().navigate({ name: 'home' })}
          className="press tap -ml-2 flex h-11 w-11 items-center justify-center rounded-xl text-dim active:bg-white/[0.08]"
        >
          <ArrowLeft size={20} />
        </button>
        <h1 className="min-w-0 flex-1 text-[20px] font-bold tracking-tight">Settings</h1>
      </header>

      {desktop ? (
        // Desktop: two columns — this app and the server on the left, preferences and the Android app on the right.
        <div className="grid grid-cols-2 items-start gap-x-6">
          <div className="min-w-0">
            {desktopSection}
            {serverSection}
            {savedServersSection}
            {agentsSection}
            {accountsSection}
            {devicesSection}
            {dangerSection}
          </div>
          <div className="min-w-0">
            {preferencesSection}
            {usageSection}
            {androidSection}
          </div>
        </div>
      ) : (
        <>
          {desktopSection}
          {preferencesSection}
          {serverSection}
          {savedServersSection}
          {androidSection}
          {usageSection}
          {agentsSection}
          {accountsSection}
          {devicesSection}
          {dangerSection}
        </>
      )}

      <AgentSheet agentId={agentSheetId} open={agentSheetId !== null} onClose={() => setAgentSheetId(null)} />
      <AgentAdminSheet agentId={adminSheetId} open={adminSheetId !== null} onClose={() => setAdminSheetId(null)} />
      <UsageSheet open={usageOpen} onClose={() => setUsageOpen(false)} />
      <AccountSheet open={accountSheetOpen} onClose={() => setAccountSheetOpen(false)} />
    </div>
  );
}

function InfoCell({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-xl border border-line bg-white/[0.04] px-2 py-2">
      <p className="text-[10px] uppercase tracking-wider text-dim">{label}</p>
      <p className={clsx('mt-0.5 truncate text-[12.5px] font-medium', mono && 'font-mono text-[11px]')} title={value}>
        {value}
      </p>
    </div>
  );
}
