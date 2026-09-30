import { useEffect, useState } from 'react';
import { AlertTriangle, Bell, CheckCircle2, SquareTerminal, Trash2, Users } from 'lucide-react';
import type { DeckNotification } from '@agentdeck/shared';
import { useAppStore } from '../../store/appStore';
import { Sheet } from '../../components/ui/Sheet';
import { relTime } from '../../util/format';
import { openTargetOf } from '../../util/notify';

const ICON: Record<DeckNotification['kind'], { icon: typeof Bell; color: string }> = {
  'session-done': { icon: CheckCircle2, color: '#10B981' },
  'session-error': { icon: AlertTriangle, color: '#F43F5E' },
  'terminal-attention': { icon: SquareTerminal, color: '#F59E0B' },
  'team-done': { icon: Users, color: '#10B981' },
  'team-error': { icon: Users, color: '#F43F5E' },
  info: { icon: Bell, color: '#7C5CFF' },
};

/** Bell with unread badge — opens the inbox sheet. */
export function InboxButton() {
  const inbox = useAppStore((s) => s.inbox);
  const seenAt = useAppStore((s) => s.inboxSeenAt);
  const [open, setOpen] = useState(false);
  const unread = inbox.filter((n) => n.ts > seenAt).length;
  return (
    <>
      <button
        type="button"
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        onClick={() => setOpen(true)}
        className="press tap relative flex h-11 w-11 items-center justify-center rounded-xl text-dim active:bg-white/[0.08] active:text-ink"
      >
        <Bell size={20} />
        {unread > 0 && <span className="badge absolute right-1.5 top-1.5">{unread > 9 ? '9+' : unread}</span>}
      </button>
      <InboxSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export function InboxSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const inbox = useAppStore((s) => s.inbox);
  const seenAt = useAppStore((s) => s.inboxSeenAt);
  const markInboxSeen = useAppStore((s) => s.markInboxSeen);
  const clearInbox = useAppStore((s) => s.clearInbox);
  const openTarget = useAppStore((s) => s.openTarget);
  // Freeze "unread" highlighting for the lifetime of the open sheet.
  const [seenSnapshot, setSeenSnapshot] = useState(seenAt);

  useEffect(() => {
    if (!open) return;
    setSeenSnapshot(useAppStore.getState().inboxSeenAt);
    markInboxSeen();
  }, [open, markInboxSeen]);

  return (
    <Sheet open={open} onClose={onClose} title="Notifications" subtitle="Finished runs, failures and terminals waiting for you">
      {inbox.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
          <Bell size={28} className="text-dim" />
          <p className="text-[14px] font-semibold">All quiet</p>
          <p className="max-w-[30ch] text-[12.5px] text-dim">
            You'll see a note here (and on your lock screen) when an agent finishes or needs input.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {inbox.map((n) => {
            const meta = ICON[n.kind];
            const Icon = meta.icon;
            const target = openTargetOf(n);
            return (
              <button
                key={n.id}
                type="button"
                disabled={!target}
                onClick={() => {
                  if (!target) return;
                  onClose();
                  openTarget(target);
                }}
                className="press flex w-full items-start gap-3 rounded-2xl border border-line bg-white/[0.03] px-3.5 py-3 text-left active:bg-white/[0.07]"
              >
                <span
                  className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl"
                  style={{ background: `${meta.color}1f`, color: meta.color }}
                >
                  <Icon size={16} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">{n.title}</span>
                    {n.ts > seenSnapshot && <span className="h-2 w-2 shrink-0 rounded-full bg-accent" />}
                  </span>
                  <span className="clamp-2 block text-[12.5px] leading-snug text-dim">{n.body}</span>
                  <span className="mt-0.5 block text-[11px] text-dim/70">{relTime(n.ts)}</span>
                </span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={clearInbox}
            className="press tap mt-2 flex items-center justify-center gap-2 rounded-2xl text-[13px] font-medium text-dim active:text-ink"
          >
            <Trash2 size={14} /> Clear all
          </button>
        </div>
      )}
    </Sheet>
  );
}
