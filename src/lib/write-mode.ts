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
 * What to do in LIVE mode when the InventoryAdapter cannot reserve units.
 *
 * This is the switch behind the oversell that no stateless check can catch.
 * `getAvailability` describes the past; ten concurrent calls all read "4
 * left", all pass, and all create an order. The only fix is an atomic hold at
 * the inventory source (InventoryAdapter.reserve), and an adapter that has no
 * such operation cannot offer one.
 *
 *   refuse (default) → live create_checkout answers "blocked: this deployment
 *                      cannot hold units", and creates nothing. Dry mode is
 *                      unaffected, so the whole flow stays testable.
 *   allow            → the operator has read the above and accepts that
 *                      concurrent calls can oversell. Every receipt then
 *                      carries the warning, because the agent is about to
 *                      promise somebody a delivery.
 *
 * Only the exact string "allow" opens it: same asymmetry as the modes above.
 */
export type UnreservedPolicy = 'refuse' | 'allow';

export function unreservedCheckoutPolicy(): UnreservedPolicy {
  return (process.env.CHECKOUT_UNRESERVED ?? '').trim().toLowerCase() === 'allow'
    ? 'allow'
    : 'refuse';
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
