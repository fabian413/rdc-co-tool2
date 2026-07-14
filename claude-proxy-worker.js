// Cloudflare Worker — four jobs:
//   1. POST /               — proxies PDF auto-fill requests from the browser to Claude
//                             (used by the "Auto-fill vendor & amount from PDF" button)
//   2. POST /intake-invoice — receives emailed invoice/pay-app attachments from the
//                             Power Automate flow watching invoices@reddoorconstruction.com,
//                             extracts structured data via Claude, uploads the original
//                             file to R2, and appends a "needs review" record to the
//                             shared JSONBin store. Requires the x-intake-secret header
//                             (server-to-server only — Power Automate).
//   3. POST /manual-intake  — same extraction/storage pipeline as /intake-invoice, but
//                             browser-facing (CORS-restricted instead of secret-protected)
//                             for the drag-and-drop upload box in the Accounting tabs.
//   4. GET  /file/:key      — streams a stored attachment back so reviewers can view the
//                             original PDF/image before approving.
//
// Secrets required (Cloudflare dashboard > Worker > Settings > Variables and Secrets):
//   ANTHROPIC_API_KEY  — Anthropic API key
//   INTAKE_SECRET      — random shared secret; Power Automate must send this in the
//                        x-intake-secret header on every request to /intake-invoice
//   JSONBIN_BIN_ID     — the CO tracker bin ID (same one the app already syncs to)
//   JSONBIN_API_KEY    — the JSONBin X-Master-Key
//
// Binding required (Worker > Settings > Bindings > Add > R2 Bucket):
//   INVOICE_FILES      — variable name, bound to an R2 bucket (e.g. "rdc-invoices")

const ALLOWED_ORIGIN = 'https://fabian413.github.io';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/intake-invoice') {
      return handleIntake(request, env);
    }
    if (url.pathname === '/manual-intake') {
      return handleManualIntake(request, env);
    }
    if (url.pathname.startsWith('/file/')) {
      return handleFileServe(request, env, url);
    }
    return handleAutoFillProxy(request, env);
  },
};

// ── /  — browser-facing PDF auto-fill proxy ─────────────────────────
async function handleAutoFillProxy(request, env) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  try {
    const body = await request.text();
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body,
    });
    const data = await anthropicRes.text();
    return new Response(data, {
      status: anthropicRes.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

// ── /file/:key — serve a stored attachment for viewing ─────────────
// CORS headers are required here (not just on the POST endpoints) because
// the Stamp form fetch()es this file directly to re-embed it in a stamped
// PDF — a plain <a href> link (like "View PDF") doesn't need CORS since
// navigation isn't subject to it, but fetch() is.
async function handleFileServe(request, env, url) {
  const corsHeaders = { 'Access-Control-Allow-Origin': ALLOWED_ORIGIN };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: { ...corsHeaders, 'Access-Control-Allow-Methods': 'GET, OPTIONS' } });
  }
  if (request.method !== 'GET') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }
  const key = decodeURIComponent(url.pathname.replace('/file/', ''));
  if (!key) {
    return new Response('Missing file key', { status: 400, headers: corsHeaders });
  }
  const object = await env.INVOICE_FILES.get(key);
  if (!object) {
    return new Response('File not found', { status: 404, headers: corsHeaders });
  }
  const headers = new Headers(corsHeaders);
  object.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'private, max-age=3600');
  return new Response(object.body, { headers });
}

// ── /intake-invoice — server-to-server, called by Power Automate ──────
async function handleIntake(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }
  const secret = request.headers.get('x-intake-secret');
  if (!secret || secret !== env.INTAKE_SECRET) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const record = await processIntakeDocument(payload, env);
    return new Response(JSON.stringify({ ok: true, record }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: err.statusCode || 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ── /manual-intake — browser-facing, used by the Accounting drag-and-drop
//    upload box. Same pipeline as /intake-invoice; protected by CORS
//    (restricted to the GitHub Pages origin) instead of a shared secret,
//    since this is called directly from client JS where a secret would be
//    publicly visible in the page source anyway.
async function handleManualIntake(request, env) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON body' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const record = await processIntakeDocument({ ...payload, from: 'Manual Upload (Accounting)' }, env);
    return new Response(JSON.stringify({ ok: true, record }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: err.statusCode || 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

// Shared by /intake-invoice and /manual-intake: classifies the document via
// Claude, uploads the original file to R2, and appends a "needs review"
// record to the shared JSONBin store. Returns the stored record.
async function processIntakeDocument(payload, env) {
  const { from, subject, receivedAt, filename, mimeType, fileBase64 } = payload;
  if (!fileBase64 || !mimeType) {
    const err = new Error('fileBase64 and mimeType are required');
    err.statusCode = 400;
    throw err;
  }

  const docBlock = mimeType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBase64 } }
    : { type: 'image', source: { type: 'base64', media_type: mimeType, data: fileBase64 } };

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          docBlock,
          {
            type: 'text',
            text: 'This is a construction billing document received as an email attachment. Classify it as exactly one of:\n\n' +
              '"pay_app" — a formal Application and Certificate for Payment (AIA G702/G703-style). It is titled something like "APPLICATION AND CERTIFICATE FOR PAYMENT" or "CONTRACTOR\'S APPLICATION FOR PAYMENT", has an "APPLICATION #" and "PERIOD TO" field, and a set of numbered summary lines such as ORIGINAL CONTRACT SUM, NET CHANGE BY CHANGE ORDERS, CONTRACT SUM TO DATE, TOTAL COMPLETED & STORED TO DATE, RETAINAGE, TOTAL EARNED LESS RETAINAGE, LESS PREVIOUS CERTIFICATES FOR PAYMENT, CURRENT PAYMENT DUE, and BALANCE TO FINISH. It is usually accompanied by a "CONTINUATION SHEET" / Schedule of Values table (columns for scheduled value, work completed this period, materials stored, % complete, retainage). It represents a periodic progress-billing request tied to percent of work completed, and often includes a Contractor certification and/or Architect\'s Certificate for Payment.\n\n' +
              '"invoice" — a simple vendor bill for goods or services rendered: vendor letterhead/logo, an invoice number, line items or a description of work, and a total/amount due. It does NOT have the contract-sum/retainage/percent-complete structure described above.\n\n' +
              '"unknown" — anything else. This includes a Change Order / Change Order Request or Contract Change Order (a document requesting authorization for a scope and cost change — it has fields like vendor, CO/CE number, cost code, description of change, and a dollar amount, but lacks the pay-application numbered summary lines and Schedule of Values). It also includes non-document images such as email signature logos, or anything illegible/unrelated. If the document looks like a Change Order rather than a true pay application, classify it as "unknown" and say so in notes — do not classify a Change Order as "pay_app" just because it involves billing.\n\n' +
              'Extract: the vendor/subcontractor name, the project name if stated, and the total amount currently owed. For a pay_app, use the "CURRENT PAYMENT DUE" line — the amount actually being requested for this billing period, not the contract sum or total completed to date. For an invoice, use its total/amount due. Also extract a brief description of the work or services being billed (a short phrase, e.g. "Ceiling repair — Unit 204" or "Electrical rough-in"), and a best-effort guess at scope: "in" if this appears to be billing for work within the vendor\'s original contracted scope (a normal invoice or pay app against an existing contract), "out" if it appears to be additional/extra work beyond the original contract (e.g. the document itself looks like a change order, or explicitly references a change/extra/additional work), or null if you cannot tell from the document alone — a human will confirm this. If a field cannot be determined, use null. Rate your confidence as low, medium, or high, and use notes to flag anything the reviewer should double-check (including if you suspect this is actually a Change Order).',
          },
        ],
      }],
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              docType: { type: 'string', enum: ['invoice', 'pay_app', 'unknown'] },
              vendor: { type: ['string', 'null'] },
              project: { type: ['string', 'null'] },
              amount: { type: ['string', 'null'] },
              description: { type: ['string', 'null'], description: 'Brief description of the work/services billed' },
              scope: { type: ['string', 'null'], enum: ['in', 'out', null], description: 'Best-effort guess: "in" contracted scope, "out" additional/change work, null if undeterminable' },
              confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
              notes: { type: ['string', 'null'], description: 'Anything the reviewer should double-check' },
            },
            required: ['docType', 'vendor', 'project', 'amount', 'description', 'scope', 'confidence', 'notes'],
            additionalProperties: false,
          },
        },
      },
    }),
  });

  if (!claudeRes.ok) {
    const errText = await claudeRes.text();
    throw new Error('Claude API error ' + claudeRes.status + ': ' + errText);
  }
  const claudeData = await claudeRes.json();
  const textBlock = (claudeData.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('No text content in Claude response');
  const extracted = JSON.parse(textBlock.text);

  const id = 'inv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const ext = mimeType === 'application/pdf' ? 'pdf' : (mimeType.split('/')[1] || 'bin');
  const fileKey = id + '.' + ext;

  // Decode base64 -> bytes and upload the original file to R2
  const binary = atob(fileBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  await env.INVOICE_FILES.put(fileKey, bytes, { httpMetadata: { contentType: mimeType } });

  const record = {
    id,
    from: from || 'unknown',
    subject: subject || '',
    receivedAt: receivedAt || new Date().toISOString(),
    filename: filename || 'attachment',
    fileKey,
    docType: extracted.docType,
    vendor: extracted.vendor,
    project: extracted.project,
    amount: extracted.amount,
    description: extracted.description,
    scope: extracted.scope,
    confidence: extracted.confidence,
    notes: extracted.notes,
    status: 'needs_review',
    pm: '',
    reviewedBy: null,
    reviewedAt: null,
    loggedAt: new Date().toISOString(),
  };

  await appendPendingInvoice(env, record);

  return record;
}

// JSONBin has no atomic append, so concurrent intake requests (e.g. several
// attachments processed at once) can race: two requests both GET the same
// array, each pushes its own record, and whichever PUTs last silently
// overwrites the other's addition. To survive that, verify after writing
// that our record actually stuck, and retry with jittered backoff if a
// concurrent write clobbered it.
async function appendPendingInvoice(env, record) {
  const binUrl = `https://api.jsonbin.io/v3/b/${env.JSONBIN_BIN_ID}`;
  const headers = {
    'Content-Type': 'application/json',
    'X-Master-Key': env.JSONBIN_API_KEY,
    'X-Bin-Meta': 'false',
  };

  const maxAttempts = 8;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const getRes = await fetch(binUrl + '/latest', { headers });
    if (!getRes.ok) throw new Error('JSONBin read failed: HTTP ' + getRes.status);
    const data = await getRes.json();
    if (!data.pendingInvoices) data.pendingInvoices = [];

    if (!data.pendingInvoices.some((r) => r.id === record.id)) {
      data.pendingInvoices.push(record);
      const putRes = await fetch(binUrl, { method: 'PUT', headers, body: JSON.stringify(data) });
      if (!putRes.ok) throw new Error('JSONBin write failed: HTTP ' + putRes.status);
    }

    // Re-read to confirm our record actually survived (a concurrent writer
    // may have PUT its own stale copy right after ours and clobbered it).
    const verifyRes = await fetch(binUrl + '/latest', { headers });
    if (verifyRes.ok) {
      const verifyData = await verifyRes.json();
      if ((verifyData.pendingInvoices || []).some((r) => r.id === record.id)) return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 300 * attempt));
  }
  throw new Error('Failed to persist record after ' + maxAttempts + ' attempts (concurrent write conflicts)');
}
