/** Shared text helpers for formatters and runtime previews. */

export function truncateText(value: string | null | undefined, maxLength = 90): string {
	if (value == null) return "";
	const text = String(value);
	if (text.length <= maxLength) return text;
	if (maxLength <= 1) return text.slice(0, maxLength);
	return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
	return count === 1 ? singular : plural;
}

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}
