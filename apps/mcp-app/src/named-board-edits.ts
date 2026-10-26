import { createTLSchema } from '@tldraw/tlschema'
import { z } from 'zod'
import type { NamedBoardDocument } from './named-boards'

const schema = createTLSchema()
const recordId = z.string().min(1).max(512)
const record = z.looseObject({
	id: recordId,
	typeName: z.enum(['shape', 'binding', 'asset', 'page', 'document', 'user']),
})

export const boardEditOperations = z
	.array(
		z.discriminatedUnion('op', [
			z.strictObject({ op: z.literal('create'), record }),
			z.strictObject({
				op: z.literal('update'),
				recordId,
				changes: z.record(z.string(), z.unknown()),
			}),
			z.strictObject({ op: z.literal('replace'), record }),
			z.strictObject({ op: z.literal('delete'), recordId }),
		])
	)
	.max(500)

export type BoardEditOperation = z.infer<typeof boardEditOperations>[number]

export class BoardEditError extends Error {
	constructor(
		public code: string,
		message: string
	) {
		super(message)
	}
}

function fail(code: string, message: string): never {
	throw new BoardEditError(code, message)
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

function checkKeys(value: unknown, depth = 0): void {
	if (depth > 64) fail('invalid_edit', 'Record nesting must not exceed 64 levels.')
	if (!value || typeof value !== 'object') return
	for (const [key, child] of Object.entries(value)) {
		if (['__proto__', 'prototype', 'constructor'].includes(key)) {
			fail('invalid_edit', 'Prototype-related keys are not allowed in edits.')
		}
		checkKeys(child, depth + 1)
	}
}

function validateRecord(record: NamedBoardDocument['store'][string]) {
	const type = Object.hasOwn(schema.types, record.typeName)
		? schema.types[record.typeName as keyof typeof schema.types]
		: undefined
	if (!type || type.scope !== 'document') {
		fail(
			'unsupported_record',
			`Cannot edit record type ${record.typeName}. Only document records are supported.`
		)
	}
	try {
		type.validate(record)
	} catch (error) {
		fail(
			'invalid_record',
			`${record.id}: ${error instanceof Error ? error.message : 'Invalid tldraw record'}`.slice(
				0,
				2000
			)
		)
	}
}

function validateReferences(store: NamedBoardDocument['store']) {
	if (store['document:document']?.typeName !== 'document') {
		fail('invalid_document', 'The document record cannot be deleted.')
	}
	if (!Object.values(store).some((r) => r.typeName === 'page')) {
		fail('invalid_document', 'A board must contain at least one page.')
	}
	const pageByShape = new Map<string, string>()
	const pageFor = (id: string): string => {
		const chain = new Set<string>()
		let current = id
		while (!pageByShape.has(current)) {
			if (chain.has(current)) fail('invalid_reference', `Parent cycle involving ${current}.`)
			chain.add(current)
			const shape = store[current]
			const parent = store[String(shape?.parentId)]
			if (!parent || !['page', 'shape'].includes(parent.typeName)) {
				fail('invalid_reference', `${current} must have an existing page or shape parent.`)
			}
			if (parent.typeName === 'page') {
				for (const child of chain) pageByShape.set(child, parent.id)
				return parent.id
			}
			if (!['group', 'frame'].includes(String(parent.type))) {
				fail('invalid_reference', `${current} must be parented to a page, group or frame.`)
			}
			current = parent.id
		}
		const page = pageByShape.get(current)!
		for (const child of chain) pageByShape.set(child, page)
		return page
	}
	const terminals = new Set<string>()
	for (const r of Object.values(store)) {
		if (r.typeName === 'shape') {
			pageFor(r.id)
			const props = isObject(r.props) ? r.props : {}
			if (props.assetId !== undefined && props.assetId !== null) {
				const asset = store[String(props.assetId)]
				if (asset?.typeName !== 'asset' || asset.type !== r.type) {
					fail('invalid_reference', `${r.id} must reference an existing ${String(r.type)} asset.`)
				}
			}
		} else if (r.typeName === 'binding') {
			const from = store[String(r.fromId)]
			const to = store[String(r.toId)]
			if (from?.typeName !== 'shape' || to?.typeName !== 'shape' || from.id === to.id) {
				fail('invalid_reference', `${r.id} must connect two existing, distinct shapes.`)
			}
			if (pageFor(from.id) !== pageFor(to.id)) {
				fail('invalid_reference', `${r.id} cannot connect shapes on different pages.`)
			}
			if (r.type === 'arrow') {
				if (from.type !== 'arrow')
					fail('invalid_reference', `${r.id} must originate from an arrow.`)
				if (['arrow', 'group'].includes(String(to.type)))
					fail('invalid_reference', `${r.id} cannot target an arrow or group.`)
				const terminal = `${from.id}:${String((r.props as Record<string, unknown>).terminal)}`
				if (terminals.has(terminal)) fail('invalid_reference', `${terminal} has multiple bindings.`)
				terminals.add(terminal)
			}
		}
	}
}

/** Validate the final graph, so related records can be changed in any order within one batch. */
export function applyBoardEdits(
	document: NamedBoardDocument,
	operations: BoardEditOperation[]
): NamedBoardDocument {
	const parsed = boardEditOperations.safeParse(operations)
	if (!parsed.success) fail('invalid_edit', parsed.error.message.slice(0, 2000))
	checkKeys(operations)
	// Never reinterpret newer/custom schemas or silently migrate records behind the caller's read.
	const currentSchema = schema.serialize()
	const sequences = document.schema.sequences
	if (
		document.schema.schemaVersion !== currentSchema.schemaVersion ||
		!isObject(sequences) ||
		Object.entries(currentSchema.sequences).some(([id, version]) => sequences[id] !== version) ||
		Object.keys(sequences).some((id) => !Object.hasOwn(currentSchema.sequences, id))
	) {
		fail(
			'unsupported_schema',
			'Open and save this board in the matching browser app before editing. Custom or newer schemas are not supported by this worker.'
		)
	}
	// A record ID such as __proto__ must remain data until the schema rejects it.
	const store: NamedBoardDocument['store'] = Object.assign(Object.create(null), document.store)
	for (const operation of parsed.data) {
		const id = 'record' in operation ? operation.record.id : operation.recordId
		const existing = Object.hasOwn(store, id) ? store[id] : undefined
		if (operation.op === 'create') {
			if (existing) fail('record_exists', `${id} already exists. Use update or replace.`)
			store[id] = operation.record
			continue
		}
		if (!existing) fail('record_not_found', `${id} does not exist on this board.`)
		if (operation.op === 'delete') {
			delete store[id]
			continue
		}
		const changes = operation.op === 'replace' ? operation.record : operation.changes
		for (const key of ['id', 'typeName', 'type']) {
			if (Object.hasOwn(changes, key) && changes[key] !== existing[key]) {
				fail('invalid_edit', `Cannot change ${key} on ${id}; create a new record instead.`)
			}
		}
		if (operation.op === 'replace') {
			store[id] = operation.record
		} else {
			const updated = { ...existing, ...changes }
			for (const key of ['props', 'meta']) {
				if (Object.hasOwn(changes, key)) {
					if (!isObject(changes[key])) fail('invalid_edit', `${key} must be an object.`)
					updated[key] = { ...(isObject(existing[key]) ? existing[key] : {}), ...changes[key] }
				}
			}
			store[id] = updated
		}
	}
	for (const record of Object.values(store)) {
		const original = Object.hasOwn(document.store, record.id)
			? document.store[record.id]
			: undefined
		if (original && (original.typeName !== record.typeName || original.type !== record.type)) {
			fail('invalid_edit', `Cannot change record type on ${record.id}; use a new ID.`)
		}
		validateRecord(record)
	}
	validateReferences(store)
	return { ...document, store }
}
