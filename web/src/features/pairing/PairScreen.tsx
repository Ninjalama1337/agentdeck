import { useEffect, useMemo, useRef, useState } from 'react';
import type { PairPendingResponse } from '@agentdeck/shared';
import { AlertTriangle, ArrowRight, Check, Globe, KeyRound, Loader2, Lock, Server, ShieldQuestion } from 'lucide-react';
import { clsx } from 'clsx';
import { api, ApiError, getApiBase, setApiBase as persistApiBase } from '../../api/client';
import { errorMessage, useAppStore } from '../../store/appStore';
import { guessDeviceName } from '../../util/format';
import { isNativePlatform } from '../../util/platform';
import { ApkCard } from '../../components/ApkCard';
import { isDesktopApp } from '../../util/desktop';
import { OtherServers } from '../../components/SavedServers';

const CODE_LENGTH = 6;

export function PairScreen() {
  const pair = useAppStore((s) => s.pair);
  const finishPairing = useAppStore((s) => s.finishPairing);
  // Paired from outside the server's network: waiting for a paired device to allow it.
  const [pending, setPending] = useState<PairPendingResponse['pending'] | null>(null);
  const refreshApkInfo = useAppStore((s) => s.refreshApkInfo);
  const apkInfo = useAppStore((s) => s.apkInfo);
  const [digits, setDigits] = useState<string[]>(Array(CODE_LENGTH).fill(''));
  const [deviceName, setDeviceName] = useState(guessDeviceName());
  const [serverUrl, setServerUrl] = useState(getApiBase());
  // The address field starts open wherever it has to be filled in: in the
  // native app, off-origin setups, and when pairing an additional server.
  const [showAdvanced, setShowAdvanced] = useState(
    () => getApiBase() !== '' || isNativePlatform() || useAppStore.getState().servers.length > 1,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rateLimited, setRateLimited] = useState(false);
  const [health, setHealth] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const inputs = useRef<(HTMLInputElement | null)[]>([]);

  const code = useMemo(() => digits.join(''), [digits]);
  const complete = code.length === CODE_LENGTH && digits.every((d) => d !== '');

  const setDigit = (index: number, raw: string) => {
    const clean = raw.replace(/\D/g, '');
    setError(null);
    setRateLimited(false);
    if (!clean) {
      setDigits((prev) => prev.map((d, i) => (i === index ? '' : d)));
      return;
    }
    if (clean.length > 1) {
      // paste (or autofill) — distribute across boxes
      setDigits((prev) => {
        const next = [...prev];
        for (let i = 0; i < CODE_LENGTH; i++) next[i] = clean[i] ?? '';
        return next;
      });
      inputs.current[Math.min(clean.length, CODE_LENGTH - 1)]?.focus();
      return;
    }
    setDigits((prev) => prev.map((d, i) => (i === index ? clean : d)));
    if (index < CODE_LENGTH - 1) inputs.current[index + 1]?.focus();
  };

  const onKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      inputs.current[index - 1]?.focus();
      setDigits((prev) => prev.map((d, i) => (i === index - 1 ? '' : d)));
    }
  };

  useEffect(() => {
    if (!pending) return;
    const giveUp = (message: string) => {
      setPending(null);
      setError(message);
    };
    const timer = window.setInterval(() => {
      api
        .pairStatus({ id: pending.id, pollToken: pending.pollToken })
        .then((res) => {
          if (res.status === 'approved') {
            setPending(null);
            void finishPairing(res);
          } else if (res.status === 'gone') {
            giveUp('Pairing was denied or timed out. Enter the current pairing code to try again.');
          }
        })
        .catch(() => undefined); // a dropped poll is retried by the next one
    }, 2000);
    return () => window.clearInterval(timer);
  }, [pending, finishPairing]);

  const checkServer = async () => {
    persistApiBase(serverUrl);
    setChecking(true);
    setHealth(null);
    try {
      const h = await api.health();
      setHealth(`${h.name} v${h.version} · ${h.agents.filter((a) => a.available).length}/${h.agents.length} agents`);
      // Server (maybe a different one) answered — refresh the APK card for it.
      void refreshApkInfo();
    } catch (err) {
      setHealth(null);
      setError(
        err instanceof ApiError && err.status === 0
          ? 'Cannot reach the server — check the URL and your network'
          : errorMessage(err),
      );
    } finally {
      setChecking(false);
    }
  };

  const submit = async () => {
    if (!complete || busy) return;
    if (isNativePlatform() && !serverUrl.trim()) {
      setError('Enter your AgentDeck server address first (LAN IP or tunnel URL) — it expands below under "Use a different server address".');
      setShowAdvanced(true);
      return;
    }
    setBusy(true);
    setError(null);
    setRateLimited(false);
    try {
      persistApiBase(serverUrl);
      const waiting = await pair(code, deviceName.trim() || guessDeviceName());
      if (waiting) {
        setPending(waiting);
        setDigits(Array(CODE_LENGTH).fill(''));
      }
    } catch (err) {
      const status = err instanceof ApiError ? err.status : undefined;
      if (status === 429) {
        setRateLimited(true);
        setError('Too many attempts from this network.');
      } else {
        setError(errorMessage(err));
      }
      setDigits(Array(CODE_LENGTH).fill(''));
      inputs.current[0]?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="safe-t safe-b mx-auto flex min-h-dvh w-full max-w-xl flex-col px-5 pb-8">
      {/* header */}
      <div className="flex flex-1 flex-col justify-center py-10">
        <div className="mb-8 text-center">
          <div
            className="mx-auto mb-5 flex h-18 w-18 items-center justify-center rounded-[22px] text-3xl font-bold text-white"
            style={{
              background: 'linear-gradient(135deg,#7C5CFF,#4E8CFF 60%,#2DD4BF)',
              boxShadow: '0 10px 40px rgba(124,92,255,0.45)',
            }}
          >
            A
          </div>
          <h1 className="text-[26px] font-bold tracking-tight">AgentDeck</h1>
          <p className="mt-1.5 text-[14px] text-dim">Drive your coding agents from anywhere.</p>
        </div>

        {pending && (
          <div className="glass p-5 text-center" role="status">
            <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/15 text-accent">
              <ShieldQuestion size={22} />
            </span>
            <h2 className="text-[16px] font-semibold">Allow this device on your phone</h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-dim">
              You are outside the server's network. Open AgentDeck on a device that is already paired and allow the
              request showing this number:
            </p>
            <p className="my-4 font-mono text-[34px] font-semibold tracking-[0.25em]">{pending.checkCode}</p>
            <p className="flex items-center justify-center gap-2 text-[13px] text-dim">
              <Loader2 size={14} className="animate-spin" /> Waiting for approval…
            </p>
            <button
              type="button"
              onClick={() => setPending(null)}
              className="press tap mt-4 w-full rounded-2xl border border-line bg-white/[0.06] text-[14px] font-medium"
            >
              Cancel
            </button>
          </div>
        )}

        {/* pairing card */}
        <div className={clsx('glass p-5', pending && 'hidden')}>
          <div className="mb-4 flex items-center gap-2 text-[13px] font-medium text-dim">
            <KeyRound size={15} className="text-accent" />
            Enter the 6-digit pairing code
          </div>

          <div className="mb-4 flex justify-between gap-2">
            {digits.map((digit, i) => (
              <input
                key={i}
                ref={(el) => {
                  inputs.current[i] = el;
                }}
                value={digit}
                onChange={(e) => setDigit(i, e.target.value)}
                onKeyDown={(e) => onKeyDown(i, e)}
                onFocus={(e) => e.currentTarget.select()}
                inputMode="numeric"
                autoComplete={i === 0 ? 'one-time-code' : 'off'}
                aria-label={`Pairing code digit ${i + 1}`}
                className={clsx(
                  'h-14 w-full rounded-2xl border text-center text-[22px] font-semibold transition-all',
                  'focus:border-accent/70 focus:shadow-[0_0_0_3px_rgba(124,92,255,0.18)] focus:outline-none',
                  digit
                    ? 'border-accent/60 bg-accent/15 text-ink shadow-[0_0_18px_rgba(124,92,255,0.22)]'
                    : 'border-white/[0.14] bg-white/[0.07] text-ink',
                )}
              />
            ))}
          </div>

          <label className="mb-1.5 block text-[12px] font-medium uppercase tracking-wider text-dim">
            Device name
          </label>
          <input
            className="field mb-4"
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            placeholder="Android · Chrome"
            autoComplete="off"
          />

          {/* Android app: direct APK download (public route, no pairing needed) — for phones, not the desktop window */}
          {apkInfo && !isDesktopApp() && <ApkCard info={apkInfo} className="mb-4" />}

          {error && (
            <div
              className="mb-4 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 p-3 text-[13px] text-danger"
              role="alert"
            >
              <AlertTriangle size={15} className="mt-0.5 shrink-0" />
              <div>
                <p>{error}</p>
                {rateLimited && (
                  <p className="mt-1 text-danger/80">
                    The server allows 5 attempts per 10 minutes — wait a moment, then try again.
                  </p>
                )}
              </div>
            </div>
          )}

          <button
            type="button"
            disabled={!complete || busy}
            onClick={() => void submit()}
            className={clsx(
              'press tap flex w-full items-center justify-center gap-2 rounded-2xl text-[15px] font-semibold text-white',
              'disabled:cursor-not-allowed disabled:opacity-40',
            )}
            style={{ background: 'linear-gradient(135deg,#7C5CFF,#4E8CFF)', boxShadow: '0 8px 32px rgba(124,92,255,0.35)' }}
          >
            {busy ? <Loader2 size={17} className="animate-spin" /> : complete ? <Check size={17} /> : <Lock size={15} className="opacity-70" />}
            {busy ? 'Pairing…' : 'Pair device'}
          </button>

          {/* advanced: server URL (needed in the native app / off-origin setups) */}
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="mt-4 flex w-full items-center gap-1.5 text-[13px] text-dim active:text-ink"
          >
            <Globe size={14} />
            {showAdvanced ? 'Hide server address' : 'Use a different server address'}
          </button>
          {showAdvanced && (
            <div className="mt-3">
              <div className="flex gap-2">
                <input
                  className="field flex-1 font-mono text-[13px]"
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  placeholder="http://192.168.1.20:8787"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  type="button"
                  onClick={() => void checkServer()}
                  disabled={checking}
                  className="press tap flex items-center gap-1.5 rounded-[14px] border border-line bg-white/[0.06] px-3.5 text-[13px] font-medium active:bg-white/[0.1]"
                >
                  {checking ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
                  Check
                </button>
              </div>
              {health && (
                <p className="mt-2 flex items-center gap-1.5 text-[13px] text-ok">
                  <Check size={14} /> {health}
                </p>
              )}
            </div>
          )}
        </div>

        {/* this device is paired with other servers: one tap back to them */}
        <OtherServers className="mt-4" />

        {/* instructions */}
        <div className="glass-soft mt-4 flex items-start gap-3 p-4 text-[13px] leading-relaxed text-dim">
          <Server size={16} className="mt-0.5 shrink-0 text-accent-blue" />
          <p>
            Start the AgentDeck server on your machine — the pairing code (with QR) is printed to its
            console and saved to <span className="font-mono text-[12px] text-ink">~/.local/share/agentdeck/pairing-code.txt</span>.
            A device that is already paired also shows it under Settings → Paired devices. The first device
            pairs on the server's local network (its LAN address); further ones can pair from anywhere and
            are then allowed on a paired device.
          </p>
        </div>
      </div>
    </div>
  );
}
