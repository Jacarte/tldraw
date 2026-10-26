/** One writer at a time; an older tab must never adopt a newer revision and overwrite it. */
export class NamedBoardAutosave<T> {
	private generation = 0
	private savedGeneration = 0
	private timer: ReturnType<typeof setTimeout> | undefined
	private inFlight: Promise<void> | undefined
	private disposed = false
	private failure: Error | undefined

	constructor(
		public revision: number,
		private readonly read: () => T,
		private readonly write: (value: T, revision: number) => Promise<{ revision: number }>,
		private readonly notify: (
			state: 'saved' | 'unsaved' | 'saving' | 'error',
			error?: Error
		) => void,
		private readonly delay = 600
	) {}

	get dirty() {
		return this.generation !== this.savedGeneration
	}

	get error() {
		return this.failure
	}

	changed() {
		if (this.disposed) return
		this.generation++
		if (this.failure) return
		this.notify(this.inFlight ? 'saving' : 'unsaved')
		clearTimeout(this.timer)
		this.timer = setTimeout(() => void this.flush().catch(() => {}), this.delay)
	}

	async flush(): Promise<void> {
		clearTimeout(this.timer)
		if (this.disposed) throw new Error('This board has been closed.')
		if (this.failure) throw this.failure
		if (this.inFlight) {
			await this.inFlight
			if (this.dirty) return this.flush()
			return
		}
		if (!this.dirty) return
		this.inFlight = this.saveLoop()
		try {
			await this.inFlight
		} finally {
			this.inFlight = undefined
		}
	}

	async retry() {
		this.failure = undefined
		await this.flush()
	}

	private async saveLoop() {
		try {
			while (!this.disposed && this.dirty) {
				this.notify('saving')
				const generation = this.generation
				const result = await this.write(this.read(), this.revision)
				this.revision = result.revision
				this.savedGeneration = generation
			}
			if (!this.disposed) this.notify('saved')
		} catch (cause) {
			this.failure = cause instanceof Error ? cause : new Error(String(cause))
			if (!this.disposed) this.notify('error', this.failure)
			throw this.failure
		}
	}

	dispose() {
		this.disposed = true
		clearTimeout(this.timer)
	}
}
