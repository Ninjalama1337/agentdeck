/**
 * Pseudo-project id used when signing/serving attachment downloads that live
 * under dataDir/attachments (outside any project sandbox root).
 */
import path from 'node:path';
import { signDownloadToken } from '../auth/downloadTokens.js';

export const ATTACHMENTS_PROJECT_ID = '__attachments__';

/** Builds the signed, header-free download URL for a file inside `root`. */
export function signedFileUrl(
  jwtSecret: string,
  projectId: string,
  root: string,
  absPath: string,
): string {
  const rel = path.relative(root, absPath);
  const token = signDownloadToken(jwtSecret, { projectId, path: rel });
  return `/api/projects/${projectId}/files/raw?path=${encodeURIComponent(rel)}&token=${token}`;
}
