// Explicit operator tool: registers a sandbox webhook. Never run as part of tests or build.
const base = 'https://api-m.sandbox.paypal.com';
const url = 'https://roamreprise.midknight-labs.workers.dev/webhooks/paypal';
const types = ['PAYMENT.AUTHORIZATION.CREATED', 'PAYMENT.AUTHORIZATION.VOIDED', 'PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.PENDING', 'PAYMENT.CAPTURE.DECLINED', 'PAYMENT.CAPTURE.REFUNDED'];
async function main() {
  const { PAYPAL_CLIENT_ID: id, PAYPAL_CLIENT_SECRET: secret } = process.env;
  if (!id || !secret) throw new Error('Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET.');
  const tok = await fetch(base + '/v1/oauth2/token', { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
  const token = await tok.json();
  if (!tok.ok || !token.access_token) throw new Error(`PayPal token HTTP ${tok.status}`);
  async function api(path, method = 'GET', body) {
    const response = await fetch(base + path, { method, headers: { Authorization: 'Bearer ' + token.access_token, 'Content-Type': 'application/json', 'PayPal-Request-Id': crypto.randomUUID() }, body: body ? JSON.stringify(body) : undefined });
    if (!response.ok) throw new Error(`PayPal webhook HTTP ${response.status}`);
    return response.json();
  }
  const list = await api('/v1/notifications/webhooks');
  let hook = list.webhooks?.find(h => h.url === url);
  if (hook && !types.every(name => hook.event_types.some(t => t.name === name || t.name === '*'))) {
    hook = await api('/v1/notifications/webhooks/' + encodeURIComponent(hook.id), 'PATCH', [{ op: 'replace', path: '/event_types', value: types.map(name => ({ name })) }]);
  }
  hook ??= await api('/v1/notifications/webhooks', 'POST', { url, event_types: types.map(name => ({ name })) });
  if (!hook.id) throw new Error('No webhook id returned.');
  console.log(hook.id);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
