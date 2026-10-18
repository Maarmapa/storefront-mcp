// Skills over MCP — SEP-2640, extension `io.modelcontextprotocol/skills`.
//
// A skill is a directory with a SKILL.md (Agent Skills format, agentskills.io)
// served through the ordinary Resources primitive. This server publishes ONE
// skill: how to shop through it. The text is generated from what the running
// deployment can actually do, for the caller that is asking, so an agent that
// reads it never learns about a tool that does not exist here — the same rule
// tools/list already follows ("a tool that cannot be honest is not announced").
//
// Wire shape, identical on every transport:
//   capabilities.extensions["io.modelcontextprotocol/skills"] = {}
//   skills/list    → { skills: [entry] }   entry = uri + frontmatter + files with sha256
//   skills/get     → { skill: entry }      by the SKILL.md uri; anything else → -32602
//   resources/read skill://storefront-mcp/SKILL.md → the markdown itself
//
// The digest in the entry is what a host binds its approval to, so it is
// computed from the exact bytes resources/read returns, every time, never from
// a cached copy that could drift from them.

import { createHash } from 'node:crypto';
import { SENSITIVE_TOOLS, WRITE_TOOLS, type ToolDef } from './tools';
import type { WriteMode } from './write-mode';

export const SKILLS_EXTENSION = 'io.modelcontextprotocol/skills';
/** Skill name = directory name, as the Agent Skills spec requires. */
export const SKILL_NAME = 'storefront-mcp';
export const SKILL_URI = `skill://${SKILL_NAME}/SKILL.md`;

const SKILL_DESCRIPTION =
  'How to shop through a storefront-mcp server: find products, read variant charts and ' +
  'promotions, price a basket with a quote, and when (not) to call the guarded checkout and ' +
  'back-in-stock tools. Read it before calling any tool of this server.';

/** One entry of skills/list, also the payload of skills/get. */
export interface SkillEntry {
  uri: string;
  frontmatter: { name: string; description: string; license?: string };
  resources: Array<{ uri: string; digest: string; size: number }>;
}

/** What the skill text depends on. Filled in by the transport for THIS caller. */
export interface SkillContext {
  serverName: string;
  /** The tools this caller can see — exactly what tools/list would announce. */
  tools: ToolDef[];
  checkoutMode: WriteMode;
  stockAlertMode: WriteMode;
}

export function digestOf(text: string): string {
  return 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex');
}

function has(tools: ToolDef[], name: string): boolean {
  return tools.some(t => t.name === name);
}

function modeLine(mode: WriteMode, tool: string, effect: string): string {
  if (mode === 'live') return `- \`${tool}\` is LIVE on this deployment: a successful call really does ${effect}.`;
  return `- \`${tool}\` is in DRY RUN on this deployment: every check runs, nothing is created, sent or persisted, and the answer says what a live call would have done.`;
}

/** The SKILL.md, generated for the caller described by `ctx`. */
export function skillMarkdown(ctx: SkillContext): string {
  const t = ctx.tools;
  // The same two sets tools.ts uses to classify tools; a third copy of the
  // names here would be the one that drifts.
  const read = t.filter(x => !WRITE_TOOLS.has(x.name) && !SENSITIVE_TOOLS.has(x.name));
  const write = t.filter(x => WRITE_TOOLS.has(x.name));
  const office = t.filter(x => SENSITIVE_TOOLS.has(x.name));

  const lines: string[] = [];
  lines.push('---');
  lines.push(`name: ${SKILL_NAME}`);
  // Quoted: the description contains ": ", which a plain YAML scalar cannot.
  // A host verifies the frontmatter by parsing it and comparing field by
  // field with the entry; a JSON string is a valid double-quoted YAML scalar.
  lines.push(`description: ${JSON.stringify(SKILL_DESCRIPTION)}`);
  lines.push('license: Apache-2.0');
  lines.push('---');
  lines.push('');
  lines.push(`# Shopping through ${headingSafe(ctx.serverName)}`);
  lines.push('');
  lines.push(
    'This server is a shop window with a few guarded doors. Read tools answer anyone. The write ' +
      'tools act for the shopper and refuse what they cannot honor. ' +
      (office.length > 0 ? 'The back-office tools belong to the operator and are never announced to a shopper. ' : '') +
      'Everything below describes THIS deployment as it is configured right now; the list of tools at ' +
      'the end is exactly what tools/list returns to you.',
  );
  lines.push('');
  lines.push('## Workflow');
  lines.push('');
  lines.push('1. Find the product with `search_products`. If the query looks like a variant code (a color, a size, a nib), ' +
    (has(t, 'get_variant_chart') ? 'use `get_variant_chart` instead: a code is a variant of a chart, not a product.' : 'say so to the user: this deployment has no variant charts.'));
  lines.push('2. Confirm with `get_product` before quoting anything: price, availability and the canonical URL come from there, not from the search hit.');
  if (has(t, 'get_promotions')) lines.push('3. Check `get_promotions` when the user asks about offers or a brand; do not promise a discount you have not seen there.');
  if (has(t, 'get_quote')) lines.push(`${has(t, 'get_promotions') ? 4 : 3}. Price a basket with \`get_quote\`. Quote \`amount_to_pay\`, never \`subtotal\`. A quote never charges anyone.`);
  if (has(t, 'create_checkout')) lines.push(`${stepAfterQuote(t)}. Only then, and only if the user explicitly asked to buy, call \`create_checkout\` with the same lines. Re-check stock first: a quote is a photograph of a moment that has passed.`);
  lines.push('');
  lines.push('## Reading results');
  lines.push('');
  lines.push('- `stock: null` means unknown, not zero. Say "I cannot confirm stock", do not invent a number.');
  lines.push('- A result with an `error` field is an answer to act on (wrong slug, nothing found). A JSON-RPC error means the call itself was not acceptable and must not be retried in a loop.');
  lines.push('- Error `-32601`: the tool does not exist on this deployment. Call tools/list; this server announces exactly the tools it can answer.');
  lines.push('- Error `-32005`: you are calling the write tools too often. The quota is shared by both write tools, so switching between them does not reset it. Back off.');
  if (office.length > 0) lines.push('- Error `-32001`: that tool needs the operator credential your session carries; if it fails, the credential is wrong, do not retry with guesses.');
  lines.push('');
  lines.push('## Where your permission ends');
  lines.push('');
  if (write.length === 0) {
    lines.push('- This deployment announces no write tools. You can look and price; you cannot order or subscribe anyone.');
  } else {
    if (has(t, 'create_checkout')) {
      lines.push('- Never call `create_checkout` on your own initiative. The user has to ask to buy, in this conversation, with the items and quantities you are about to send.');
      lines.push(modeLine(ctx.checkoutMode, 'create_checkout', 'create an order'));
      lines.push('- A blocked checkout is a result, not an error: it tells you what to change (quantities rejected, stock short, lines that share a pool). Fix the basket with the user instead of retrying as is.');
    }
    if (has(t, 'subscribe_stock_alert')) {
      lines.push('- `subscribe_stock_alert` sends a double opt-in email. Use it only with an address the user gave for that purpose; nobody is subscribed until they click the confirmation link.');
      lines.push(modeLine(ctx.stockAlertMode, 'subscribe_stock_alert', 'send a confirmation email'));
    }
  }
  // The anonymous text names no category, variable or error code that would
  // let a shopper tell a hidden tool from a nonexistent one: for them, what is
  // not in tools/list does not exist, full stop.
  lines.push(
    office.length > 0
      ? '- The back-office tools (stock in bulk, orders, sales) are visible to you because this session carries the operator credential: treat their output as internal data, not as something to repeat to a shopper.'
      : '- Tools that are not in your tools/list do not exist for you. Do not guess names.',
  );
  lines.push('');
  lines.push('## Tools available to you on this deployment');
  lines.push('');
  for (const x of [...read, ...write, ...office]) {
    lines.push(`- \`${x.name}\` — ${x.description}`);
  }
  lines.push('');
  lines.push('This file is generated by the server from its current configuration. Its digest changes when the configuration does; a host that pinned the digest should re-read it then.');
  lines.push('');
  return lines.join('\n');
}

function stepAfterQuote(t: ToolDef[]): number {
  return 3 + (has(t, 'get_promotions') ? 1 : 0) + (has(t, 'get_quote') ? 1 : 0);
}

/**
 * The server name as a heading: protocol.ts already makes it one line without
 * control characters; here the markdown syntax that could turn a label into
 * structure (headings, emphasis, links, inline code) is stripped too.
 */
function headingSafe(name: string): string {
  return name.replace(/[#*_`\[\]<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 64) || SKILL_NAME;
}

/** The skills/list entry for this caller. Digest and size come from the text itself. */
export function skillEntry(ctx: SkillContext): SkillEntry {
  const md = skillMarkdown(ctx);
  return {
    uri: SKILL_URI,
    frontmatter: { name: SKILL_NAME, description: SKILL_DESCRIPTION, license: 'Apache-2.0' },
    resources: [{ uri: SKILL_URI, digest: digestOf(md), size: Buffer.byteLength(md, 'utf8') }],
  };
}

/** What resources/list announces. To a client without the extension this is an ordinary resource. */
export function skillResourceList() {
  return [
    {
      uri: SKILL_URI,
      // SHOULD equal the frontmatter `name` (which is the skill directory).
      name: SKILL_NAME,
      title: 'How to shop through this server',
      description: SKILL_DESCRIPTION,
      mimeType: 'text/markdown',
    },
  ];
}

/** resources/read for a skill file, or null when the uri is not one this server serves. */
export function readSkillResource(
  uri: string,
  ctx: SkillContext,
): { uri: string; mimeType: string; text: string } | null {
  if (uri !== SKILL_URI) return null;
  return { uri: SKILL_URI, mimeType: 'text/markdown', text: skillMarkdown(ctx) };
}
