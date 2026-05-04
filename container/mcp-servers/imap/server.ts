/**
 * IMAP/SMTP MCP server for NanoClaw agents.
 *
 * Credentials come from environment variables passed via the mcpServers env
 * block in the agent group's container.json:
 *   IMAP_HOST, IMAP_PORT (default 993), IMAP_USER, IMAP_PASS, IMAP_TLS (default true)
 *   SMTP_HOST, SMTP_PORT (default 587), SMTP_USER, SMTP_PASS, SMTP_SECURE (default false)
 *   EMAIL_FROM  — optional display name/address for outgoing mail
 *
 * Run with: bun server.ts
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';

// ── Config ──────────────────────────────────────────────────────────────────

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const IMAP_HOST = required('IMAP_HOST');
const IMAP_PORT = parseInt(process.env.IMAP_PORT || '993', 10);
const IMAP_USER = required('IMAP_USER');
const IMAP_PASS = required('IMAP_PASS');
const IMAP_TLS = (process.env.IMAP_TLS ?? 'true') !== 'false';

const SMTP_HOST = process.env.SMTP_HOST || IMAP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER || IMAP_USER;
const SMTP_PASS = process.env.SMTP_PASS || IMAP_PASS;
// SMTP_SECURE=true → SSL on connect (port 465); false → STARTTLS (port 587)
const SMTP_SECURE = (process.env.SMTP_SECURE ?? 'false') === 'true';

const EMAIL_FROM = process.env.EMAIL_FROM || IMAP_USER;

// ── IMAP helpers ─────────────────────────────────────────────────────────────

function makeImapClient(): ImapFlow {
  return new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: IMAP_TLS,
    auth: { user: IMAP_USER, pass: IMAP_PASS },
    logger: false,
  });
}

async function withImap<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = makeImapClient();
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => {});
  }
}

function truncate(text: string, max = 8000): string {
  return text.length > max ? text.slice(0, max) + `\n\n[truncated — ${text.length - max} chars omitted]` : text;
}

// ── SMTP helper ───────────────────────────────────────────────────────────────

function makeTransport() {
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: 'list_folders',
    description: 'List all IMAP folders/mailboxes in the account.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'search_emails',
    description: 'Search emails in a folder. Returns a list of messages with id, subject, from, date, and a short snippet.',
    inputSchema: {
      type: 'object',
      properties: {
        folder:    { type: 'string', description: 'Folder to search (default: INBOX)', default: 'INBOX' },
        query:     { type: 'string', description: 'Text to search in subject/body (optional)' },
        from:      { type: 'string', description: 'Filter by sender address (optional)' },
        since_days:{ type: 'number', description: 'Only return emails from the last N days (optional)' },
        unread_only:{ type: 'boolean', description: 'Only return unread emails', default: false },
        limit:     { type: 'number', description: 'Max results to return (default 20, max 50)', default: 20 },
      },
      required: [],
    },
  },
  {
    name: 'read_email',
    description: 'Read the full content of an email by its UID.',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Folder containing the email (default: INBOX)', default: 'INBOX' },
        uid:    { type: 'number', description: 'Email UID from search_emails' },
      },
      required: ['uid'],
    },
  },
  {
    name: 'send_email',
    description: 'Send an email via SMTP.',
    inputSchema: {
      type: 'object',
      properties: {
        to:      { type: 'string', description: 'Recipient address(es), comma-separated' },
        subject: { type: 'string', description: 'Email subject' },
        body:    { type: 'string', description: 'Plain-text body' },
        html:    { type: 'string', description: 'HTML body (optional, used instead of body if provided)' },
        cc:      { type: 'string', description: 'CC address(es), comma-separated (optional)' },
        bcc:     { type: 'string', description: 'BCC address(es), comma-separated (optional)' },
        reply_to:{ type: 'string', description: 'Reply-To address (optional)' },
        in_reply_to: { type: 'string', description: 'Message-ID of email being replied to (optional)' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'move_email',
    description: 'Move an email to a different folder.',
    inputSchema: {
      type: 'object',
      properties: {
        folder:        { type: 'string', description: 'Source folder (default: INBOX)', default: 'INBOX' },
        uid:           { type: 'number', description: 'Email UID' },
        target_folder: { type: 'string', description: 'Destination folder' },
      },
      required: ['uid', 'target_folder'],
    },
  },
  {
    name: 'delete_email',
    description: 'Delete an email (moves to Trash if available, otherwise permanently deletes).',
    inputSchema: {
      type: 'object',
      properties: {
        folder:       { type: 'string', description: 'Source folder (default: INBOX)', default: 'INBOX' },
        uid:          { type: 'number', description: 'Email UID' },
        trash_folder: { type: 'string', description: 'Trash folder name (default: auto-detect)', default: '' },
      },
      required: ['uid'],
    },
  },
  {
    name: 'mark_email',
    description: 'Mark an email as read, unread, flagged, or unflagged.',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Folder containing the email (default: INBOX)', default: 'INBOX' },
        uid:    { type: 'number', description: 'Email UID' },
        mark:   { type: 'string', enum: ['read', 'unread', 'flagged', 'unflagged'], description: 'Action to apply' },
      },
      required: ['uid', 'mark'],
    },
  },
];

// ── Tool implementations ──────────────────────────────────────────────────────

async function listFolders(): Promise<string> {
  return withImap(async (client) => {
    const list = await client.list();
    const folders = list.map((f) => f.path);
    return `Folders (${folders.length}):\n${folders.join('\n')}`;
  });
}

async function searchEmails(args: Record<string, unknown>): Promise<string> {
  const folder = (args.folder as string) || 'INBOX';
  const query = args.query as string | undefined;
  const from = args.from as string | undefined;
  const sinceDays = args.since_days as number | undefined;
  const unreadOnly = Boolean(args.unread_only);
  const limit = Math.min((args.limit as number) || 20, 50);

  return withImap(async (client) => {
    await client.mailboxOpen(folder, { readOnly: true });

    const searchCriteria: Record<string, unknown> = {};
    if (unreadOnly) searchCriteria.unseen = true;
    if (from) searchCriteria.from = from;
    if (query) searchCriteria.or = [{ subject: query }, { body: query }];
    if (sinceDays) {
      const since = new Date();
      since.setDate(since.getDate() - sinceDays);
      searchCriteria.since = since;
    }

    const uids = await client.search(Object.keys(searchCriteria).length ? searchCriteria : { all: true }, { uid: true });
    const slice = uids.slice(-limit).reverse(); // most recent first

    if (slice.length === 0) return 'No emails found.';

    const results: string[] = [];
    for await (const msg of client.fetch(slice.join(','), { uid: true, envelope: true, bodyStructure: false }, { uid: true })) {
      const env = msg.envelope;
      const from = env?.from?.[0];
      const fromStr = from ? `${from.name ? from.name + ' ' : ''}<${from.address}>` : '(unknown)';
      results.push(`UID: ${msg.uid} | ${env?.date?.toISOString().split('T')[0] || '?'} | From: ${fromStr} | Subject: ${env?.subject || '(no subject)'}`);
    }

    return `Found ${results.length} email(s) in ${folder}:\n\n${results.join('\n')}`;
  });
}

async function readEmail(args: Record<string, unknown>): Promise<string> {
  const folder = (args.folder as string) || 'INBOX';
  const uid = args.uid as number;

  return withImap(async (client) => {
    await client.mailboxOpen(folder, { readOnly: true });

    let result = '';
    for await (const msg of client.fetch(`${uid}`, { uid: true, envelope: true, source: true }, { uid: true })) {
      const parsed = await simpleParser(msg.source);
      const env = msg.envelope;
      const fromArr = env?.from ?? [];
      const from = fromArr[0];
      const fromStr = from ? `${from.name ? from.name + ' ' : ''}<${from.address}>` : '(unknown)';

      const headers = [
        `UID: ${msg.uid}`,
        `Date: ${env?.date?.toISOString() || parsed.date?.toISOString() || '?'}`,
        `From: ${fromStr}`,
        `To: ${env?.to?.map((a) => a.address).join(', ') || '?'}`,
        `Subject: ${env?.subject || parsed.subject || '(no subject)'}`,
      ];
      if (parsed.cc) headers.push(`CC: ${parsed.cc}`);

      const body = parsed.text || parsed.html?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || '(no body)';
      result = `${headers.join('\n')}\n\n${truncate(body)}`;
    }

    return result || `No email with UID ${uid} found in ${folder}.`;
  });
}

async function sendEmail(args: Record<string, unknown>): Promise<string> {
  const transport = makeTransport();
  const info = await transport.sendMail({
    from: EMAIL_FROM,
    to: args.to as string,
    subject: args.subject as string,
    text: args.body as string,
    ...(args.html ? { html: args.html as string } : {}),
    ...(args.cc ? { cc: args.cc as string } : {}),
    ...(args.bcc ? { bcc: args.bcc as string } : {}),
    ...(args.reply_to ? { replyTo: args.reply_to as string } : {}),
    ...(args.in_reply_to ? { inReplyTo: args.in_reply_to as string, references: args.in_reply_to as string } : {}),
  });
  return `Email sent. Message ID: ${info.messageId}`;
}

async function moveEmail(args: Record<string, unknown>): Promise<string> {
  const folder = (args.folder as string) || 'INBOX';
  const uid = args.uid as number;
  const target = args.target_folder as string;

  return withImap(async (client) => {
    await client.mailboxOpen(folder);
    await client.messageMove(`${uid}`, target, { uid: true });
    return `Email UID ${uid} moved from ${folder} to ${target}.`;
  });
}

async function deleteEmail(args: Record<string, unknown>): Promise<string> {
  const folder = (args.folder as string) || 'INBOX';
  const uid = args.uid as number;

  return withImap(async (client) => {
    // Try to find trash folder
    let trashFolder = (args.trash_folder as string) || '';
    if (!trashFolder) {
      const list = await client.list();
      for (const f of list) {
        const attrs = (f as any).specialUse || '';
        if (attrs === '\\Trash' || /^(Trash|Deleted|Deleted Messages)$/i.test(f.path)) {
          trashFolder = f.path;
          break;
        }
      }
    }

    await client.mailboxOpen(folder);
    if (trashFolder && trashFolder !== folder) {
      await client.messageMove(`${uid}`, trashFolder, { uid: true });
      return `Email UID ${uid} moved to ${trashFolder}.`;
    } else if (args.trash_folder) {
      // Caller explicitly passed a trash_folder that matched the source — permanent delete.
      await client.messageDelete(`${uid}`, { uid: true });
      return `Email UID ${uid} PERMANENTLY DELETED from ${folder} (trash_folder matched source).`;
    } else {
      return `No trash folder detected. Pass trash_folder explicitly to permanently delete, or move the email manually.`;
    }
  });
}

async function markEmail(args: Record<string, unknown>): Promise<string> {
  const folder = (args.folder as string) || 'INBOX';
  const uid = args.uid as number;
  const mark = args.mark as string;

  return withImap(async (client) => {
    await client.mailboxOpen(folder);
    const flagMap: Record<string, { add?: string[]; remove?: string[] }> = {
      read:      { add: ['\\Seen'] },
      unread:    { remove: ['\\Seen'] },
      flagged:   { add: ['\\Flagged'] },
      unflagged: { remove: ['\\Flagged'] },
    };
    const op = flagMap[mark];
    if (op?.add) await client.messageFlagsAdd(`${uid}`, op.add, { uid: true });
    if (op?.remove) await client.messageFlagsRemove(`${uid}`, op.remove, { uid: true });
    return `Email UID ${uid} marked as ${mark}.`;
  });
}

// ── Server wiring ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'nanoclaw-imap', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    let text: string;
    switch (name) {
      case 'list_folders':   text = await listFolders(); break;
      case 'search_emails':  text = await searchEmails(args); break;
      case 'read_email':     text = await readEmail(args); break;
      case 'send_email':     text = await sendEmail(args); break;
      case 'move_email':     text = await moveEmail(args); break;
      case 'delete_email':   text = await deleteEmail(args); break;
      case 'mark_email':     text = await markEmail(args); break;
      default: throw new Error(`Unknown tool: ${name}`);
    }
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
