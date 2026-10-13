/**
 * How the path of an uploaded file is typed into a terminal (see termAttach.ts).
 */

/** A path as an agent's prompt and a shell both take it as one word. */
export function promptPath(path: string): string {
  return /^[A-Za-z0-9_./~+@:,-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

/** What is typed for an uploaded file: as a paste where the program reads pastes, followed by a space. */
export function pathInput(path: string, bracketed: boolean): string {
  const word = promptPath(path);
  return bracketed ? `\u001b[200~${word}\u001b[201~ ` : `${word} `;
}
