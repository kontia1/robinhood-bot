function parseResetAt(msg) {
  const m = msg.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s*(GMT[+-]\d{2}:?\d{2})/i);
  if (!m) return null;
  const iso = m[1].replace(" ", "T") + m[2].replace("GMT", "");
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}
const msg1 = "HTTP 429 code=429 error=RATE_LIMIT_BANNED message=IP is temporarily banned due to repeated rate limit violations. Rate limit resets at 2026-09-09 16:02:33 GMT+08:00 (~289s remaining). Stop sending requests before then; repeated requests can extend the ban by 5s up to 5 minutes.";
const r = parseResetAt(msg1);
console.log("now     :", new Date().toISOString());
console.log("resetAt :", r ? new Date(r).toISOString() : null);
console.log("backoff ms:", r ? Math.max(5000, r - Date.now() + 10000) : null, "(≈", r ? Math.round((r - Date.now() + 10000)/1000) : null, "s)");
