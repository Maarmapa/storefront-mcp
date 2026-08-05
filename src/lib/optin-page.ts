// The double opt-in confirmation page, as framework-free HTML.
//
// ─────────── THE RULE: GET RENDERS, POST WRITES. NEVER THE OTHER WAY. ───────────
//
// The whole flow rests on one invariant: nothing is persisted without a
// deliberate human act. A GET that writes destroys that invariant, and not in
// a theoretical way — corporate mail gateways FOLLOW EVERY LINK IN EVERY
// MESSAGE at delivery time to check it (Defender Safe Links, Proofpoint URL
// Defense, desktop antivirus, some clients' prefetch). So:
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
// WHY THIS IS A LIBRARY AND NOT A NEXT.JS ROUTE: the npm package (`npx
// storefront-mcp`) ships dist/src/lib and dist/src/cli — not src/app. When
// this page existed only as a Next route, an operator could install the
// package, set a signing secret, go live, and mail real people a confirmation
// link that nothing they installed could serve. Now both transports serve the
// same handlers from here: the Next route for a web deployment, `--http` for
// the standalone package.
//
// TWO THINGS THE PAGE MUST SAY, and did not:
//   - WHICH VARIANT. Subscribing to "Chromaflow Classic Marker" and
//     subscribing to shade R21 of it are different subscriptions, and the
//     second is what the token actually carries. A consent screen that omits
//     the one detail distinguishing them is not consent.
//   - IN A LANGUAGE THE READER HAS. This is the only screen in the project a
//     CUSTOMER ever sees. Hardcoded English with `lang="en"` in a template
//     whose own README is bilingual is an odd thing to ship, so the copy is
//     data (STOCK_ALERT_PAGE_LOCALE), and adding a locale is adding an entry
//     to one object.

import { getAdapters } from './adapters';
import { optInFailureMessage, verifyOptInToken } from './optin';

export interface PageResponse {
  status: number;
  headers: Record<string, string>;
  html: string;
}

const SECURITY_HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
  // A confirmation URL is a capability: it does not belong in a search index
  // or in a shared proxy cache.
  'x-robots-tag': 'noindex, nofollow',
  'cache-control': 'no-store, max-age=0',
  'referrer-policy': 'no-referrer',
};

interface Copy {
  lang: string;
  invalid_title: string;
  confirm_title: string;
  confirm_intro: (product: string, email: string) => string;
  variant_line: (sku: string) => string;
  button: string;
  nothing_saved: string;
  unavailable_title: string;
  unavailable_body: string;
  error_title: string;
  error_body: string;
  done_title: string;
  done_body: (product: string, email: string) => string;
  done_twice: string;
}

const COPY: Record<string, Copy> = {
  en: {
    lang: 'en',
    invalid_title: 'Link not valid',
    confirm_title: 'Confirm your back-in-stock alert',
    confirm_intro: (product, email) =>
      `Press the button to get one email at <strong>${email}</strong> when ` +
      `<strong>${product}</strong> is back in stock.`,
    variant_line: sku => `This alert is for one specific variant: <strong>${sku}</strong>.`,
    button: 'Confirm',
    nothing_saved:
      'Nothing has been saved yet. If you did not ask for this, close this page and no ' +
      'subscription will be created — the link on its own does nothing.',
    unavailable_title: 'Not available',
    unavailable_body: 'This store is not accepting back-in-stock alerts right now.',
    error_title: 'Something went wrong',
    error_body: 'Please try the link again in a few minutes.',
    done_title: 'You are subscribed',
    done_body: (product, email) =>
      `We will email <strong>${email}</strong> once <strong>${product}</strong> is back in stock.`,
    done_twice: 'Confirming twice is harmless — you are on the list exactly once.',
  },
  es: {
    lang: 'es',
    invalid_title: 'Enlace no válido',
    confirm_title: 'Confirma tu aviso de reposición',
    confirm_intro: (product, email) =>
      `Pulsa el botón para recibir un correo en <strong>${email}</strong> cuando ` +
      `<strong>${product}</strong> vuelva a estar disponible.`,
    variant_line: sku => `Este aviso es para una variante específica: <strong>${sku}</strong>.`,
    button: 'Confirmar',
    nothing_saved:
      'Todavía no se ha guardado nada. Si no solicitaste esto, cierra esta página y no se creará ' +
      'ninguna suscripción: el enlace por sí solo no hace nada.',
    unavailable_title: 'No disponible',
    unavailable_body: 'Esta tienda no está aceptando avisos de reposición en este momento.',
    error_title: 'Algo salió mal',
    error_body: 'Vuelve a intentarlo con el mismo enlace en unos minutos.',
    done_title: 'Suscripción confirmada',
    done_body: (product, email) =>
      `Escribiremos a <strong>${email}</strong> cuando <strong>${product}</strong> vuelva a ` +
      'estar disponible.',
    done_twice: 'Confirmar dos veces no hace daño: quedas en la lista una sola vez.',
  },
};

function copy(): Copy {
  const want = (process.env.STOCK_ALERT_PAGE_LOCALE ?? '').trim().toLowerCase();
  return COPY[want] ?? COPY.en;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function page(lang: string, title: string, bodyHtml: string, status = 200): PageResponse {
  const html = `<!doctype html>
<html lang="${escapeHtml(lang)}"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title>
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
  return { status, headers: SECURITY_HEADERS, html };
}

/**
 * Human-readable product name for the consent screen.
 *
 * The token carries a slug because a slug is stable; a person recognizes a
 * name. Falls back to the slug if the catalog cannot answer — a confirmation
 * screen must not depend on a catalog lookup succeeding.
 */
async function displayName(slug: string): Promise<string> {
  try {
    const product = await getAdapters().catalog.getProduct(slug);
    return product?.name || slug;
  } catch {
    return slug;
  }
}

/**
 * Render the confirmation button. ZERO writes happen here — this is the
 * handler that link scanners reach, and it must be safe for them to reach it
 * as many times as they like.
 */
export async function renderConfirmPage(token: string): Promise<PageResponse> {
  const c = copy();
  const verdict = verifyOptInToken(token);

  if (!verdict.ok) {
    return page(
      c.lang,
      c.invalid_title,
      `<h1>${escapeHtml(c.invalid_title)}</h1><p>${escapeHtml(optInFailureMessage(verdict.reason))}</p>`,
      400,
    );
  }

  const name = await displayName(verdict.slug);
  // The token is echoed into a form field, not into a link: the confirmation
  // must cost a POST.
  return page(
    c.lang,
    c.confirm_title,
    `<h1>${escapeHtml(c.confirm_title)}</h1>
     <p>${c.confirm_intro(escapeHtml(name), escapeHtml(verdict.email))}</p>
     ${verdict.sku ? `<p>${c.variant_line(escapeHtml(verdict.sku))}</p>` : ''}
     <form method="post">
       <input type="hidden" name="token" value="${escapeHtml(token)}">
       <button type="submit">${escapeHtml(c.button)}</button>
     </form>
     <p class="muted">${escapeHtml(c.nothing_saved)}</p>`,
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
export async function confirmSubscriptionPage(token: string): Promise<PageResponse> {
  const c = copy();
  const verdict = verifyOptInToken(token);
  if (!verdict.ok) {
    return page(
      c.lang,
      c.invalid_title,
      `<h1>${escapeHtml(c.invalid_title)}</h1><p>${escapeHtml(optInFailureMessage(verdict.reason))}</p>`,
      400,
    );
  }

  const { notify } = getAdapters();
  if (!notify) {
    return page(
      c.lang,
      c.unavailable_title,
      `<h1>${escapeHtml(c.unavailable_title)}</h1><p>${escapeHtml(c.unavailable_body)}</p>`,
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
      c.lang,
      c.error_title,
      `<h1>${escapeHtml(c.error_title)}</h1><p>${escapeHtml(c.error_body)}</p>`,
      500,
    );
  }

  const name = await displayName(verdict.slug);
  return page(
    c.lang,
    c.done_title,
    `<h1>${escapeHtml(c.done_title)}</h1>
     <p>${c.done_body(escapeHtml(name), escapeHtml(verdict.email))}</p>
     ${verdict.sku ? `<p>${c.variant_line(escapeHtml(verdict.sku))}</p>` : ''}
     <p class="muted">${escapeHtml(c.done_twice)}</p>`,
  );
}

/** Parse a token out of a POST body without a framework. */
export function tokenFromBody(contentType: string, body: string): string {
  const ct = (contentType || '').toLowerCase();
  try {
    if (ct.includes('application/json')) {
      const parsed = JSON.parse(body) as { token?: unknown };
      return typeof parsed?.token === 'string' ? parsed.token : '';
    }
    // Default to form encoding: that is what the page's own <form> sends.
    return new URLSearchParams(body).get('token') ?? '';
  } catch {
    return '';
  }
}
