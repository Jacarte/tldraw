import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CallToolResult, ListToolsResult } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { NamedBoardDocument, NamedBoardMetadata } from './named-boards'
import {
	MINIMAL_FIXTURES,
	parseSSEResult,
	startWranglerDev,
	type WranglerDevHandle,
} from './wrangler-dev-harness'

const AUTH_TOKEN = 'named-boards-integration-test'
const MAX_REQUEST_BYTES = 10 * 1024 * 1024
const ALLOWED_ORIGINS = [
	'http://192.168.1.50:5420',
	'http://100.101.102.103:5420',
	'https://board-host.example-tailnet.ts.net',
]

interface Board extends NamedBoardMetadata {
	document: NamedBoardDocument
}

interface BoardList {
	boards: NamedBoardMetadata[]
	total: number
	nextOffset: number | null
	notes?: string
}

interface BoardView extends NamedBoardMetadata {
	pagesTruncated: boolean
	records: { record: Record<string, unknown>; text: string; truncated: boolean }[]
	nextOffset: number | null
	truncatedRecords: boolean
}

interface BoardError {
	code: string
	error: string
	current?: NamedBoardMetadata
}

function document(extra: NamedBoardDocument['store'] = {}): NamedBoardDocument {
	return {
		schema: { schemaVersion: 2, sequences: {} },
		store: {
			'document:document': {
				id: 'document:document',
				typeName: 'document',
				name: 'Workspace',
			},
			'page:first': { id: 'page:first', typeName: 'page', name: 'Overview' },
			...extra,
		},
	}
}

function assertBoundedResult(result: CallToolResult) {
	expect(result.isError).not.toBe(true)
	expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(
		100 * 1024
	)
	const text = result.content.find((entry) => entry.type === 'text')
	expect(text?.type).toBe('text')
	if (!text || text.type !== 'text') throw new Error('Expected a text result')
	// Hosts that only forward text must receive the same records and continuation token.
	expect(JSON.parse(text.text.slice(text.text.indexOf('\n') + 1))).toEqual(result.structuredContent)
}

describe('named boards through the real worker', () => {
	let port = 10_300 + (process.pid % 500)
	let server: WranglerDevHandle | null = null
	let persistTo: string
	let rpcId = 1
	const base = () => server!.base

	async function start(allowedOrigins = ALLOWED_ORIGINS.join(',')) {
		server = await startWranglerDev({
			port: port++,
			persistTo,
			fixtures: MINIMAL_FIXTURES,
			vars: {
				MCP_AUTH_TOKEN: AUTH_TOKEN,
				NAMED_BOARD_ALLOWED_ORIGINS: allowedOrigins,
			},
		})
	}

	async function stop() {
		const previous = server
		server = null
		if (!previous) return
		previous.stop()
		const deadline = Date.now() + 5000
		while (Date.now() < deadline) {
			try {
				await fetch(`${previous.base}/health`, { signal: AbortSignal.timeout(250) })
			} catch {
				return
			}
			await new Promise((resolve) => setTimeout(resolve, 25))
		}
		throw new Error('wrangler did not stop within 5 seconds')
	}

	beforeAll(async () => {
		persistTo = await mkdtemp(join(tmpdir(), 'tldraw-named-boards-'))
		await start()
	}, 90_000)

	afterAll(async () => {
		try {
			await stop()
		} finally {
			if (persistTo) await rm(persistTo, { recursive: true, force: true })
		}
	}, 10_000)

	function request(path: string, options: RequestInit = {}) {
		const headers = new Headers(options.headers)
		headers.set('Authorization', `Bearer ${AUTH_TOKEN}`)
		return fetch(`${base()}${path}`, {
			...options,
			headers,
			signal: AbortSignal.timeout(20_000),
		})
	}

	async function json<T>(response: Response, expectedStatus = 200): Promise<T> {
		const text = await response.text()
		expect(response.status, text.slice(0, 1000)).toBe(expectedStatus)
		return JSON.parse(text) as T
	}

	function postRejectedInput(
		path: string,
		options: {
			body: string | Uint8Array[]
			headers?: Record<string, string>
			statusOnly?: boolean
		}
	) {
		// Use a separate connection: cancelling an upload can invalidate the proxy's fetch stream.
		return new Promise<Response>((resolve, reject) => {
			let settled = false
			const client = httpRequest(
				`${base()}${path}`,
				{
					method: 'POST',
					agent: false,
					headers: {
						Authorization: `Bearer ${AUTH_TOKEN}`,
						'Content-Type': 'application/json',
						...options.headers,
					},
				},
				(response) => {
					if (options.statusOnly) {
						settled = true
						resolve(new Response(null, { status: response.statusCode }))
						response.destroy()
						client.destroy()
						return
					}
					const chunks: Buffer[] = []
					response.on('data', (chunk: Buffer) => chunks.push(chunk))
					response.once('error', reject)
					response.once('end', () => {
						settled = true
						resolve(
							new Response(Buffer.concat(chunks).toString('utf8'), { status: response.statusCode })
						)
					})
				}
			)
			client.once('error', (error) => {
				if (!settled) reject(error)
			})
			client.setTimeout(20_000, () => client.destroy(new Error('Timed out sending rejected input')))
			if (typeof options.body === 'string') client.end(options.body)
			else {
				for (const chunk of options.body) client.write(chunk)
				client.end()
			}
		})
	}

	function save({
		id,
		title = 'Board',
		baseRevision = 0,
		snapshot = document(),
		origin,
	}: {
		id: string
		title?: string
		baseRevision?: number
		snapshot?: NamedBoardDocument
		origin?: string
	}) {
		return request(`/boards/${id}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
			body: JSON.stringify({ title, document: snapshot, baseRevision }),
		})
	}

	function mcp(body: unknown, sessionId?: string) {
		return request('/mcp', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json, text/event-stream',
				...(sessionId ? { 'mcp-session-id': sessionId } : {}),
			},
			body: JSON.stringify(body),
		})
	}

	async function session() {
		const response = await mcp({
			jsonrpc: '2.0',
			id: rpcId++,
			method: 'initialize',
			params: {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'named-boards-test', version: '1.0' },
			},
		})
		expect(response.status).toBe(200)
		const id = response.headers.get('mcp-session-id')
		expect(id).toBeTruthy()
		await response.text()
		const initialized = await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, id!)
		expect(initialized.status).toBe(202)
		await initialized.text()
		return id!
	}

	async function rpc<T>(sessionId: string, method: string, params?: unknown): Promise<T> {
		const response = await mcp({ jsonrpc: '2.0', id: rpcId++, method, params }, sessionId)
		expect(response.status).toBe(200)
		const message = parseSSEResult(await response.text()) as {
			result: T
			error?: { code: number; message: string }
		}
		expect(message.error).toBeUndefined()
		return message.result
	}

	async function tool<T>(sessionId: string, name: string, args: Record<string, unknown>) {
		const result = await rpc<CallToolResult>(sessionId, 'tools/call', { name, arguments: args })
		expect(result.structuredContent).toBeDefined()
		return { result, data: result.structuredContent as T }
	}

	test('round-trips a full document and rejects stale revisions without replacing it', async () => {
		const id = randomUUID()
		const snapshot = document({
			'shape:text': {
				id: 'shape:text',
				typeName: 'shape',
				parentId: 'page:first',
				props: { text: 'Keep this content' },
			},
		})
		const created = await json<NamedBoardMetadata>(await save({ id, title: 'Dashboard', snapshot }))
		expect(created).toEqual({
			id,
			title: 'Dashboard',
			revision: 1,
			updatedAt: expect.any(Number),
			recordCount: 3,
		})
		expect(await json<Board>(await request(`/boards/${id}`))).toEqual({
			...created,
			document: snapshot,
		})
		const updated = await json<NamedBoardMetadata>(
			await save({ id, title: 'Renamed dashboard', baseRevision: 1, snapshot })
		)
		expect(updated.revision).toBe(2)
		for (const baseRevision of [0, 1]) {
			const error = await json<BoardError>(await save({ id, baseRevision }), 409)
			expect(error).toEqual({
				code: 'revision_conflict',
				error: expect.any(String),
				current: updated,
			})
		}
		expect(await json<Board>(await request(`/boards/${id}`))).toEqual({
			...updated,
			document: snapshot,
		})
	})

	test('admits only one simultaneous create for the same ID', async () => {
		const id = randomUUID()
		const responses = await Promise.all([
			save({ id, title: 'First' }),
			save({ id, title: 'Second' }),
		])
		expect(responses.map((response) => response.status).sort()).toEqual([200, 409])
		const winner = await json<NamedBoardMetadata>(
			responses.find((response) => response.status === 200)!
		)
		await json<BoardError>(responses.find((response) => response.status === 409)!, 409)
		expect(await json<Board>(await request(`/boards/${id}`))).toEqual({
			...winner,
			document: document(),
		})
	})

	test('round-trips embedded media and Unicode larger than the SQLite row limit', async () => {
		const id = randomUUID()
		const snapshot = document({
			'asset:image': {
				id: 'asset:image',
				typeName: 'asset',
				props: { src: `data:image/png;base64,${'A'.repeat(3 * 1024 * 1024)}` },
			},
			'shape:unicode': {
				id: 'shape:unicode',
				typeName: 'shape',
				props: { text: '漢字🙂'.repeat(170_000) },
			},
		})
		const saved = await json<NamedBoardMetadata>(await save({ id, snapshot }))
		expect(await json<Board>(await request(`/boards/${id}`))).toEqual({
			...saved,
			document: snapshot,
		})
	}, 20_000)

	test('leaves the saved document and revision intact after an invalid update', async () => {
		const id = randomUUID()
		const saved = await json<NamedBoardMetadata>(await save({ id, title: 'Original' }))
		const invalid = document({
			'asset:temporary': {
				id: 'asset:temporary',
				typeName: 'asset',
				props: { src: 'blob:http://localhost/temporary' },
			},
		})
		const error = await json<BoardError>(
			await save({ id, title: 'Failed update', baseRevision: 1, snapshot: invalid }),
			400
		)
		expect(error.code).toBe('transient_asset')
		expect(await json<Board>(await request(`/boards/${id}`))).toEqual({
			...saved,
			document: document(),
		})
	})

	test('searches punctuation literally and returns deterministic pages', async () => {
		const prefix = randomUUID()
		for (const suffix of ['z', 'a', 'm']) {
			await json(
				await save({
					id: `${prefix}-${suffix}`,
					title: `${prefix} Dashboard${suffix === 'a' ? ' 50%_complete' : ''}`,
				})
			)
		}
		const literal = await json<BoardList>(await request('/boards?query=%25_'))
		expect(literal.boards.map((board) => board.id)).toEqual([`${prefix}-a`])
		const first = await json<BoardList>(
			await request(`/boards?query=${prefix.toUpperCase()}&limit=2`)
		)
		expect(first.boards.map((board) => board.id)).toEqual([`${prefix}-a`, `${prefix}-m`])
		expect(first.nextOffset).toBe(2)
		const second = await json<BoardList>(
			await request(`/boards?query=${prefix}&limit=2&offset=${first.nextOffset}`)
		)
		expect(second.boards.map((board) => board.id)).toEqual([`${prefix}-z`])
		expect(second.nextOffset).toBeNull()
	})

	test('preserves bearer authentication for browser boards and MCP', async () => {
		for (const path of ['/boards', '/mcp']) {
			for (const authorization of [undefined, 'Bearer wrong-test-token']) {
				const headers = new Headers({ Origin: ALLOWED_ORIGINS[0] })
				if (authorization) headers.set('Authorization', authorization)
				const response = await fetch(`${base()}${path}`, {
					headers,
					signal: AbortSignal.timeout(5000),
				})
				expect(response.status).toBe(401)
				await response.text()
			}
		}
	})

	test('accepts no-Origin, loopback, configured LAN and Tailscale requests through both checks', async () => {
		for (const origin of [
			undefined,
			'http://localhost:5420',
			'http://127.0.0.1:5420',
			'http://[::1]:5420',
			...ALLOWED_ORIGINS,
		]) {
			const response = await request('/boards', { headers: origin ? { Origin: origin } : {} })
			expect(response.status).toBe(200)
			expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
			await response.text()
		}
		const id = randomUUID()
		const saved = await json<NamedBoardMetadata>(await save({ id, origin: ALLOWED_ORIGINS[0] }))
		expect(
			await json<Board>(await request(`/boards/${id}`, { headers: { Origin: ALLOWED_ORIGINS[2] } }))
		).toEqual({
			...saved,
			document: document(),
		})
	})

	test('rejects lookalikes, wrong schemes or ports, wildcards and opaque origins', async () => {
		for (const origin of [
			'http://192.168.1.50:5421',
			'https://192.168.1.50:5420',
			'http://192.168.1.50.attacker.example:5420',
			'https://board-host.example-tailnet.ts.net.attacker.example',
			'https://sub.board-host.example-tailnet.ts.net',
			'https://board-host.example-tailnet.ts.net:5420',
			'http://other.example-tailnet.ts.net',
			'http://*.example-tailnet.ts.net',
			'http://localhost.attacker.example',
			'file://localhost',
			'null',
			'*',
		]) {
			const error = await json<BoardError>(
				await request('/boards', { headers: { Origin: origin } }),
				403
			)
			expect(error.code).toBe('forbidden_origin')
		}
	})

	test('rejects unsafe IDs, invalid snapshots and browser-only asset URLs', async () => {
		const envelope = { title: 'Board', document: document(), baseRevision: 0 }
		for (const id of ['bad%2Fid', 'has%20spaces', '_starts-with-underscore', 'x'.repeat(129)]) {
			await json(await request(`/boards/${id}`), 400)
		}
		for (const value of [
			{ ...envelope, baseRevision: undefined },
			{ ...envelope, title: ' ' },
			{ ...envelope, title: 't'.repeat(129) },
			{ ...envelope, document: { schema: { schemaVersion: '2' }, store: {} } },
			{
				...envelope,
				document: document({ 'shape:key': { id: 'shape:other', typeName: 'shape' } }),
			},
		]) {
			await json(
				await postRejectedInput(`/boards/${randomUUID()}`, {
					body: JSON.stringify(value),
				}),
				400
			)
		}
		for (const src of ['blob:http://localhost/abc', 'asset:missing-local-bytes']) {
			const error = await json<BoardError>(
				await save({
					id: randomUUID(),
					snapshot: document({
						'asset:test': { id: 'asset:test', typeName: 'asset', props: { src } },
					}),
				}),
				400
			)
			expect(error.code).toBe('transient_asset')
		}
	})

	test('serializes nested record data across real Durable Object RPC without prototype pollution', async () => {
		const id = randomUUID()
		const props = JSON.parse(
			'{"nested":{"items":[{"x":1,"y":2}]},"__proto__":{"injected":"ordinary data"}}'
		)
		await json(
			await save({
				id,
				snapshot: document({
					'shape:nested': { id: 'shape:nested', typeName: 'shape', parentId: 'page:first', props },
				}),
			})
		)
		const { result, data } = await tool<BoardView>(await session(), 'read_board', { boardId: id })
		assertBoundedResult(result)
		const shape = data.records.find((entry) => entry.record.id === 'shape:nested')!
		expect(shape.record.props).toEqual(props)
		expect(Object.getOwnPropertyDescriptor(shape.record.props, '__proto__')?.value).toEqual({
			injected: 'ordinary data',
		})
		expect(Object.prototype).not.toHaveProperty('injected')
	}, 30_000)

	test('exposes read-only tools and reads grouped shapes, rich text, bindings and page assets', async () => {
		const id = randomUUID()
		await json(
			await save({
				id,
				title: id,
				snapshot: document({
					'page:other': { id: 'page:other', typeName: 'page', name: 'Other page' },
					'shape:group': {
						id: 'shape:group',
						typeName: 'shape',
						type: 'group',
						parentId: 'page:first',
					},
					'shape:text': {
						id: 'shape:text',
						typeName: 'shape',
						parentId: 'shape:group',
						props: {
							richText: {
								type: 'doc',
								content: [
									{
										type: 'paragraph',
										content: [
											{ type: 'text', text: 'Revenue ' },
											{ type: 'text', text: '42' },
										],
									},
									{ type: 'paragraph', content: [{ type: 'text', text: 'Next quarter' }] },
								],
							},
						},
					},
					'shape:image': {
						id: 'shape:image',
						typeName: 'shape',
						parentId: 'page:first',
						props: { assetId: 'asset:kept' },
					},
					'shape:other': {
						id: 'shape:other',
						typeName: 'shape',
						parentId: 'page:other',
						props: { text: 'Other content' },
					},
					'binding:arrow': {
						id: 'binding:arrow',
						typeName: 'binding',
						fromId: 'shape:text',
						toId: 'shape:image',
					},
					'asset:kept': {
						id: 'asset:kept',
						typeName: 'asset',
						props: { src: 'https://example.invalid/image.png' },
					},
					'asset:unused': {
						id: 'asset:unused',
						typeName: 'asset',
						props: { src: 'https://example.invalid/unused.png' },
					},
				}),
			})
		)
		const sessionId = await session()
		const { tools } = await rpc<ListToolsResult>(sessionId, 'tools/list')
		for (const name of ['search_boards', 'read_board']) {
			expect(tools.find((item) => item.name === name)?.annotations).toMatchObject({
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
			})
		}
		expect(tools.find((item) => item.name === 'search_boards')?.description).toContain(
			'instead of guessing'
		)
		const search = await tool<BoardList>(sessionId, 'search_boards', { query: id })
		expect(search.data.boards.map((board) => board.id)).toEqual([id])
		const { result, data } = await tool<BoardView>(sessionId, 'read_board', {
			boardId: id,
			pageId: 'page:first',
		})
		assertBoundedResult(result)
		expect(data.records.map((entry) => entry.record.id)).toEqual([
			'asset:kept',
			'binding:arrow',
			'document:document',
			'page:first',
			'shape:group',
			'shape:image',
			'shape:text',
		])
		expect(data.records.find((entry) => entry.record.id === 'shape:text')?.text).toBe(
			'Revenue 42\nNext quarter'
		)
		expect(data.records.find((entry) => entry.record.id === 'asset:kept')?.record.props).toEqual({
			src: 'https://example.invalid/image.png',
		})
	}, 30_000)

	test('paginates bounded previews, omits embedded bytes and detects edits between reads', async () => {
		const id = randomUUID()
		const records: NamedBoardDocument['store'] = {
			'asset:large': {
				id: 'asset:large',
				typeName: 'asset',
				props: { src: `data:image/png;base64,${'Z'.repeat(2 * 1024 * 1024)}` },
			},
		}
		for (let index = 0; index < 30; index++) {
			const shapeId = `shape:${index.toString().padStart(3, '0')}`
			records[shapeId] = {
				id: shapeId,
				typeName: 'shape',
				parentId: 'page:first',
				props: {
					text: '漢🙂'.repeat(3000),
					points: Array.from({ length: 300 }, (_, x) => ({ x, y: x / 2 })),
				},
			}
		}
		const snapshot = document(records)
		await json(await save({ id, snapshot }))
		const sessionId = await session()
		const seen = new Set<unknown>()
		let offset = 0
		for (;;) {
			const { result, data } = await tool<BoardView>(sessionId, 'read_board', {
				boardId: id,
				revision: 1,
				offset,
				limit: 200,
			})
			assertBoundedResult(result)
			expect(JSON.stringify(result)).not.toContain('Z'.repeat(100))
			expect(data.records.length).toBeGreaterThan(0)
			expect(data.truncatedRecords).toBe(true)
			for (const entry of data.records) {
				expect(seen.has(entry.record.id)).toBe(false)
				seen.add(entry.record.id)
			}
			if (data.nextOffset === null) break
			expect(data.nextOffset).toBe(offset + data.records.length)
			offset = data.nextOffset
		}
		expect(seen.size).toBe(Object.keys(snapshot.store).length)
		await json(await save({ id, baseRevision: 1, snapshot }))
		const stale = await tool<BoardError>(sessionId, 'read_board', {
			boardId: id,
			revision: 1,
			offset: 10,
		})
		expect(stale.result.isError).toBe(true)
		expect(stale.data).toMatchObject({ code: 'revision_conflict', current: { revision: 2 } })
		expect(stale.data.current).not.toHaveProperty('document')
		expect(JSON.stringify(stale.result).length).toBeLessThan(2000)
	}, 30_000)

	test('makes progress with long Unicode page identifiers and names', async () => {
		const id = randomUUID()
		const pages: NamedBoardDocument['store'] = {}
		for (let index = 0; index < 120; index++) {
			const pageId = `page:${index.toString().padStart(3, '0')}:${'漢'.repeat(480)}`
			pages[pageId] = { id: pageId, typeName: 'page', name: '界'.repeat(128) }
		}
		await json(await save({ id, snapshot: document(pages) }))
		const { result, data } = await tool<BoardView>(await session(), 'read_board', {
			boardId: id,
			limit: 200,
		})
		assertBoundedResult(result)
		expect(data.pagesTruncated).toBe(true)
		expect(data.records.length).toBeGreaterThan(0)
		expect(data.nextOffset).toBeGreaterThan(0)
	}, 30_000)

	test('bounds escaped record text without dropping or skipping records', async () => {
		const id = randomUUID()
		const records: NamedBoardDocument['store'] = {}
		for (let index = 0; index < 20; index++) {
			const shapeId = `shape:${index.toString().padStart(3, '0')}`
			records[shapeId] = {
				id: shapeId,
				typeName: 'shape',
				parentId: 'page:first',
				props: { text: `"\\\u0001`.repeat(2500), metadata: '\\"'.repeat(6000) },
			}
		}
		await json(await save({ id, snapshot: document(records) }))
		const sessionId = await session()
		const seen = new Set<unknown>()
		let offset = 0
		for (;;) {
			const { result, data } = await tool<BoardView>(sessionId, 'read_board', {
				boardId: id,
				offset,
				revision: 1,
			})
			assertBoundedResult(result)
			expect(data.records.length).toBeGreaterThan(0)
			for (const entry of data.records) {
				expect(seen.has(entry.record.id)).toBe(false)
				seen.add(entry.record.id)
			}
			if (data.nextOffset === null) break
			expect(data.nextOffset).toBe(offset + data.records.length)
			offset = data.nextOffset
		}
		expect(seen.size).toBe(22)
	}, 30_000)

	test('bounds large search results and asks the agent to resolve ambiguous names', async () => {
		const prefix = randomUUID()
		for (let index = 0; index < 100; index++) {
			await json(
				await save({
					id: `${prefix}-${index.toString().padStart(3, '0')}`,
					title: `${prefix}${'\u0001'.repeat(90)}`,
				})
			)
		}
		const { result, data } = await tool<BoardList>(await session(), 'search_boards', {
			query: prefix,
			limit: 100,
		})
		assertBoundedResult(result)
		expect(data.total).toBe(100)
		expect(data.boards.length).toBeGreaterThan(0)
		expect(data.nextOffset).toBe(data.boards.length)
		expect(data.notes).toContain('ambiguous')
	}, 30_000)

	test('keeps documents across a worker restart and defaults back to loopback-only access', async () => {
		const id = randomUUID()
		const snapshot = document({
			'shape:persisted': {
				id: 'shape:persisted',
				typeName: 'shape',
				props: { text: 'Survives restart' },
			},
		})
		const saved = await json<NamedBoardMetadata>(await save({ id, snapshot }))
		await stop()
		try {
			await start('')
			expect(await json<Board>(await request(`/boards/${id}`))).toEqual({
				...saved,
				document: snapshot,
			})
			const read = await tool<BoardView>(await session(), 'read_board', { boardId: id })
			expect(read.data.records.find((entry) => entry.record.id === 'shape:persisted')?.text).toBe(
				'Survives restart'
			)
			await json(await request('/boards', { headers: { Origin: ALLOWED_ORIGINS[0] } }), 403)
			await json(await request('/boards', { headers: { Origin: 'http://localhost:5420' } }))
		} finally {
			await stop()
			await start()
		}
	}, 180_000)

	// Keep cancelled uploads last; Wrangler may retire its upstream HTTP connection afterward.
	test('enforces the 10 MiB limit with and without Content-Length and rejects malformed bodies', async () => {
		const id = randomUUID()
		await json(
			await postRejectedInput(`/boards/${id}`, {
				body: '{oops',
			}),
			400
		)
		await json(
			await postRejectedInput(`/boards/${id}`, {
				body: '{}',
				headers: { 'Content-Type': 'text/plain' },
			}),
			415
		)
		const announced = await postRejectedInput(`/boards/${id}`, {
			headers: { 'Content-Length': String(MAX_REQUEST_BYTES + 1) },
			body: ' '.repeat(MAX_REQUEST_BYTES + 1),
			statusOnly: true,
		})
		expect(announced.status).toBe(413)
		const streamed = await postRejectedInput(`/boards/${id}`, {
			body: Array.from({ length: 161 }, () => new Uint8Array(64 * 1024)),
			statusOnly: true,
		})
		expect(streamed.status).toBe(413)
	}, 20_000)
})
