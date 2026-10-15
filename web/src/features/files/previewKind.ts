/** Which files get a rich preview, and the CSV/TSV parser behind the table view. */

export type PreviewKind = 'markdown' | 'image' | 'pdf' | 'html' | 'table';

const EXT: Record<string, PreviewKind> = {
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  avif: 'image',
  bmp: 'image',
  ico: 'image',
  pdf: 'pdf',
  html: 'html',
  htm: 'html',
  csv: 'table',
  tsv: 'table',
};

export function previewKind(path: string): PreviewKind | null {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return path.includes('.') ? (EXT[ext] ?? null) : null;
}

/** Text previews work from the loaded text; binary ones fetch the file. */
export function isBinaryPreview(kind: PreviewKind): boolean {
  return kind === 'image' || kind === 'pdf';
}

/** Splits CSV/TSV (quoted fields, doubled quotes) into rows — at most `maxRows`. */
export function parseDelimited(text: string, delimiter: string, maxRows = 500): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (rows.length >= maxRows) return rows;
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
