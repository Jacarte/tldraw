import { NamedBoardAutosave } from './named-board-autosave'

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

describe('NamedBoardAutosave', () => {
	const savers: Array<{ dispose(): void }> = []

	beforeEach(() => vi.useFakeTimers())
	afterEach(() => {
		for (const saver of savers.splice(0)) saver.dispose()
		vi.useRealTimers()
	})

	it('serializes slow writes and saves the latest edits made while a write is in flight', async () => {
		let document = 'first edit'
		let activeWrites = 0
		let maxActiveWrites = 0
		const requests: Array<{
			document: string
			revision: number
			result: ReturnType<typeof deferred<{ revision: number }>>
		}> = []
		const notify = vi.fn()
		const saver = new NamedBoardAutosave(
			4,
			() => document,
			async (value, revision) => {
				activeWrites++
				maxActiveWrites = Math.max(maxActiveWrites, activeWrites)
				const result = deferred<{ revision: number }>()
				requests.push({ document: value, revision, result })
				try {
					return await result.promise
				} finally {
					activeWrites--
				}
			},
			notify
		)
		savers.push(saver)

		saver.changed()
		await vi.advanceTimersByTimeAsync(600)
		expect(requests).toHaveLength(1)
		expect(requests[0]).toMatchObject({ document: 'first edit', revision: 4 })

		document = 'intermediate edit'
		saver.changed()
		document = 'latest edit'
		saver.changed()
		await vi.advanceTimersByTimeAsync(600)
		expect(requests).toHaveLength(1)
		expect(saver.dirty).toBe(true)

		// Navigation may call flush while a timer-triggered save is already pending.
		const navigationFlush = saver.flush()
		requests[0].result.resolve({ revision: 5 })
		await vi.advanceTimersByTimeAsync(0)
		expect(requests).toHaveLength(2)
		expect(requests[1]).toMatchObject({ document: 'latest edit', revision: 5 })
		expect(saver.dirty).toBe(true)
		expect(notify.mock.calls.some(([state]) => state === 'saved')).toBe(false)

		requests[1].result.resolve({ revision: 6 })
		await navigationFlush
		await vi.advanceTimersByTimeAsync(1200)
		expect(requests).toHaveLength(2)
		expect(maxActiveWrites).toBe(1)
		expect(saver.revision).toBe(6)
		expect(saver.dirty).toBe(false)
		expect(notify).toHaveBeenLastCalledWith('saved')
	})

	it('pauses after a failed write, then retries the latest document with the last confirmed revision', async () => {
		let document = 'first edit'
		const failure = new Error('Connection interrupted')
		const write = vi
			.fn<(value: string, revision: number) => Promise<{ revision: number }>>()
			.mockRejectedValueOnce(failure)
			.mockResolvedValueOnce({ revision: 8 })
		const notify = vi.fn()
		const saver = new NamedBoardAutosave(7, () => document, write, notify)
		savers.push(saver)

		saver.changed()
		await expect(saver.flush()).rejects.toBe(failure)
		expect(saver.revision).toBe(7)
		expect(saver.dirty).toBe(true)
		expect(saver.error).toBe(failure)
		expect(notify).toHaveBeenLastCalledWith('error', failure)

		document = 'edited while offline'
		saver.changed()
		await vi.advanceTimersByTimeAsync(6000)
		await expect(saver.flush()).rejects.toBe(failure)
		expect(write).toHaveBeenCalledTimes(1)

		await saver.retry()
		expect(write).toHaveBeenNthCalledWith(2, 'edited while offline', 7)
		expect(saver.revision).toBe(8)
		expect(saver.dirty).toBe(false)
		expect(saver.error).toBeUndefined()
		expect(notify).toHaveBeenLastCalledWith('saved')
	})

	it('never adopts the server revision from a conflict to overwrite a newer board', async () => {
		const conflict = Object.assign(new Error('Board changed in another tab'), {
			status: 409,
			current: { revision: 99 },
		})
		const write = vi
			.fn<(value: string, revision: number) => Promise<{ revision: number }>>()
			.mockRejectedValue(conflict)
		const saver = new NamedBoardAutosave(3, () => 'older tab edits', write, vi.fn())
		savers.push(saver)

		saver.changed()
		await expect(saver.flush()).rejects.toBe(conflict)
		await vi.advanceTimersByTimeAsync(6000)
		expect(write).toHaveBeenCalledTimes(1)
		await expect(saver.retry()).rejects.toBe(conflict)
		expect(write.mock.calls).toEqual([
			['older tab edits', 3],
			['older tab edits', 3],
		])
		expect(saver.revision).toBe(3)
		expect(saver.dirty).toBe(true)
		expect(saver.error).toBe(conflict)
	})

	it('flushes pending edits before navigation and resolves only after the save is acknowledged', async () => {
		const result = deferred<{ revision: number }>()
		const write = vi
			.fn<(value: string, revision: number) => Promise<{ revision: number }>>()
			.mockReturnValue(result.promise)
		const saver = new NamedBoardAutosave(1, () => 'unsaved document', write, vi.fn())
		savers.push(saver)

		saver.changed()
		let mayNavigate = false
		const navigationFlush = saver.flush().then(() => {
			mayNavigate = true
		})
		await vi.advanceTimersByTimeAsync(0)
		expect(write).toHaveBeenCalledExactlyOnceWith('unsaved document', 1)
		expect(mayNavigate).toBe(false)
		expect(saver.dirty).toBe(true)

		result.resolve({ revision: 2 })
		await navigationFlush
		expect(mayNavigate).toBe(true)
		expect(saver.dirty).toBe(false)
		// A clean board and the cancelled debounce must not produce another request.
		await saver.flush()
		await vi.advanceTimersByTimeAsync(1200)
		expect(write).toHaveBeenCalledTimes(1)
	})
})
