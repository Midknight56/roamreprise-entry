import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
export async function checkModel(fetchFn = fetch) {
  const caps = await readFile(new URL('../src/caps.ts', import.meta.url), 'utf8');
  const model = /export const MODEL_ID = '([^']+)'/.exec(caps)?.[1];
  if (!model) throw new Error('MODEL_ID not found. Deploy stopped.');
  const name = model.split('/').at(-1);
  const res = await fetchFn(`https://developers.cloudflare.com/workers-ai/models/${name}/`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Model check HTTP ${res.status}. Deploy stopped.`);
  const text = await res.text();
  if (/Planned\s+Deprecation/i.test(text.replace(/<[^>]*>/g, ' '))) throw new Error('Model has Planned Deprecation. Deploy stopped.');
  if (!text.includes(model)) throw new Error('Model page does not identify MODEL_ID. Deploy stopped.');
  return model;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(await checkModel()); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
