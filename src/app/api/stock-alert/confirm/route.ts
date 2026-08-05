// Where a back-in-stock subscription actually comes into existence — the
// Next.js transport for it.
//
// The rule (GET renders, POST writes), the reasoning behind it, the page copy
// and the write itself all live in src/lib/optin-page.ts, framework-free, so
// the standalone package can serve the exact same flow over `--http`. This
// file is the 30 lines of Next.js that stand between an HTTP request and
// those handlers.
//
// If you are looking for WHY a GET must not write: read the header of
// src/lib/optin-page.ts. Short version: corporate mail scanners follow every
// link in every message at delivery time, so a GET that writes lets a
// victim's own employer subscribe them.

import { NextRequest, NextResponse } from 'next/server';
import { confirmSubscriptionPage, renderConfirmPage, tokenFromBody } from '@/lib/optin-page';
import type { PageResponse } from '@/lib/optin-page';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function toResponse(page: PageResponse): NextResponse {
  return new NextResponse(page.html, { status: page.status, headers: page.headers });
}

export async function GET(req: NextRequest) {
  return toResponse(await renderConfirmPage(req.nextUrl.searchParams.get('token') ?? ''));
}

export async function POST(req: NextRequest) {
  const contentType = req.headers.get('content-type') ?? '';
  let token = '';
  try {
    if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('form-data')) {
      const form = await req.formData();
      token = String(form.get('token') ?? '');
    } else {
      token = tokenFromBody(contentType || 'application/json', await req.text());
    }
  } catch {
    token = '';
  }
  return toResponse(await confirmSubscriptionPage(token));
}
