/**
 * Splits a command string like `flatpak run --command=antigravity com.google.Antigravity`
 * into argv tokens (simple whitespace split — sufficient for configured commands).
 */
export function splitCommand(command: string): { bin: string; prefixArgs: string[] } {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { bin: command, prefixArgs: [] };
  return { bin: parts[0] as string, prefixArgs: parts.slice(1) };
}
