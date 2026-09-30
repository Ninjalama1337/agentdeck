/**
 * node-pty loader. Kept in its own module so a failed native build degrades
 * to a clear startup error instead of breaking unrelated imports.
 */
import nodePty from 'node-pty';

export const pty: typeof nodePty = nodePty;
export type { IPty } from 'node-pty';
