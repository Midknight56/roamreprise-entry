import { ApiError } from './errors';
/** Bound requests while reading, rather than after allocating an arbitrary-sized body. */
export async function readText(request: Request, maxBytes: number): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder(), pieces: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw new ApiError('BAD_REQUEST', 'Request too large.', 413); }
      pieces.push(decoder.decode(chunk.value, { stream: true }));
    }
    pieces.push(decoder.decode());
    return pieces.join('');
  } finally { reader.releaseLock(); }
}
