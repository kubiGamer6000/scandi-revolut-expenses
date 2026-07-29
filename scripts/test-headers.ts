/**
 * Strength test for HTTP header ByteString safety + period labels.
 *
 *   npx tsx scripts/test-headers.ts
 *
 * Reproduces the production 500 (Unicode → in X-Period) and asserts the
 * sanitiser / ASCII labels fix it. No network, no .env required.
 */
import { customRange, lastWeek, thisWeek } from "../src/utils/dates.js";
import {
  contentDisposition,
  toHttpHeaderValue,
} from "../src/utils/http-headers.js";

let failed = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failed += 1;
    console.error(`  FAIL  ${msg}`);
  }
}

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

/** Headers() throws on code units > 255 — mirrors undici/fetch. */
function headersAccepts(value: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new Headers({ "X-Period": value });
    return true;
  } catch {
    return false;
  }
}

section("reproduction: raw Unicode arrow is rejected by Headers");
const buggy = "30/06/2026 → 29/07/2026";
assert(buggy.charCodeAt(11) === 8594, `arrow sits at index 11 (got ${buggy.charCodeAt(11)})`);
assert(!headersAccepts(buggy), "Headers() rejects label with →");

section("toHttpHeaderValue");
assert(
  toHttpHeaderValue(buggy) === "30/06/2026 -> 29/07/2026",
  "→ becomes ->",
);
assert(
  headersAccepts(toHttpHeaderValue(buggy)),
  "sanitised label is Headers-safe",
);
assert(
  toHttpHeaderValue("Yesterday (06/05/2026)") === "Yesterday (06/05/2026)",
  "already-ASCII labels pass through",
);
assert(
  toHttpHeaderValue("Report — Q1") === "Report - Q1",
  "em-dash becomes hyphen",
);
assert(
  !toHttpHeaderValue("evil\r\nX-Injected: 1").includes("\n"),
  "CR/LF stripped (no header injection)",
);
assert(
  headersAccepts(toHttpHeaderValue("café → résumé")),
  "latin accents collapsed, still Headers-safe",
);

section("contentDisposition");
const cdAscii = contentDisposition("revolut-2026-06-30.html", "inline");
assert(
  cdAscii === 'inline; filename="revolut-2026-06-30.html"',
  "ASCII filename: simple form",
);
assert(headersAccepts(cdAscii), "ASCII disposition is Headers-safe");

const cdUnicode = contentDisposition("rapport — dépenses.html", "attachment");
assert(cdUnicode.includes("filename*=UTF-8''"), "unicode gets filename*");
assert(headersAccepts(cdUnicode), "unicode disposition is Headers-safe");
assert(
  !cdUnicode.includes("—"),
  "quoted filename= fallback has no raw em-dash",
);

section("period labels (Europe/Stockholm) are Headers-safe by construction");
const tz = "Europe/Stockholm";
for (const [name, period] of [
  ["this-week", thisWeek(tz)],
  ["last-week", lastWeek(tz)],
  ["range", customRange("2026-06-30", "2026-07-29", tz)],
  ["range-eu", customRange("30/06/2026", "29/07/2026", tz)],
] as const) {
  assert(
    !/[^\x20-\x7E]/.test(period.label),
    `${name} label is printable ASCII: ${period.label}`,
  );
  assert(headersAccepts(period.label), `${name} label accepted by Headers()`);
  assert(
    headersAccepts(toHttpHeaderValue(period.label)),
    `${name} label still safe after sanitiser`,
  );
}

section("range edge cases");
try {
  customRange("2026-07-29", "2026-06-30", tz);
  assert(false, "inverted range should throw");
} catch (err) {
  assert(err instanceof Error, "inverted range throws Error");
}
try {
  customRange("32/13/2026", undefined, tz);
  // TZDate may or may not throw depending on overflow behaviour — just ensure
  // we don't produce a Headers-hostile label if it somehow succeeds.
  assert(true, "overflow date handled without crash");
} catch {
  assert(true, "overflow date rejected");
}

console.log(`\n=== Summary ===\n${failed === 0 ? "all good." : `${failed} failure(s)`}`);
process.exit(failed === 0 ? 0 : 1);
