// Cloudflare Worker — two jobs:
//   1. POST /            — proxies PDF auto-fill requests from the browser to Claude
//                          (used by the "Auto-fill vendor & amount from PDF" button)
//   2. POST /intake-invoice — receives emailed invoice/pay-app attachments from the
//                          Power Automate flow watching invoices@reddoorconstruction.com,
//                          extracts structured data via Claude, and appends a
//                          "needs review" record to the shared JSONBin store.
//
// Secrets required (Cloudflare dashboard > Worker > Settings > Variables and Secrets):
//   ANTHROPIC_API_KEY  — Anthropic API key
//   INTAKE_SECRET      — random shared secret; Power Automate must send this in the
//                        x-intake-secret header on every request to /intake-invoice
//   JSONBIN_BIN_ID     — the CO tracker bin ID (same one the app already syncs to)
//   JSONBIN_API_KEY    — the JSONBin X-Master-Key

const ALLOWED_ORIGIN = 'https://fabian413.github.io';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/intake-invoice') {
      return handleIntake(request, env);
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

  const { from, subject, receivedAt, filename, mimeType, fileBase64 } = payload;
  if (!fileBase64 || !mimeType) {
    return new Response(JSON.stringify({ error: 'fileBase64 and mimeType are required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
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
              text: 'This is a construction billing document — either a vendor Invoice or a Pay Application (AIA G702/G703-style form with a schedule of values / continuation sheet). Classify it and extract: the document type, the vendor/subcontractor name, the project name if stated, and the total amount currently due or billed (use the final "Total" or "Amount Due" or "Current Payment Due" figure, not a contract sum). If a field cannot be determined, use null. Rate your confidence as low, medium, or high.',
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
                confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
                notes: { type: ['string', 'null'], description: 'Anything the reviewer should double-check' },
              },
              required: ['docType', 'vendor', 'project', 'amount', 'confidence', 'notes'],
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

    const record = {
      id: 'inv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      from: from || 'unknown',
      subject: subject || '',
      receivedAt: receivedAt || new Date().toISOString(),
      filename: filename || 'attachment',
      docType: extracted.docType,
      vendor: extracted.vendor,
      project: extracted.project,
      amount: extracted.amount,
      confidence: extracted.confidence,
      notes: extracted.notes,
      status: 'needs_review',
      pm: '',
      reviewedBy: null,
      reviewedAt: null,
      loggedAt: new Date().toISOString(),
    };

    await appendPendingInvoice(env, record);

    return new Response(JSON.stringify({ ok: true, record }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function appendPendingInvoice(env, record) {
  const binUrl = `https://api.jsonbin.io/v3/b/${env.JSONBIN_BIN_ID}`;
  const headers = {
    'Content-Type': 'application/json',
    'X-Master-Key': env.JSONBIN_API_KEY,
    'X-Bin-Meta': 'false',
  };

  const getRes = await fetch(binUrl + '/latest', { headers });
  if (!getRes.ok) throw new Error('JSONBin read failed: HTTP ' + getRes.status);
  const data = await getRes.json();
  if (!data.pendingInvoices) data.pendingInvoices = [];
  data.pendingInvoices.push(record);

  const putRes = await fetch(binUrl, { method: 'PUT', headers, body: JSON.stringify(data) });
  if (!putRes.ok) throw new Error('JSONBin write failed: HTTP ' + putRes.status);
}
