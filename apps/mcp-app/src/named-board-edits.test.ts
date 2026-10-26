import {
	createTLSchema,
	DocumentRecordType,
	PageRecordType,
	TLDOCUMENT_ID,
	type TLShape,
} from '@tldraw/tlschema'
import type { TLPage } from '@tldraw/tlschema'
import { defaultShapeUtils, type Editor } from 'tldraw'
import { describe, expect, test } from 'vitest'
import { applyBoardEdits, type BoardEditOperation } from './named-board-edits'
import type { NamedBoardDocument } from './named-boards'

const schema = createTLSchema()
function document(...records: NamedBoardDocument['store'][string][]): NamedBoardDocument {
	return {
		schema: { ...schema.serialize() },
		store: Object.fromEntries(
			[
				DocumentRecordType.create({ id: TLDOCUMENT_ID, name: 'Test' }),
				PageRecordType.create({
					id: PageRecordType.createId('first'),
					name: 'Page',
					index: 'a1' as TLPage['index'],
				}),
				...records,
			].map((r) => [r.id, { ...r }])
		),
	}
}
function shape(type: TLShape['type'] = 'frame', id = `shape:${type}`, props = {}) {
	const util = defaultShapeUtils.find((util) => util.type === type)
	return {
		id,
		typeName: 'shape' as const,
		type,
		x: 0,
		y: 0,
		rotation: 0,
		index: 'a1',
		parentId: 'page:first',
		isLocked: false,
		opacity: 1,
		meta: {},
		props: { ...(util ? new util({} as Editor).getDefaultProps() : {}), ...props },
	}
}
function update(recordId: string, changes: Record<string, unknown>): BoardEditOperation {
	return { op: 'update', recordId, changes }
}
const binding = {
	id: 'binding:arrow',
	typeName: 'binding' as const,
	type: 'arrow',
	fromId: 'shape:arrow',
	toId: 'shape:frame',
	meta: {},
	props: {
		terminal: 'end',
		normalizedAnchor: { x: 0.5, y: 0.5 },
		isExact: false,
		isPrecise: true,
		snap: 'none',
	},
}
const asset = {
	id: 'asset:image',
	typeName: 'asset' as const,
	type: 'image',
	meta: {},
	props: {
		w: 100,
		h: 100,
		name: 'image',
		isAnimated: false,
		mimeType: 'image/png',
		src: 'data:image/png;base64,YQ==',
	},
}

describe('saved board record edits', () => {
	test.each([...defaultShapeUtils.map((util) => util.type), 'group' as const])(
		'creates, edits and deletes %s shapes',
		(type) => {
			const original = document()
			const newShape = shape(type)
			const created = applyBoardEdits(original, [{ op: 'create', record: newShape }])
			expect(created.store[newShape.id]).toEqual(newShape)
			const edited = applyBoardEdits(created, [
				update(newShape.id, {
					x: 100,
					y: -50,
					rotation: 0.4,
					opacity: 0.5,
					isLocked: true,
					index: 'a2',
					meta: { label: 'edited' },
				}),
			])
			expect(edited.store[newShape.id]).toEqual({
				...newShape,
				x: 100,
				y: -50,
				rotation: 0.4,
				opacity: 0.5,
				isLocked: true,
				index: 'a2',
				meta: { label: 'edited' },
			})
			expect(applyBoardEdits(edited, [{ op: 'delete', recordId: newShape.id }])).toEqual(original)
			expect(original.store[newShape.id]).toBeUndefined()
		}
	)

	test('merges props/meta, replaces nested arrays and objects, and removes fields with replace', () => {
		const geo = shape('geo')
		geo.meta = { retained: true, removed: true }
		const original = document(geo)
		const richText = {
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'bold', marks: [{ type: 'bold' }] }] },
			],
		}
		const edited = applyBoardEdits(original, [
			update(geo.id, { props: { richText, color: 'red', w: 300 }, meta: { label: 'new' } }),
		])
		expect(edited.store[geo.id].props).toEqual({ ...geo.props, richText, color: 'red', w: 300 })
		expect(edited.store[geo.id].meta).toEqual({ retained: true, removed: true, label: 'new' })
		const replacement = { ...geo, meta: { retained: true } }
		expect(applyBoardEdits(edited, [{ op: 'replace', record: replacement }]).store[geo.id]).toEqual(
			replacement
		)
		expect(original.store[geo.id]).toEqual(geo)
	})

	test('groups, ungroups, changes layers, moves across pages and edits document settings', () => {
		const geo = shape('geo')
		const group = shape('group')
		const second = PageRecordType.create({
			id: PageRecordType.createId('second'),
			name: 'Second',
			index: 'a2' as TLPage['index'],
		})
		const grouped = applyBoardEdits(document(geo), [
			update(geo.id, { parentId: group.id, x: 25, y: 30, index: 'a3' }),
			{ op: 'create', record: group },
			{ op: 'create', record: { ...second } },
			update(group.id, { parentId: second.id, rotation: 0.7 }),
			update('document:document', { name: 'Updated', gridSize: 40 }),
		])
		expect(grouped.store[geo.id]).toMatchObject({ parentId: group.id, x: 25, y: 30, index: 'a3' })
		const ungrouped = applyBoardEdits(grouped, [
			{ op: 'delete', recordId: group.id },
			update(geo.id, { parentId: 'page:first', x: 50, y: 60 }),
			{ op: 'delete', recordId: second.id },
		])
		expect(ungrouped.store[group.id]).toBeUndefined()
		expect(ungrouped.store[geo.id].parentId).toBe('page:first')
		expect(ungrouped.store['document:document']).toMatchObject({ name: 'Updated', gridSize: 40 })
	})

	test('creates, retargets and removes bindings in atomic batches', () => {
		const original = document(shape('arrow'), shape('frame'), shape('geo'))
		const connected = applyBoardEdits(original, [{ op: 'create', record: binding }])
		const retargeted = applyBoardEdits(connected, [
			update(binding.id, { toId: 'shape:geo', props: { normalizedAnchor: { x: 1, y: 0 } } }),
		])
		expect(retargeted.store[binding.id]).toMatchObject({
			toId: 'shape:geo',
			props: { ...binding.props, normalizedAnchor: { x: 1, y: 0 } },
		})
		expect(() => applyBoardEdits(retargeted, [{ op: 'delete', recordId: 'shape:geo' }])).toThrow(
			'existing, distinct shapes'
		)
		const deleted = applyBoardEdits(retargeted, [
			{ op: 'delete', recordId: 'shape:geo' },
			{ op: 'delete', recordId: binding.id },
		])
		expect(deleted.store[binding.id]).toBeUndefined()
	})

	test('edits image assets and crop without losing embedded bytes', () => {
		const image = shape('image', 'shape:image', { assetId: asset.id })
		const original = document(image, asset)
		const crop = { topLeft: { x: 0.2, y: 0.1 }, bottomRight: { x: 0.8, y: 0.9 } }
		const edited = applyBoardEdits(original, [
			update(image.id, { props: { crop, flipX: true } }),
			update(asset.id, { props: { name: 'New name' } }),
		])
		expect(edited.store[asset.id].props).toEqual({ ...asset.props, name: 'New name' })
		expect(edited.store[image.id].props).toEqual({ ...image.props, crop, flipX: true })
		expect(() => applyBoardEdits(original, [{ op: 'delete', recordId: asset.id }])).toThrow(
			'existing image asset'
		)
		const detached = applyBoardEdits(original, [
			update(image.id, { props: { assetId: null } }),
			{ op: 'delete', recordId: asset.id },
		])
		expect(detached.store[asset.id]).toBeUndefined()
	})

	test.each([
		[{ op: 'create', record: shape() }, 'already exists'],
		[{ op: 'delete', recordId: 'shape:missing' }, 'does not exist'],
		[update('shape:frame', { id: 'shape:other' }), 'Cannot change id'],
		[update('shape:frame', { type: 'group' }), 'Cannot change type'],
		[update('shape:frame', { typeName: 'asset' }), 'Cannot change typeName'],
		[update('shape:frame', { opacity: 3 }), 'shape:frame'],
		[update('shape:frame', { x: '100' }), 'shape:frame'],
		[update('shape:frame', { props: { w: -1 } }), 'shape:frame'],
		[update('shape:frame', { props: { color: 'not-a-color' } }), 'shape:frame'],
		[update('shape:frame', { props: null }), 'props must be an object'],
		[update('shape:frame', { parentId: 'shape:frame' }), 'Parent cycle'],
		[{ op: 'delete', recordId: 'page:first' }, 'at least one page'],
		[{ op: 'delete', recordId: 'document:document' }, 'cannot be deleted'],
	] satisfies [BoardEditOperation, string][])(
		'rejects invalid operations without mutating the input: %j',
		(operation, error) => {
			const original = document(shape())
			const before = structuredClone(original)
			expect(() =>
				applyBoardEdits(original, [update('shape:frame', { x: 99 }), operation])
			).toThrow(error)
			expect(original).toEqual(before)
		}
	)

	test('rejects cyclic hierarchy, cross-page bindings, duplicate terminals and invalid parents', () => {
		const original = document(shape('frame'), shape('arrow'), shape('group'))
		expect(() =>
			applyBoardEdits(original, [
				update('shape:frame', { parentId: 'shape:group' }),
				update('shape:group', { parentId: 'shape:frame' }),
			])
		).toThrow('Parent cycle')
		expect(() =>
			applyBoardEdits(original, [update('shape:frame', { parentId: 'shape:arrow' })])
		).toThrow('page, group or frame')
		const second = PageRecordType.create({
			id: PageRecordType.createId('second'),
			name: 'Second',
			index: 'a2' as TLPage['index'],
		})
		expect(() =>
			applyBoardEdits(original, [
				{ op: 'create', record: { ...second } },
				update('shape:frame', { parentId: second.id }),
				{ op: 'create', record: binding },
			])
		).toThrow('different pages')
		expect(() =>
			applyBoardEdits(original, [
				{ op: 'create', record: binding },
				{ op: 'create', record: { ...binding, id: 'binding:duplicate' } },
			])
		).toThrow('multiple bindings')
	})

	test('does not allow prototype IDs or changing type by deleting and recreating an ID', () => {
		const original = document(shape())
		expect(() =>
			applyBoardEdits(original, [{ op: 'create', record: { ...shape(), id: '__proto__' } }])
		).toThrow()
		expect(() =>
			applyBoardEdits(original, [
				{ op: 'delete', recordId: 'shape:frame' },
				{ op: 'create', record: { ...shape('group'), id: 'shape:frame' } },
			])
		).toThrow('Cannot change record type')
	})

	test('rejects prototype keys, session records and unsupported schemas', () => {
		const original = document(shape())
		for (const key of ['__proto__', 'constructor', 'prototype']) {
			expect(() =>
				applyBoardEdits(original, [
					update('shape:frame', JSON.parse(`{"meta":{"${key}":{"polluted":true}}}`)),
				])
			).toThrow('Prototype')
		}
		expect(() =>
			applyBoardEdits(original, [
				{
					op: 'create',
					record: { id: 'camera:one', typeName: 'camera' },
				} as unknown as BoardEditOperation,
			])
		).toThrow()
		expect(() =>
			applyBoardEdits({ ...original, schema: { schemaVersion: 2, sequences: {} } }, [])
		).toThrow('matching browser')
		expect(() =>
			applyBoardEdits(
				{
					...original,
					schema: { schemaVersion: 2, sequences: { ...schema.serialize().sequences, custom: 1 } },
				},
				[]
			)
		).toThrow('matching browser')
	})
})
