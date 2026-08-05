// Where a back-in-stock subscription actually comes into existence.
//
// ─────────── THE RULE: GET RENDERS, POST WRITES. NEVER THE OTHER WAY. ───────────
//
// The whole double opt-in flow rests on one invariant: nothing is persisted
// without a deliberate human act. A GET that writes destroys that invariant,
// and not in a theoretical way — corporate mail gateways FOLLOW EVERY LINK IN
// EVERY MESSAGE at delivery time to check it (Defender Safe Links, Proofpoint
// URL Defense, desktop antivirus, some clients' prefetch). So:
//
//   1. attacker calls the tool with victim@company.com,
//   2. the confirmation email arrives at that company,
//   3. the company's OWN security scanner GETs the confirmation URL,
//   4. if GET writes, the victim is now subscribed — by their employer's
//      security product — and the cron will start mailing them.
//
// That is exactly the third-party opt-in the double opt-in existed to prevent,
// re-entered through the back door. A scanner follows links; it does not click
// buttons and it does not submit forms. Hence: GET renders a page with a
// button and writes NOTHING, POST with the token in a form body is the only
// path that touches storage.
//
// This generalizes past opt-in: any action triggered from an emailed link —
// confirm, cancel, approve, unsubscribe, accept an invite — needs the
// intermediate POST.
//
// The page is noindex/nofollow and never cached: a confirmation URL is a
// capability, and capabilities do not belong in a search index or a proxy.

import { NextRequest, NextResponse } from 'next/server';
import { getAdapters } from '@/lib/adapters';
import { optInFailureMessage, verifyOptInToken } from '@/lib/optin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SECURITY_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'x-robots-tag': 'noindex, nofollow',
  'cache-control': 'no-store, max-age=0',
  'referrer-policy': 'no-referrer',
};

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function page(title: string, bodyHtml: string, status = 200): NextResponse {
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title>
<style>
  body{font:16px/1.6 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1.25rem;color:#1a1a1a}
  h1{font-size:1.35rem;margin:0 0 .75rem}
  p{margin:.6rem 0}
  button{font:inherit;padding:.7rem 1.4rem;border:0;border-radius:.5rem;background:#1a1a1a;color:#fff;cursor:pointer}
  .muted{color:#666;font-size:.9rem}
  @media (prefers-color-scheme:dark){
    body{background:#111;color:#eee}button{background:#eee;color:#111}.muted{color:#999}
  }
</style>
</head><body>${bodyHtml}</body></html>`;
  return new NextResponse(html, { status, headers: SECURITY_HEADERS });
}

/**
 * Render the confirmation button. ZERO writes happen here — this is the
 * handler that link scanners reach, and it must be safe for them to reach it
 * as many times as they like.
 */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token') ?? '';
  const verdict = verifyOptInToken(token);

  if (!verdict.ok) {
    return page(
      'Link not valid',
      `<h1>Link not valid</h1><p>${esc(optInFailureMessage(verdict.reason))}</p>`,
      400,
    );
  }

  // The token is echoed into a form field, not into a link: the confirmation
  // must cost a POST.
  return page(
    'Confirm your back-in-stock alert',
    `<h1>Confirm your back-in-stock alert</h1>
     <p>Press the button to start receiving an email for <strong>${esc(verdict.slug)}</strong>
        at <strong>${esc(verdict.email)}</strong> when it is back in stock.</p>
     <form method="post">
       <input type="hidden" name="token" value="${esc(token)}">
       <button type="submit">Confirm</button>
     </form>
     <p class="muted">Nothing has been saved yet. If you did not ask for this, close this page and
        no subscription will be created — the link on its own does nothing.</p>`,
  );
}

/**
 * The only path that writes.
 *
 * The token IS the authorization: it is unguessable, signed, scoped to one
 * (address, product) pair and expires. The write itself is idempotent, so a
 * double-click, a browser back-then-forward or a re-submitted form is a
 * success rather than a support ticket about a flow that worked.
 */
export async function POST(req: NextRequest) {
  let token = '';
  const contentType = req.headers.get('content-type') ?? '';
  try {
    if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('form-data')) {
      const form = await req.formData();
      token = String(form.get('token') ?? '');
    } else {
      const body = (await req.json()) as { token?: unknown };
      token = typeof body?.token === 'string' ? body.token : '';
    }
  } catch {
    token = '';
  }

  const verdict = verifyOptInToken(token);
  if (!verdict.ok) {
    return page(
      'Link not valid',
      `<h1>Link not valid</h1><p>${esc(optInFailureMessage(verdict.reason))}</p>`,
      400,
    );
  }

  const { notify } = getAdapters();
  if (!notify) {
    return page(
      'Not available',
      '<h1>Not available</h1><p>This store is not accepting back-in-stock alerts right now.</p>',
      503,
    );
  }

  try {
    await notify.confirmSubscription(verdict.email, {
      slug: verdict.slug,
      ...(verdict.sku ? { sku: verdict.sku } : {}),
    });
  } catch {
    // Do not leak backend detail to an anonymous visitor holding a valid link.
    return page(
      'Something went wrong',
      '<h1>Something went wrong</h1><p>Please try the link again in a few minutes.</p>',
      500,
    );
  }

  return page(
    'You are subscribed',
    `<h1>You are subscribed</h1>
     <p>We will email <strong>${esc(verdict.email)}</strong> once
        <strong>${esc(verdict.slug)}</strong> is back in stock.</p>
     <p class="muted">Confirming twice is harmless — you are on the list exactly once.</p>`,
  );
}
