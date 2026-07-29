/**
 * HTTP header values must be ByteStrings (every code unit ≤ 0xFF). Node's
 * fetch/undici and the WHATWG Headers API throw when you pass Unicode like
 * `→` (U+2192). Period labels used to embed that arrow, which turned every
 * `range` / `this-week` / `last-week` report into a 500:
 *
 *   Cannot convert argument to a ByteString because the character at index
 *   11 has a value of 8594 which is greater than 255.
 *
 * Keep display bodies free to use Unicode; sanitize at the header boundary.
 */

const REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
	[/→|⟶|➔|➜/g, "->"],
	[/←|⟵/g, "<-"],
	[/—|–|―/g, "-"],
	[/…/g, "..."],
	[/[“”]/g, '"'],
	[/[‘’]/g, "'"],
]

/**
 * Collapse common Unicode punctuation to ASCII and drop anything else that
 * is not printable Latin-1. Safe for `X-*` headers and quoted-string
 * Content-Disposition filenames.
 */
export function toHttpHeaderValue(value: string): string {
	let out = value
	for (const [re, rep] of REPLACEMENTS) out = out.replace(re, rep)
	// Strip CR/LF (header injection) and anything outside printable ASCII.
	// Latin-1 (≤0xFF) would also be legal, but ASCII is the safest common
	// denominator for custom X-* headers and filename= fallbacks.
	return out.replace(/[^\x20-\x7E]/g, "_")
}

/**
 * RFC 6266 Content-Disposition with an ASCII `filename` fallback and an
 * RFC 5987 `filename*` for the original UTF-8 name when needed.
 */
export function contentDisposition(
	filename: string,
	kind: "inline" | "attachment" = "inline",
): string {
	const ascii = toHttpHeaderValue(filename).replace(/["\\;]/g, "_")
	const needsExtended = ascii !== filename
	if (!needsExtended) {
		return `${kind}; filename="${ascii}"`
	}
	const encoded = encodeURIComponent(filename).replace(
		/[!'()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
	)
	return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`
}
