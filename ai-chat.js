// Secure proxy to Anthropic's Messages API for the in-app network planning assistant.
//
// This function is deliberately "dumb" -- it does no reasoning of its own and never touches
// network/pricing data directly. It exists only to keep ANTHROPIC_API_KEY off the client. All
// tool definitions, tool execution, and conversation state live in the browser, where the real
// app functions (hub placement, pricing, the budget planner) actually run. This function just
// forwards the messages/tools payload to Anthropic and returns the raw response, so every number
// the assistant reports is computed by the app itself, not guessed by the model.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-5-20250929';
const MAX_TOKENS = 2000;

function response(statusCode, bodyObjOrText, extraHeaders) {
  const isString = typeof bodyObjOrText === 'string';
  return {
    statusCode,
    headers: {
      'Content-Type': isString ? 'text/plain' : 'application/json',
      'Access-Control-Allow-Origin': process.env.APP_ORIGIN || '*',
      ...extraHeaders,
    },
    body: isString ? bodyObjOrText : JSON.stringify(bodyObjOrText),
  };
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return response(204, '', {
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
  }
  if (event.httpMethod !== 'POST') {
    return response(405, 'Method not allowed');
  }

  // Origin check, same pattern as the other backend functions in this app -- a browser-side
  // secret isn't a real secret, so this restricts by request origin instead.
  const origin = event.headers.origin || event.headers.Origin || '';
  if (process.env.APP_ORIGIN && origin && origin !== process.env.APP_ORIGIN) {
    return response(403, 'Origin not allowed');
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return response(500, 'ANTHROPIC_API_KEY is not configured on this deployment.');
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return response(400, 'Invalid JSON body');
  }
  const { messages, system, tools } = payload;
  if (!Array.isArray(messages) || messages.length === 0) {
    return response(400, 'Missing or invalid messages array');
  }
  // Sanity cap -- this is a chat assistant, not a document upload.
  const approxSize = JSON.stringify(messages).length;
  if (approxSize > 200000) {
    return response(400, 'Conversation payload too large');
  }

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: system || undefined,
        messages,
        tools: Array.isArray(tools) && tools.length ? tools : undefined,
      }),
    });
    const rawText = await res.text();
    if (!res.ok) {
      return response(res.status, `Anthropic API error (${res.status}): ${rawText.slice(0, 500)}`);
    }
    return response(200, rawText);
  } catch (err) {
    return response(502, `Request to Anthropic failed: ${err.message}`);
  }
};
