import { DatabaseSync } from 'node:sqlite'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createTLSchema, DocumentRecordType, PageRecordType, TLDOCUMENT_ID } from '@tldraw/tlschema'
import type { TLPage } from '@tldraw/tlschema'
import { defaultShapeUtils, type Editor } from 'tldraw'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { NamedBoardStore, registerNamedBoardTools, type NamedBoardDocument } from './named-boards'

// Only replace the runtime base class; exercise MCP dispatch, validation and SQLite without sockets.
vi.mock('cloudflare:workers', () => ({
	DurableObject: class {
		constructor(
			public ctx: DurableObjectState,
			public env: unknown
		) {}
	},
}))

const frame = {
	id: 'shape:frame',
	typeName: 'shape',
	type: 'frame',
	parentId: 'page:first',
	x: 0,
	y: 0,
	rotation: 0,
	index: 'a1',
	isLocked: false,
	opacity: 1,
	meta: { retained: 'Exact 😀\n'.repeat(4000) },
	props: { w: 200, h: 100, name: 'Original', color: 'black' },
}
function document(): NamedBoardDocument {
	return {
		schema: { ...createTLSchema().serialize() },
		store: {
			'document:document': { ...DocumentRecordType.create({ id: TLDOCUMENT_ID, name: 'Test' }) },
			'page:first': {
				...PageRecordType.create({
					id: PageRecordType.createId('first'),
					name: 'Page',
					index: 'a1' as TLPage['index'],
				}),
			},
			[frame.id]: frame,
		},
	}
}

describe('saved board persistence through MCP and SQLite', () => {
	let db: DatabaseSync
	let state: DurableObjectState
	let store: NamedBoardStore
	let client: Client
	let server: McpServer

	beforeEach(async () => {
		db = new DatabaseSync(':memory:')
		state = {
			storage: {
				sql: {
					exec(query: string, ...params: (string | number | ArrayBuffer)[]) {
						const rows = db
							.prepare(query)
							.all(...params.map((p) => (p instanceof ArrayBuffer ? new Uint8Array(p) : p)))
						return {
							toArray: () => rows,
							one: () => {
								if (rows.length !== 1) throw new Error('Expected one row')
								return rows[0]
							},
						}
					},
				},
				transactionSync(fn: () => unknown) {
					db.exec('BEGIN')
					try {
						const result = fn()
						db.exec('COMMIT')
						return result
					} catch (error) {
						db.exec('ROLLBACK')
						throw error
					}
				},
			},
		} as unknown as DurableObjectState
		store = new NamedBoardStore(state, {})
		server = new McpServer({ name: 'test', version: '1.0' })
		registerNamedBoardTools(server, {
			idFromName: () => 'catalog',
			get: () => store,
		} as unknown as DurableObjectNamespace<NamedBoardStore>)
		client = new Client({ name: 'test-client', version: '1.0' })
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
		await server.connect(serverTransport)
		await client.connect(clientTransport)
		const saved = await store.fetch(
			new Request('http://localhost/boards/test', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ title: 'Test', baseRevision: 0, document: document() }),
			})
		)
		expect(saved.status).toBe(200)
	})

	afterEach(async () => {
		await client?.close()
		await server?.close()
		db?.close()
	})

	async function call(name: string, args: Record<string, unknown>) {
		const result = await client.callTool({ name, arguments: { boardId: 'test', ...args } })
		return { result, data: result.structuredContent as Record<string, unknown> }
	}
	async function saved() {
		const response = await store.fetch(new Request('http://localhost/boards/test'))
		return (await response.json()) as {
			title: string
			revision: number
			document: NamedBoardDocument
		}
	}

	test('advertises tools, commits once, preserves omitted data and survives object recreation', async () => {
		const { tools } = await client.listTools()
		expect(tools.find((t) => t.name === 'edit_board')?.annotations).toMatchObject({
			readOnlyHint: false,
			destructiveHint: true,
		})
		expect(tools.find((t) => t.name === 'read_board_record')?.annotations).toMatchObject({
			readOnlyHint: true,
		})
		const edited = await call('edit_board', {
			expectedRevision: 1,
			title: 'Renamed',
			operations: [
				{ op: 'update', recordId: frame.id, changes: { x: 200, props: { color: 'red', w: 400 } } },
				{ op: 'create', record: { ...frame, id: 'shape:copy', index: 'a2' } },
			],
		})
		expect(edited.result.isError).not.toBe(true)
		expect(edited.data).toMatchObject({
			revision: 2,
			title: 'Renamed',
			operationCount: 2,
			recordCount: 4,
		})
		store = new NamedBoardStore(state, {})
		const board = await saved()
		expect(board).toMatchObject({ revision: 2, title: 'Renamed' })
		expect(board.document.store[frame.id]).toEqual({
			...frame,
			x: 200,
			props: { ...frame.props, color: 'red', w: 400 },
		})
		expect(board.document.store['shape:copy']).toEqual({ ...frame, id: 'shape:copy', index: 'a2' })
	})

	test('rejects a whole batch and its title when a later operation is invalid', async () => {
		const before = await saved()
		const edited = await call('edit_board', {
			expectedRevision: 1,
			title: 'Discard',
			operations: [
				{ op: 'update', recordId: frame.id, changes: { x: 200 } },
				{ op: 'update', recordId: frame.id, changes: { opacity: 5 } },
			],
		})
		expect(edited.result.isError).toBe(true)
		expect(edited.data.code).toBe('invalid_record')
		expect(await saved()).toEqual(before)
	})

	test('admits one writer and rejects stale edits, reads and browser saves', async () => {
		const responses = await Promise.all(
			[100, 200].map((x) =>
				call('edit_board', {
					expectedRevision: 1,
					operations: [{ op: 'update', recordId: frame.id, changes: { x } }],
				})
			)
		)
		expect(responses.filter((r) => !r.result.isError)).toHaveLength(1)
		expect(responses.find((r) => r.result.isError)?.data).toMatchObject({
			code: 'revision_conflict',
			current: { revision: 2 },
		})
		expect((await call('read_board_record', { revision: 1, recordId: frame.id })).data.code).toBe(
			'revision_conflict'
		)
		const staleSave = await store.fetch(
			new Request('http://localhost/boards/test', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ title: 'Stale', baseRevision: 1, document: document() }),
			})
		)
		expect(staleSave.status).toBe(409)
		expect((await saved()).revision).toBe(2)
	})

	test('reads exact unicode JSON in bounded chunks and rejects nonexistent paths and records', async () => {
		let serialized = ''
		let offset: number | null = 0
		do {
			const read = await call('read_board_record', {
				revision: 1,
				recordId: frame.id,
				path: ['meta', 'retained'],
				offset,
				limit: 3001,
			})
			expect(read.result.isError).not.toBe(true)
			expect(new TextEncoder().encode(JSON.stringify(read.result)).length).toBeLessThanOrEqual(
				100 * 1024
			)
			serialized += read.data.json
			offset = read.data.nextOffset as number | null
		} while (offset !== null)
		expect(JSON.parse(serialized)).toBe(frame.meta.retained)
		for (const path of [['props', 'missing'], ['__proto__'], ['constructor']]) {
			expect(
				(await call('read_board_record', { revision: 1, recordId: frame.id, path })).data.code
			).toBe('path_not_found')
		}
		expect(
			(await call('read_board_record', { revision: 1, recordId: 'shape:missing' })).data.code
		).toBe('record_not_found')
	})

	test('supports title-only, replacement, deletion and the frame text shortcut', async () => {
		expect(
			(await call('edit_board', { expectedRevision: 1, title: 'Title only', operations: [] })).data
				.revision
		).toBe(2)
		const text = await call('set_board_shape_text', {
			expectedRevision: 2,
			shapeId: frame.id,
			text: 'Frame label',
		})
		expect(text.data).toMatchObject({ shapeId: frame.id, revision: 3 })
		const read = await call('read_board', {})
		expect(read.data.records).toEqual(
			expect.arrayContaining([expect.objectContaining({ text: 'Frame label' })])
		)
		expect(
			(
				await call('edit_board', {
					expectedRevision: 3,
					operations: [{ op: 'replace', record: { ...frame, meta: {} } }],
				})
			).data.revision
		).toBe(4)
		expect((await saved()).document.store[frame.id].meta).toEqual({})
		expect(
			(
				await call('edit_board', {
					expectedRevision: 4,
					operations: [{ op: 'delete', recordId: frame.id }],
				})
			).data.revision
		).toBe(5)
		expect((await saved()).document.store[frame.id]).toBeUndefined()
	})

	test.each(['geo', 'text', 'note', 'arrow', 'frame'])(
		'replaces plain text on %s shapes without losing other props',
		async (type) => {
			const util = defaultShapeUtils.find((util) => util.type === type)!
			const shape = {
				...frame,
				id: 'shape:label',
				type,
				props: new util({} as Editor).getDefaultProps(),
			}
			const created = await call('edit_board', {
				expectedRevision: 1,
				operations: [{ op: 'create', record: shape }],
			})
			expect(created.result.isError).not.toBe(true)
			const edited = await call('set_board_shape_text', {
				expectedRevision: 2,
				shapeId: shape.id,
				text: 'First\r\n\rLast\n',
			})
			expect(edited.result.isError).not.toBe(true)
			const props = (await saved()).document.store[shape.id].props
			expect(props).toEqual({
				...shape.props,
				...(type === 'frame'
					? { name: 'First\r\n\rLast\n' }
					: {
							richText: {
								type: 'doc',
								content: [
									{ type: 'paragraph', content: [{ type: 'text', text: 'First' }] },
									{ type: 'paragraph' },
									{ type: 'paragraph', content: [{ type: 'text', text: 'Last' }] },
									{ type: 'paragraph' },
								],
							},
						}),
			})
		}
	)

	test('rejects oversized documents, transient assets and invalid input without a save', async () => {
		const before = await saved()
		const oversized = await call('edit_board', {
			expectedRevision: 1,
			operations: [
				{
					op: 'update',
					recordId: frame.id,
					changes: { meta: { huge: 'x'.repeat(10 * 1024 * 1024) } },
				},
			],
		})
		expect(oversized.data.code).toBe('document_too_large')
		const transient = await call('edit_board', {
			expectedRevision: 1,
			operations: [
				{
					op: 'create',
					record: {
						id: 'asset:image',
						typeName: 'asset',
						type: 'image',
						meta: {},
						props: {
							w: 100,
							h: 100,
							name: 'Image',
							src: 'blob:http://localhost/temporary',
							mimeType: 'image/png',
							isAnimated: false,
						},
					},
				},
			],
		})
		expect(transient.result.isError).toBe(true)
		expect(transient.data.code).toBe('invalid_record')
		expect((await call('edit_board', { expectedRevision: 1, operations: [] })).data.code).toBe(
			'invalid_edit'
		)
		expect(
			(
				await call('edit_board', {
					expectedRevision: 0,
					operations: [{ op: 'delete', recordId: frame.id }],
				})
			).result.isError
		).toBe(true)
		expect(await saved()).toEqual(before)
	})
})
