import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Cpu } from 'lucide-react';
import { useAppStore } from '../../store/appStore';
import { usePrefs } from '../../store/prefs';
import { ProjectSwitcher } from '../../components/ProjectSwitcher';
import { InboxButton } from '../inbox/InboxSheet';
import { haptic } from '../../util/haptics';
import { useDesktopLayout } from '../../hooks/useDesktopLayout';
import { LauncherGrid, LauncherSheet } from './Launcher';
import { TerminalView, type ModifierRef } from './TerminalView';
import { KeyBar } from './KeyBar';
import { openResources } from './ResourcesSheet';
import { ComposeBar } from './ComposeBar';
import { sendRaw, sendText } from './termInput';
import { attachToTerminal } from './termAttach';
import { AttachSheet } from '../../components/AttachSheet';
import { readClipboard, useIncomingFiles } from '../../util/incomingFiles';
import { AgentChips, TerminalTab, useTerminalLauncher } from './terminalParts';
import { CodePanes } from './CodePanes';

/**
 * Code tab: real PTYs on the server with one-tap agent launchers (Claude
 * Code, Codex, OpenCode, Gemini …), a phone-grade compose bar with
 * dictation, a key bar for what soft keyboards lack, and per-agent snippet
 * chips. Terminals ring the inbox when an agent waits for input.
 */
export function CodeScreen() {
  const desktop = useDesktopLayout();
  return desktop ? <CodePanes /> : <CodePhone />;
}

function CodePhone() {
  const projects = useAppStore((s) => s.projects);
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const terminals = useAppStore((s) => s.terminals);
  const activeTerminalId = useAppStore((s) => s.activeTerminalId);
  const presets = useAppStore((s) => s.terminalPresets);
  const killTerminal = useAppStore((s) => s.killTerminal);
  const setActiveTerminal = useAppStore((s) => s.setActiveTerminal);
  const refreshTerminals = useAppStore((s) => s.refreshTerminals);
  const toast = useAppStore((s) => s.toast);
  const compose = usePrefs((s) => s.termCompose);

  const [launcherOpen, setLauncherOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [ctrl, setCtrl] = useState(false);
  const [alt, setAlt] = useState(false);
  const modifier: ModifierRef = useRef({ ctrl: false, alt: false });
  modifier.current = { ctrl, alt };

  useEffect(() => {
    void refreshTerminals().catch(() => undefined);
  }, [refreshTerminals]);

  const project = projects.find((p) => p.id === activeProjectId);
  const active = terminals.find((t) => t.id === activeTerminalId);
  const activePreset = useMemo(
    () => presets?.find((p) => p.id === active?.presetId),
    [presets, active?.presetId],
  );

  const { launch, restart } = useTerminalLauncher();

  const paste = async () => {
    if (!active) return;
    try {
      const clip = await readClipboard();
      if (clip.files.length) void attachToTerminal(active.id, clip.files);
      else if (clip.text) sendText(active.id, clip.text, false);
    } catch {
      toast('warn', 'Clipboard not readable — long-press the compose field to paste');
    }
  };

  // A screenshot pasted, dropped or inserted by the keyboard — into the terminal
  // or the compose field — goes to the agent of the terminal in front.
  const inputArea = useRef<HTMLDivElement | null>(null);
  const activeId = active?.id;
  useIncomingFiles(inputArea, (files) => activeId && void attachToTerminal(activeId, files), activeId !== undefined);

  const onKey = (seq: string) => {
    if (!active) return;
    sendRaw(active.id, seq);
    setCtrl(false);
    setAlt(false);
  };

  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? 'project';

  return (
    <div className="flex h-full flex-col">
      {/* header: project switcher + inbox + new */}
      <header className="flex items-center gap-1 px-4 pb-1.5 pt-2">
        <ProjectSwitcher
          className="min-w-0 flex-1"
          subtitle={terminals.length ? `${terminals.length} live ${terminals.length === 1 ? 'terminal' : 'terminals'}` : 'Terminals & agents'}
        />
        <InboxButton />
        <button
          type="button"
          aria-label="Resources"
          title="CPU and memory per terminal"
          onClick={openResources}
          className="press flex h-10 w-10 items-center justify-center rounded-full text-dim hover:text-ink active:bg-white/10"
        >
          <Cpu size={18} />
        </button>
        <button
          type="button"
          aria-label="New terminal"
          onClick={() => setLauncherOpen(true)}
          className="press btn-primary flex h-10 w-10 items-center justify-center rounded-full text-white"
        >
          <Plus size={20} />
        </button>
      </header>

      {/* terminal tabs */}
      {terminals.length > 0 && (
        <div className="no-scrollbar flex shrink-0 items-center gap-1.5 overflow-x-auto px-4 pb-2" role="tablist">
          {terminals.map((t) => (
            <TerminalTab
              key={t.id}
              term={t}
              preset={presets?.find((p) => p.id === t.presetId)}
              active={t.id === activeTerminalId}
              foreign={t.projectId !== activeProjectId ? projectName(t.projectId) : undefined}
              onSelect={() => {
                haptic();
                setActiveTerminal(t.id);
              }}
              onClose={() => void killTerminal(t.id)}
            />
          ))}
        </div>
      )}

      {terminals.length === 0 ? (
        <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-4 pb-6">
          <div className="mb-4 mt-1">
            <h2 className="text-[16px] font-semibold">Start an agent</h2>
            <p className="text-[12.5px] leading-relaxed text-dim">
              Runs the real CLI in a terminal on your machine, inside {project?.name ?? 'the project'}. You get a
              notification when it's waiting for you.
            </p>
          </div>
          <LauncherGrid onLaunch={(spec) => void launch(spec)} />
        </div>
      ) : (
        <div ref={inputArea} className="flex min-h-0 flex-1 flex-col px-2 pb-2">
          <div className="relative min-h-0 flex-1">
            {terminals.map((t) => (
              <TerminalView
                key={t.id}
                id={t.id}
                visible={t.id === activeTerminalId}
                modifier={modifier}
                onModifierUsed={() => {
                  setCtrl(false);
                  setAlt(false);
                }}
                onRestart={() => restart(t)}
                onClose={() => void killTerminal(t.id)}
              />
            ))}
          </div>

          {/* agent chips: permission answers + slash commands */}
          {active && activePreset?.kind === 'agent' && <AgentChips id={active.id} preset={activePreset} />}

          <KeyBar
            onKey={onKey}
            ctrl={ctrl}
            alt={alt}
            onToggleCtrl={() => setCtrl((v) => !v)}
            onToggleAlt={() => setAlt((v) => !v)}
            onPaste={() => void paste()}
            onAttach={() => setAttachOpen(true)}
            disabled={!active}
          />

          {compose && active && (
            <ComposeBar
              placeholder={activePreset?.kind === 'agent' ? `Message ${activePreset.label}…` : 'Type a command…'}
              onSend={(text) => sendText(active.id, text)}
            />
          )}
        </div>
      )}

      <AttachSheet
        open={attachOpen}
        onClose={() => setAttachOpen(false)}
        onFiles={(files, shrink) => active && void attachToTerminal(active.id, files, shrink)}
        onText={(text) => active && sendText(active.id, text, false)}
        hint="The file is uploaded to your machine and its path goes into the terminal — the agent reads it from there. Max 20 MB."
      />

      <LauncherSheet
        open={launcherOpen}
        onClose={() => setLauncherOpen(false)}
        onLaunch={(spec) => void launch(spec)}
        projectName={project?.name}
      />
    </div>
  );
}
