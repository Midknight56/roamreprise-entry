export class ApiError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}
export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
  // Log the cause (name, message, first stack lines) so a 500 can be traced; no request bodies or secrets.
  const e = error as { name?: string; message?: string; stack?: string };
  console.error(JSON.stringify({ internal: e?.name ?? typeof error, message: e?.message, stack: e?.stack?.split('\n').slice(0, 4).join(' | ') }));
  return Response.json({ error: 'INTERNAL', message: 'The request could not be completed. Try again.' }, { status: 500 });
}
