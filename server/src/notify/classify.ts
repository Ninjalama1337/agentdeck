/**
 * Reads what an agent is telling the user out of plain text: a terminal
 * screen, an OSC notification or the last chat reply. Three answers matter on
 * a phone — it is done, it stopped to ask, or its usage limit is used up.
 *
 * Heuristics over the wording of Claude Code, Codex, Gemini and OpenCode;
 * anything unrecognized counts as done.
 */
import type { DeckNotificationState } from '@agentdeck/shared';

export interface Verdict {
  state: Exclude<DeckNotificationState, 'error'>;
  /** The line that says so ("5-hour limit reached ∙ resets 9pm"). */
  detail?: string;
}

/** "Claude usage limit reached", "You've hit your usage limit", "Quota exceeded" … */
const LIMIT_RE = [
  /\b(?:usage|session|weekly|daily|monthly|hourly|5-hour|five-hour|rate|token|request|message)s? limit (?:has been |was |is )?(?:reached|exceeded|hit)\b/i,
  /\b(?:hit|reached|exceeded) (?:your|the|its) (?:\S+ ){0,3}(?:limit|quota)\b/i,
  /\blimit (?:will )?resets?\b/i,
  /\b(?:quota|credits?|credit balance) (?:has been |is |are )?(?:exceeded|exhausted|used up|too low|depleted)\b/i,
  /\b(?:out of|insufficient|no remaining) (?:credits?|quota|balance|usage)\b/i,
  /\bexhausted (?:your|the) (?:\S+ ){0,3}(?:quota|capacity|credits?)\b/i,
];

/** Lines that are the question themselves. */
const QUESTION_RE = [
  /\b(?:do you want|would you like) to\b.*\?/i,
  /\b(?:allow|approve|proceed|continue|confirm|overwrite|trust)\b.*\?$/i,
  /\bneeds your (?:permission|approval|input|attention|confirmation)\b/i,
  /\b(?:approval|permission|confirmation) (?:requested|required|needed)\b/i,
  /\bwaiting for (?:your )?(?:approval|permission|confirmation)\b/i,
  /[([]\s*y(?:es)?\s*\/\s*n(?:o)?\s*[)\]]/i,
  /\bpress (?:enter|return|any key) to (?:continue|confirm|proceed)\b/i,
];

/** Lines that only show a choice is open (a menu, its key hints). */
const MENU_RE = [
  /^(?:[❯›>▶→]\s*)?1\.\s*(?:yes|allow|approve|accept)\b/i,
  /\benter to (?:select|confirm|submit)\b/i,
  /\besc to (?:cancel|reject|deny)\b/i,
];

/** The bottom of the screen is the present; further up is history. */
const SCREEN_LINES = 14;
const DETAIL_MAX = 140;

const matches = (res: RegExp[], line: string) => res.some((re) => re.test(line));

/** Strips TUI frames and bullets, collapses whitespace. */
function clean(line: string): string {
  return line
    .replace(/[─-▟]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[●•◆◇⏺*❯›>▶→]\s+(?!1\.)/, '');
}

function clip(text: string): string {
  return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX - 1)}…` : text;
}

/** Bottom-up: the most recent lines of a screen, cleaned, newest first. */
function recentLines(screen: string): string[] {
  return screen
    .split('\n')
    .map(clean)
    .filter(Boolean)
    .slice(-SCREEN_LINES)
    .reverse();
}

/**
 * What a terminal wants, from its visible screen and — when the program sent
 * one — its own notification text.
 */
export function classifyScreen(screen: string, text?: string): Verdict {
  const note = text ? clean(text) : '';
  const lines = recentLines(screen);
  const all = note ? [note, ...lines] : lines;

  const limit = all.find((l) => matches(LIMIT_RE, l));
  if (limit) return { state: 'limit', detail: clip(note || limit) };

  const question = all.find((l) => matches(QUESTION_RE, l));
  if (question) return { state: 'waiting', detail: clip(note || question) };
  if (lines.some((l) => matches(MENU_RE, l))) {
    const asked = lines.find((l) => l.endsWith('?'));
    const detail = note || asked;
    return { state: 'waiting', ...(detail ? { detail: clip(detail) } : {}) };
  }
  return { state: 'done', ...(note ? { detail: clip(note) } : {}) };
}

/**
 * What a finished chat run left behind: a short limit message instead of an
 * answer, a closing question, or simply the result.
 */
export function classifyReply(reply: string | undefined): Verdict {
  const lines = (reply ?? '').split('\n').map(clean).filter(Boolean);
  if (lines.length > 0 && lines.length <= 3) {
    const limit = lines.find((l) => matches(LIMIT_RE, l));
    if (limit) return { state: 'limit', detail: clip(limit) };
  }
  const last = lines[lines.length - 1];
  if (last?.endsWith('?')) return { state: 'waiting' };
  return { state: 'done' };
}

/** A failed run that failed because the limit is used up. */
export function isLimitError(error: string | undefined): boolean {
  return !!error && error.split('\n').some((l) => matches(LIMIT_RE, clean(l)));
}
