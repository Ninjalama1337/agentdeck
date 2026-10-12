import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

let counter = 0;

function tmpName(file: string): string {
  return path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.${counter++}.tmp`);
}

/**
 * Writes `file` in one step (temp file in the same directory + rename), so a
 * reader — the desktop shell reading the pairing code, the CLI reading the pid
 * — never sees a half-written file. The mode is set before the content lands.
 */
export async function writeFileAtomic(file: string, content: string, mode = 0o600): Promise<void> {
  const tmp = tmpName(file);
  try {
    const handle = await fsp.open(tmp, 'w', mode);
    try {
      await handle.writeFile(content, 'utf8');
    } finally {
      await handle.close();
    }
    await fsp.chmod(tmp, mode); // the umask may have narrowed it, never widened
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export function writeFileAtomicSync(file: string, content: string, mode = 0o600): void {
  const tmp = tmpName(file);
  try {
    fs.writeFileSync(tmp, content, { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
