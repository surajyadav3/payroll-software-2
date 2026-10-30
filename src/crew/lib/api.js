import { supabase } from '@/lib/supabase';

/**
 * The only way the ported screens (src/crew) talk to the server.
 *
 * On the new platform this is a REST client; here the same routes are served by two database
 * functions that mirror that API one to one — work_api() for /work and /directory, perf_api()
 * for /pms and /departments (supabase/migrations/20261010_23…, 20261010_25…). Every rule lives
 * there, so the mobile app gets the same behaviour from the same calls.
 *
 * Errors come back as ApiError with the server's machine `code` (REASON_REQUIRED, DUE_REQUIRED,
 * FORBIDDEN, …) and a message that is safe to show.
 */
export class ApiError extends Error {
    constructor(status, code, message, fieldErrors = [], body = {}) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
        this.fieldErrors = fieldErrors;
        this.body = body;
    }
}

const STATUS = { FORBIDDEN: 403, FEATURE_DISABLED: 403, NOT_FOUND: 404, VALIDATION: 422 };
const UNPROCESSABLE = new Set(['REASON_REQUIRED', 'DUE_REQUIRED', 'DELIVERABLE_REQUIRED', 'ASSIGNEE_INVALID', 'CHANNEL_NAME']);

function toApiError(error) {
    // Raised on purpose by the API functions: MESSAGE is for the person, DETAIL is the code.
    if (error?.code === 'P0001' && error.details) {
        const code = String(error.details);
        return new ApiError(STATUS[code] ?? (UNPROCESSABLE.has(code) ? 422 : 409), code, error.message);
    }
    console.error('crew api:', error);
    const offline = error?.name === 'TypeError' || /Failed to fetch|NetworkError|timed out/i.test(error?.message ?? '');
    return new ApiError(offline ? 0 : 500, offline ? 'NETWORK' : 'SERVER_ERROR', offline ? 'Could not reach the server. Check your connection and try again.' : 'Something went wrong on our side. Please try again.');
}

const functionFor = (path) => (path.startsWith('/pms') || path.startsWith('/departments') ? 'perf_api' : 'work_api');

/**
 * api('/work/tasks', { query: { assignee: 'me', open: true } })
 * api(`/work/tasks/${id}/transition`, { method: 'POST', body: { to: 'done' } })
 */
export async function api(path, opts = {}) {
    const query = {};
    for (const [k, v] of Object.entries(opts.query ?? {})) {
        if (v !== undefined && v !== null && v !== '') query[k] = String(v);
    }
    // Optimistic concurrency: the platform sends the version as an If-Match header.
    const ifMatch = opts.headers?.['if-match'];
    if (ifMatch) query.ifMatch = String(ifMatch).replace(/"/g, '');
    const { data, error } = await supabase.rpc(functionFor(path), {
        p_method: opts.method ?? 'GET',
        p_path: path,
        p_query: query,
        p_body: opts.body === undefined ? null : opts.body,
    });
    if (error) throw toApiError(error);
    return data;
}
