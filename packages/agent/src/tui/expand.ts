import { readFileSync } from "node:fs"
import { join } from "node:path"

const MAX_FILE_BYTES = 200 * 1024

/**
 * Expands `@path` references in a submitted task into the referenced file's
 * content, wrapped in XML markers. References that do not resolve to an
 * existing file are left
 * as-is, so "@" in ordinary prose is never mangled.
 */
export function expandFileReferences(text: string, cwd: string): string {
	return text.replace(/(^|\s)@([^\s@]+)/g, (match, lead: string, rawPath: string) => {
		const resolved = rawPath.startsWith("/")
			? rawPath
			: join(cwd, rawPath)
		let content: string
		try {
			content = readFileSync(resolved, "utf-8")
		} catch {
			return match
		}
		if (Buffer.byteLength(content, "utf-8") > MAX_FILE_BYTES) {
			content = content.slice(0, MAX_FILE_BYTES) + "\n… (file truncated at 200KB)"
		}
		return `${lead}<file path="${resolved}">\n${content}\n</file>`
	})
}
