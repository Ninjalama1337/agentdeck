import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api, fetchBlob } from '../../api/client';
import { MarkdownView } from '../../components/ui/Markdown';
import { errorMessage } from '../../store/appStore';
import { isNativePlatform } from '../../util/platform';

/**
 * Rich previews in the file sheet (after Orca's repo previews): Markdown
 * rendered, images and PDFs shown, HTML in a sandbox, CSV/TSV as a table.
 */
import { parseDelimited, type PreviewKind } from './previewKind';

export { isBinaryPreview, previewKind, type PreviewKind } from './previewKind';

export function FilePreview({ projectId, path, kind, text }: { projectId: string; path: string; kind: PreviewKind; text: string }) {
  if (kind === 'markdown') {
    return (
      <div className="rounded-2xl border border-line bg-black/20 px-4 py-3 text-[14px] leading-relaxed">
        <MarkdownView text={text} />
      </div>
    );
  }
  if (kind === 'html') {
    return (
      <iframe
        title={path}
        // Scripts run, but in an opaque origin: no access to AgentDeck, its storage or its token.
        sandbox="allow-scripts"
        srcDoc={text}
        className="h-[65vh] w-full rounded-2xl border border-line bg-white"
      />
    );
  }
  if (kind === 'table') return <TablePreview text={text} delimiter={path.toLowerCase().endsWith('.tsv') ? '\t' : ','} />;
  return <BlobPreview projectId={projectId} path={path} kind={kind} />;
}

function TablePreview({ text, delimiter }: { text: string; delimiter: string }) {
  const rows = useMemo(() => parseDelimited(text, delimiter), [text, delimiter]);
  if (rows.length === 0) return <p className="py-6 text-center text-[13px] text-dim">Empty file.</p>;
  const [head, ...body] = rows;
  return (
    <div className="max-h-[65vh] overflow-auto rounded-2xl border border-line">
      <table className="w-max min-w-full border-collapse text-[12px]">
        <thead className="sticky top-0 bg-surface-2">
          <tr>
            {head!.map((h, i) => (
              <th key={i} className="border-b border-line px-2.5 py-1.5 text-left font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i} className="odd:bg-white/[0.02]">
              {r.map((c, j) => (
                <td key={j} className="max-w-[320px] truncate border-b border-line/50 px-2.5 py-1 font-mono" title={c}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length >= 500 && <p className="px-3 py-2 text-[11.5px] text-dim">First 500 rows.</p>}
    </div>
  );
}

function BlobPreview({ projectId, path, kind }: { projectId: string; path: string; kind: 'image' | 'pdf' | 'markdown' | 'html' | 'table' }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let created: string | null = null;
    let live = true;
    setUrl(null);
    setError(null);
    fetchBlob(api.fileRawPath(projectId, path))
      .then((blob) => {
        // SVGs and PDFs need their type for the browser to render them.
        const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
        const typed = ext === 'svg' ? new Blob([blob], { type: 'image/svg+xml' }) : ext === 'pdf' ? new Blob([blob], { type: 'application/pdf' }) : blob;
        created = URL.createObjectURL(typed);
        if (live) setUrl(created);
      })
      .catch((err) => live && setError(errorMessage(err)));
    return () => {
      live = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [projectId, path]);

  if (error) return <p className="py-10 text-center text-[13px] text-danger">{error}</p>;
  if (!url)
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-dim">
        <Loader2 size={16} className="animate-spin" /> Loading preview…
      </div>
    );
  if (kind === 'pdf') {
    // The Android WebView has no PDF viewer — there the download stays the way to read it.
    if (isNativePlatform()) return <p className="py-10 text-center text-[13px] text-dim">PDFs can’t be shown inside the Android app — download it instead.</p>;
    return <iframe title={path} src={url} className="h-[70vh] w-full rounded-2xl border border-line bg-white" />;
  }
  return (
    <div className="flex justify-center rounded-2xl border border-line bg-[repeating-conic-gradient(#ffffff0d_0%_25%,transparent_0%_50%)] bg-[length:16px_16px] p-3">
      <img src={url} alt={path} className="max-h-[65vh] max-w-full object-contain" />
    </div>
  );
}
