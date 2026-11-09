// Contract: docs/SPEC.md. Sandbox payments move test money only ($0).
// Cloudflare Free plan hard-stops, rather than bills, when a daily allowance is exhausted:
// https://developers.cloudflare.com/workers-ai/platform/pricing/
// https://developers.cloudflare.com/d1/platform/pricing/
// https://developers.cloudflare.com/durable-objects/platform/pricing/
export const MODEL_ID = '@cf/ibm-granite/granite-4.0-h-micro';
// Granite: $0.017/M input tokens, $0.112/M output; 131,000 token context (we use a tiny slice).
// Workers AI Free includes 10,000 neurons/day; $0.011/1,000 above that applies only on Paid.
export const DEPRECATED_MODELS: readonly string[] = ['@cf/meta/llama-3.2-3b-instruct', '@cf/qwen/qwen3-30b-a3b-fp8'];
export const MAX_INPUT_CHARS = 16_000; // Budget estimate: 4,000 tokens x 1,542/M = 6.168 neurons.
export const MAX_OUTPUT_TOKENS = 512; // 512 x 10,158/M = 5.200896 neurons.
export const RESERVED_NEURONS = 15; // 11.368896 estimated maximum rounded up; reserve BEFORE inference.
export const DAILY_NEURONS = 900; // 900 / 15 = 60 reserved calls = 15 four-call trips, $0.
export const ACCOUNT_DAILY_NEURONS_GUARD = 9_500; // 500 slack below the shared free 10,000/day.
export const MAX_AI_CALLS_PER_TRIP = 4; // One proposal + one repair + two asks, 4 x 15 = 60 reserved neurons per trip; the daily cap is unchanged (900 / 15 = 60 calls).
export const MAX_ASKS_PER_TRIP = 2; // Plain language changes a traveler may ask for after the plan; each may use one AI call.
export const MAX_ASK_CHARS = 160; // Bounded request text, a request about the plan and never an instruction to the system.
export const INPUT_NEURONS_PER_MILLION = 1_542;
export const OUTPUT_NEURONS_PER_MILLION = 10_158;
export const MAX_TRIPS_PER_SID_DAY = 12; // 12 trips cannot exceed the account AI guard; rule fallback costs $0.
export const MAX_TRIPS_PER_DAY = 400; // Bounds storage growth; not an entitlement to extra free-plan resources.
export const MAX_PAYPAL_WRITES_PER_TRIP = 30; // Sandbox $0; includes physical retries, not only logical operations.
export const MAX_PAYPAL_WRITES_PER_DAY = 800; // Shared gate: 800 sandbox writes x $0 = $0.
export const MAX_NOTE_CHARS = 280; // Bounded user input before prompt construction.
export const MIN_CEILING_CENTS = 30_000;
export const MAX_CEILING_CENTS = 150_000;
export const DEFAULT_CEILING_CENTS = 60_000;
export const CACHE_TTL_MS = 24 * 60 * 60 * 1_000; // Cache hits use zero neurons.
// Free D1: 5M rows read/day, 100K written/day, 5 GB storage. With indexes, each AI call writes
// at most 6 rows (insert/update + two indexes): 60 x 6 = 360 rows/day before settled budget reuse.
// Free SQLite DO: 5M rows read/day, 100K written/day, 5 GB stored; storage/compute/request limits
// are account-wide. They hard-stop on Free. The trip cap is NOT a claim of measured row usage.
// The 4 chars/token estimate is not a tokenizer bound. Real usage is always settled, even if >15;
// a provider or free-plan limit still stops calls. The ledger is a guard for participating apps only.
export const utcDay = (date: Date): string => date.toISOString().slice(0, 10);
