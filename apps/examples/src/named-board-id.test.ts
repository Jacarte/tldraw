import { mockUniqueId, restoreUniqueId } from 'tldraw'
import { createNamedBoardId } from './named-board-id'

describe('createNamedBoardId', () => {
	const randomUUID = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID')

	afterEach(() => {
		restoreUniqueId()
		if (randomUUID) {
			Object.defineProperty(globalThis.crypto, 'randomUUID', randomUUID)
		} else {
			Reflect.deleteProperty(globalThis.crypto, 'randomUUID')
		}
	})

	it('creates distinct valid IDs when randomUUID is unavailable on an HTTP origin', () => {
		Object.defineProperty(globalThis.crypto, 'randomUUID', {
			value: undefined,
			configurable: true,
		})
		expect(globalThis.crypto.randomUUID).toBeUndefined()

		const first = createNamedBoardId()
		const second = createNamedBoardId()
		expect(first).toMatch(/^board_[A-Za-z0-9_-]{21}$/)
		expect(second).toMatch(/^board_[A-Za-z0-9_-]{21}$/)
		expect(first).not.toBe(second)
	})

	it.each(['_leading-underscore', '-leading-dash'])(
		'accepts a generated ID beginning with punctuation: %s',
		(suffix) => {
			mockUniqueId(() => suffix)

			const id = createNamedBoardId()
			expect(id).toBe(`board_${suffix}`)
			expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/)
		}
	)
})
