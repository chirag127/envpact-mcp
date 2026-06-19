/**
 * envpact-mcp timestamp helper (v3.1, additive — no on-disk schema
 * change). Renders an ISO-8601 UTC string in BOTH UTC and IST per
 * SHARED_SPEC §1.5 so consumers can present users with conflict
 * timestamps in a familiar timezone.
 *
 * IST is always Asia/Kolkata, regardless of the host's local TZ.
 *
 * Mirror in:
 *   - envpact-cli/lib/timestamps.js
 *   - envpact (Python) /envpact/timestamps.py
 *   - envpact-mcp/worker/src/* (inline)
 *   - envpact-vscode (TS port)
 *   - envpact-dashboard (TS port)
 */

/**
 * Format an ISO-8601 UTC string into both UTC + IST renderings.
 *
 * Returns:
 *   {
 *     utc: '2026-06-19T07:30:00.000Z',  // canonical, exactly as stored
 *     ist: '2026-06-19 13:00:00 IST',
 *   }
 *
 * Throws TypeError on non-string input. Returns `{utc: iso, ist:
 * null}` if the string parses to an Invalid Date — callers MUST
 * handle the null case rather than crash a whole conflict prompt
 * because of one malformed timestamp.
 */
export function formatTimestamp(iso) {
  if (typeof iso !== 'string' || iso === '') {
    throw new TypeError('formatTimestamp: iso must be a non-empty string');
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return { utc: iso, ist: null };
  }
  // Asia/Kolkata is UTC+05:30 with no DST. Add 5h30m to the epoch
  // and read the result via UTC getters — this avoids depending on
  // the host's locale data, which is the spec's hard requirement.
  const istEpoch = d.getTime() + (5 * 60 + 30) * 60 * 1000;
  const ist = new Date(istEpoch);
  const yyyy = ist.getUTCFullYear();
  const mm = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(ist.getUTCDate()).padStart(2, '0');
  const hh = String(ist.getUTCHours()).padStart(2, '0');
  const mi = String(ist.getUTCMinutes()).padStart(2, '0');
  const ss = String(ist.getUTCSeconds()).padStart(2, '0');
  return {
    utc: iso,
    ist: `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss} IST`,
  };
}

/**
 * Pick the newer of two ISO-8601 UTC strings. Returns 'a', 'b', or
 * 'tie' (equal timestamps). Either argument may be null/undefined —
 * a missing side loses to a present one; both missing → 'tie'.
 *
 * Used at conflict prompt sites to compute the recommended_side
 * hint. The user keeps the final decision; this just labels the
 * default.
 */
export function newerSide(a, b) {
  const ta = parseTime(a);
  const tb = parseTime(b);
  if (ta === null && tb === null) return 'tie';
  if (ta === null) return 'b';
  if (tb === null) return 'a';
  if (ta > tb) return 'a';
  if (tb > ta) return 'b';
  return 'tie';
}

function parseTime(iso) {
  if (typeof iso !== 'string' || iso === '') return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}
