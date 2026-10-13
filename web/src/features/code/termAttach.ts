/**
 * Images and files for the agent in a terminal. A TUI cannot take an upload,
 * so the file goes to the server and its path is put into the prompt: Claude
 * Code turns a pasted image path into an attached image, every agent can open
 * a file it is given the path of.
 */
import { uploadFile } from '../../api/client';
import { errorMessage, useAppStore } from '../../store/appStore';
import { prepareImage } from '../../util/imagePrep';
import { sendRaw } from './termInput';
import { pathInput } from './termPath';

/** Uploads `files` for the terminal `id` and puts their paths into its input, one after the other. */
export async function attachToTerminal(id: string, files: File[], shrink = true): Promise<void> {
  const { terminals, terminalPresets, toast } = useAppStore.getState();
  const term = terminals.find((t) => t.id === id);
  if (!term || files.length === 0) return;
  // Agent TUIs read pastes (and Claude Code recognises an image by it); a plain
  // program without paste mode would show the markers as text.
  const agent = terminalPresets?.find((p) => p.id === term.presetId)?.kind === 'agent';
  toast('info', files.length === 1 ? `Uploading ${files[0]?.name ?? 'file'}…` : `Uploading ${files.length} files…`);
  for (const picked of files) {
    try {
      const file = shrink ? await prepareImage(picked) : picked;
      const att = await uploadFile(term.projectId, file, 'uploads', undefined, undefined, id);
      if (!att.path) throw new Error('The server is too old for terminal uploads — update it in Settings');
      sendRaw(id, pathInput(att.path, agent));
      // TUIs take a paste in on their next tick: the following one must not run into it.
      await new Promise((resolve) => window.setTimeout(resolve, 80));
    } catch (err) {
      toast('error', `Upload failed: ${picked.name} — ${errorMessage(err)}`);
    }
  }
}
