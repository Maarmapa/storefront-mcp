// Per-tool kill switch, dry by default.
//
// A write tool that goes live purely because it got deployed has no rehearsal:
// its first real invocation happens in production, against money or against
// somebody's mailbox. So each one starts OFF and has to be turned on by name.
//
// Three states per tool:
//   off   → not announced in tools/list at all. The kill switch: flip it when
//           something is wrong and the tool stops existing for every client,
//           without a redeploy of your adapter code.
//   dry   → announced and callable, runs EVERY guard rail, and then creates
//           nothing. Not a silent no-op: it answers with exactly what it would
//           have done, including "this would have been BLOCKED and why", so an
//           operator can read the outcome before flipping the switch.
//   live  → the guard rails run and, if they all pass, the effect happens.
//
// Parsing is deliberately asymmetric: only the exact string "live" reaches
// live. A typo (`CHECKOUT_MODE=Live!`, `=true`, `=1`) lands in dry. The
// failure mode of a misconfigured switch has to be "nothing happened", never
// "we charged people".

export type WriteMode = 'off' | 'dry' | 'live';

function parse(raw: string | undefined): WriteMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'live') return 'live';
  if (v === 'off') return 'off';
  return 'dry';
}

/** env CHECKOUT_MODE — default dry. */
export function checkoutMode(): WriteMode {
  return parse(process.env.CHECKOUT_MODE);
}

/** env STOCK_ALERT_MODE — default dry. */
export function stockAlertMode(): WriteMode {
  return parse(process.env.STOCK_ALERT_MODE);
}

/**
 * The sentence appended to a write tool's own description so the agent reads
 * the current mode in tools/list, instead of discovering it by calling.
 */
export function modeBanner(mode: WriteMode, liveEffect: string): string {
  return mode === 'live'
    ? `MODE: LIVE — a successful call really does ${liveEffect}.`
    : `MODE: DRY RUN — every check runs but nothing is created, sent or persisted. ` +
        `The response says what a live call would have done. To go live, the operator sets the mode env var.`;
}
