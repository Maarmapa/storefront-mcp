// Addresses, and the difference between a STRING and a MAILBOX.
//
// A per-recipient quota exists to protect one human's inbox. Key it on the
// string the caller typed and it protects nothing, because one inbox has
// unlimited spellings:
//
//   victim@gmail.com
//   victim+1@gmail.com        ← plus-tag, ignored by every major provider
//   victim+anything@gmail.com
//   v.i.c.t.i.m@gmail.com     ← dots, ignored by Gmail
//   VICTIM@Gmail.com          ← case
//
// All five are delivered to the same person, and against a literal-string
// quota each one gets its own fresh allowance of 3 per hour. Fifteen
// "confirmation" emails, none of them technically a repeat.
//
// So the quota is keyed on a CANONICAL FORM. Two caveats, both stated rather
// than hidden:
//
//   1. Canonicalization is provider-specific and therefore a heuristic. Dots
//      are significant at some hosts, so they are only stripped for the
//      providers known to ignore them. Plus-tags are effectively universal
//      among the large providers and are stripped everywhere; the cost of
//      being wrong is that two people who deliberately use +tags at an exotic
//      host share one quota of 3/hour, which is a far cheaper mistake than
//      the alternative.
//   2. The canonical form is for RATE LIMITING AND DEDUPE ONLY. Mail is
//      always sent to the address as typed, and the subscription is stored
//      against the address as typed. Rewriting somebody's address because you
//      think you know their provider's rules is how "+newsletter" filters
//      stop working.

/** Providers that ignore dots in the local part. */
const DOT_INSENSITIVE = new Set(['gmail.com', 'googlemail.com']);

/** Deliberately boring. Address *validation* is not address *verification*. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Trim + lowercase, and reject anything that is not shaped like an address.
 * This is the form that gets MAILED and STORED.
 */
export function cleanEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase();
  return EMAIL_RE.test(e) && e.length <= 254 ? e : null;
}

/**
 * The mailbox behind an address, for quota and dedupe keys ONLY.
 *
 * Never mail this, never store it as the subscriber's address.
 */
export function mailboxKey(cleaned: string): string {
  const at = cleaned.lastIndexOf('@');
  if (at <= 0) return cleaned;
  let local = cleaned.slice(0, at);
  const domain = cleaned.slice(at + 1);

  // Plus-tag: everything from the first '+' is a label, not an identity.
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  else if (plus === 0) local = local.slice(1); // "+tag@" — degenerate, keep something

  if (DOT_INSENSITIVE.has(domain)) local = local.replace(/\./g, '');

  return `${local}@${domain}`;
}
