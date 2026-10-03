/**
 * The text bounds module: the UTF-8 byte measure and the two cuts that hold a
 * text to a byte bound.
 *
 * Every rule that bounds text by bytes measures and cuts through here: the
 * Response draft's input limit, the recovery context a Replacement Consultation
 * carries, and the captured history a Consultation record stores. The measure
 * and each cut have one name (issue #203 review).
 */

/** Return the UTF-8 size of a text. */
export function utf8ByteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

/** The first `maxBytes` bytes of a text, never cut through a character. */
export function utf8Prefix(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const bytes = Buffer.from(value, "utf8");
	if (bytes.byteLength <= maxBytes) return value;
	let prefix = bytes.subarray(0, maxBytes).toString("utf8");
	while (utf8ByteLength(prefix) > maxBytes) prefix = prefix.slice(0, -1);
	return prefix;
}

/** The last `maxBytes` bytes of a text, never cut through a character. */
export function utf8Suffix(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const bytes = Buffer.from(value, "utf8");
	if (bytes.byteLength <= maxBytes) return value;
	let suffix = bytes.subarray(bytes.byteLength - maxBytes).toString("utf8");
	while (utf8ByteLength(suffix) > maxBytes) suffix = suffix.slice(1);
	return suffix;
}
