import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parse } from 'dotenv'

export function getNamedBoardAllowedHosts(workerDirectory: string): string[] {
	// Follow Wrangler's file precedence without copying its secrets into Vite's defines.
	const files = existsSync(path.join(workerDirectory, '.dev.vars'))
		? ['.dev.vars']
		: ['.env', '.env.local']
	let allowedOrigins = ''
	for (const name of files) {
		const filename = path.join(workerDirectory, name)
		if (!existsSync(filename)) continue
		const value = parse(readFileSync(filename)).NAMED_BOARD_ALLOWED_ORIGINS
		if (value !== undefined) allowedOrigins = value
	}

	const hosts = new Set<string>()
	for (const value of allowedOrigins.split(',')) {
		const origin = value.trim()
		if (!origin) continue
		let url: URL
		try {
			url = new URL(origin)
		} catch {
			throw new Error('NAMED_BOARD_ALLOWED_ORIGINS must contain comma-separated HTTP(S) origins.')
		}
		if (
			!['http:', 'https:'].includes(url.protocol) ||
			url.origin !== origin ||
			url.hostname.includes('*') ||
			url.hostname.startsWith('.')
		) {
			throw new Error(
				'NAMED_BOARD_ALLOWED_ORIGINS must contain exact HTTP(S) origins without paths or wildcards.'
			)
		}
		hosts.add(url.hostname)
	}
	return [...hosts]
}
