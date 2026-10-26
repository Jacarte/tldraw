import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { getNamedBoardAllowedHosts } from './named-board-config'

describe('named board browser configuration', () => {
	let directory: string
	beforeEach(() => {
		directory = mkdtempSync(path.join(tmpdir(), 'tldraw-board-config-'))
	})
	afterEach(() => rmSync(directory, { recursive: true, force: true }))

	test('derives exact LAN and Tailscale hosts from the worker configuration', () => {
		writeFileSync(
			path.join(directory, '.dev.vars'),
			'MCP_AUTH_TOKEN="test-token-never-exposed"\n' +
				'NAMED_BOARD_ALLOWED_ORIGINS="http://192.168.1.50:5420, http://100.101.102.103:5420, https://board.example-tailnet.ts.net, http://[fd7a:115c:a1e0::1]:5420, https://board.example-tailnet.ts.net"\n'
		)
		expect(getNamedBoardAllowedHosts(directory)).toEqual([
			'192.168.1.50',
			'100.101.102.103',
			'board.example-tailnet.ts.net',
			'[fd7a:115c:a1e0::1]',
		])
	})

	test('uses .dev.vars exclusively when it exists', () => {
		writeFileSync(path.join(directory, '.dev.vars'), 'MCP_AUTH_TOKEN="test-token"\n')
		writeFileSync(
			path.join(directory, '.env'),
			'NAMED_BOARD_ALLOWED_ORIGINS="https://ignored.example"\n'
		)
		writeFileSync(
			path.join(directory, '.env.local'),
			'NAMED_BOARD_ALLOWED_ORIGINS="https://also-ignored.example"\n'
		)
		expect(getNamedBoardAllowedHosts(directory)).toEqual([])
	})

	test('merges the dotenv files with .env.local taking precedence', () => {
		writeFileSync(
			path.join(directory, '.env'),
			'NAMED_BOARD_ALLOWED_ORIGINS="http://first.example:5420"\n'
		)
		expect(getNamedBoardAllowedHosts(directory)).toEqual(['first.example'])
		writeFileSync(path.join(directory, '.env.local'), 'MCP_AUTH_TOKEN="test-token"\n')
		expect(getNamedBoardAllowedHosts(directory)).toEqual(['first.example'])
		writeFileSync(
			path.join(directory, '.env.local'),
			'NAMED_BOARD_ALLOWED_ORIGINS="https://second.example"\n'
		)
		expect(getNamedBoardAllowedHosts(directory)).toEqual(['second.example'])
	})

	test('needs no additional hosts when configuration is absent or empty', () => {
		expect(getNamedBoardAllowedHosts(directory)).toEqual([])
		writeFileSync(path.join(directory, '.dev.vars'), 'NAMED_BOARD_ALLOWED_ORIGINS=" , "\n')
		expect(getNamedBoardAllowedHosts(directory)).toEqual([])
	})

	test.each([
		'*',
		'null',
		'file://localhost',
		'https://*.example.com',
		'https://.example.com',
		'https://example.com/boards',
		'https://example.com/',
		'https://example.com?token=example',
		'https://user:password@example.com',
	])('rejects an invalid origin before broadening the allowed hosts: %s', (origin) => {
		writeFileSync(path.join(directory, '.dev.vars'), `NAMED_BOARD_ALLOWED_ORIGINS="${origin}"\n`)
		expect(() => getNamedBoardAllowedHosts(directory)).toThrow('NAMED_BOARD_ALLOWED_ORIGINS')
	})
})
