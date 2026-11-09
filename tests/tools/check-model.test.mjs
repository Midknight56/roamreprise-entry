import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkModel } from '../../dev/check_model.mjs';
const model = '@cf/ibm-granite/granite-4.0-h-micro';
test('deploy model guard accepts the selected model page', async () => {
  assert.equal(await checkModel(async url => {
    assert.equal(url, 'https://developers.cloudflare.com/workers-ai/models/granite-4.0-h-micro/');
    return new Response(model);
  }), model);
});
test('deploy model guard rejects Planned Deprecation even across HTML tags', async () => {
  await assert.rejects(checkModel(async () => new Response(`${model}<h2>Planned <strong>Deprecation</strong></h2>`)), /Planned Deprecation/);
});
test('deploy model guard fails closed on HTTP errors', async () => {
  await assert.rejects(checkModel(async () => new Response('unavailable', { status: 503 })), /HTTP 503/);
});
test('deploy model guard rejects a page for another model', async () => {
  await assert.rejects(checkModel(async () => new Response('different model')), /does not identify/);
});
