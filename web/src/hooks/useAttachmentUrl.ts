import { useEffect, useState } from 'react';
import type { Attachment } from '@agentdeck/shared';
import { attachmentBlobUrl } from '../util/attachments';

/**
 * Displayable URL of an attachment image — `url` is null while it loads and
 * stays null with `failed` set when it cannot be loaded. Pass undefined to
 * hold the fetch back (image not on screen yet).
 */
export function useAttachmentUrl(att: Attachment | undefined): { url: string | null; failed: boolean } {
  const [state, setState] = useState<{ id: string; url: string | null } | null>(null);
  const id = att?.id;
  useEffect(() => {
    if (!att) return;
    let alive = true;
    attachmentBlobUrl(att).then(
      (url) => alive && setState({ id: att.id, url }),
      () => alive && setState({ id: att.id, url: null }),
    );
    return () => {
      alive = false;
    };
    // The attachment object changes identity with every history reload — its id does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  const current = state && state.id === id ? state : null;
  return { url: current?.url ?? null, failed: current !== null && current.url === null };
}
