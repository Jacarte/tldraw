import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useBlocker, useSearchParams } from 'react-router-dom'
import {
	createTLStore,
	inlineBase64AssetStore,
	parseTldrawJsonFile,
	Tldraw,
	type Editor,
	type TLEditorSnapshot,
} from 'tldraw'
import { NamedBoardAutosave } from './named-board-autosave'
import { createNamedBoardId } from './named-board-id'
import 'tldraw/tldraw.css'
import './named-boards.css'

type Document = TLEditorSnapshot['document']
interface BoardInfo {
	id: string
	title: string
	revision: number
	updatedAt: number
}
interface Board extends BoardInfo {
	document: Document
}
interface BoardList {
	boards: BoardInfo[]
	nextOffset: number | null
}
type Api = <T>(path: string, options?: RequestInit) => Promise<T>
interface ActiveBoard {
	dirty(): boolean
	flush(): Promise<void>
}
interface BoardWorkspaceProps {
	id: string
	api: Api
	onSaved(): void
	onActive(value: ActiveBoard | null): void
}
interface BoardEditorProps extends Omit<BoardWorkspaceProps, 'id'> {
	initial: Board
	onReload(): void
}

class BoardApiError extends Error {
	constructor(
		message: string,
		public status: number,
		public code?: string
	) {
		super(message)
	}
}

function download(title: string, document: Document) {
	const data = JSON.stringify({ format: 'local-tldraw-board-v1', title, document })
	const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }))
	const link = window.document.createElement('a')
	link.href = url
	link.download = `${title.replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 100) || 'board'}.tldraw-board.json`
	link.click()
	setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function emptyDocument(): Document {
	const store = createTLStore({ assets: inlineBase64AssetStore })
	// The public loader validates records and creates the initial document and page.
	store.loadStoreSnapshot(store.getStoreSnapshot())
	return store.getStoreSnapshot()
}

async function importDocument(file: File): Promise<{ title: string; document: Document }> {
	if (file.size > 10 * 1024 * 1024) throw new Error('This file exceeds the 10 MiB board limit.')
	const text = await file.text()
	const json = JSON.parse(text)
	const store = createTLStore({ assets: inlineBase64AssetStore })
	if (json.format === 'local-tldraw-board-v1' && json.document) {
		store.loadStoreSnapshot(json.document)
		return {
			title: String(json.title || file.name).slice(0, 128),
			document: store.getStoreSnapshot(),
		}
	}
	const parsed = parseTldrawJsonFile({ json: text, schema: store.schema })
	if (!parsed.ok) throw new Error(`Cannot import this tldraw file (${parsed.error.type}).`)
	return {
		title: file.name.replace(/\.tldr$/i, '').slice(0, 128),
		document: parsed.value.getStoreSnapshot(),
	}
}

export default function NamedBoards() {
	const [params, setParams] = useSearchParams()
	const boardId = params.get('board')
	const [boards, setBoards] = useState<BoardInfo[]>([])
	const [nextOffset, setNextOffset] = useState<number | null>(null)
	const [query, setQuery] = useState('')
	const [newTitle, setNewTitle] = useState('')
	const [refresh, setRefresh] = useState(0)
	const [busy, setBusy] = useState(false)
	const [listLoading, setListLoading] = useState(false)
	const [error, setError] = useState('')
	const [authOpen, setAuthOpen] = useState(false)
	const [tokenInput, setTokenInput] = useState('')
	const [navigationError, setNavigationError] = useState('')
	const token = useRef('') // Memory only: never bundled, put in a URL, or saved in browser storage.
	const active = useRef<ActiveBoard | null>(null)
	const fileInput = useRef<HTMLInputElement>(null)
	const listEpoch = useRef(0)
	const currentQuery = useRef(query)
	currentQuery.current = query
	const authWaiters = useRef<Array<{ resolve(token: string): void; reject(error: Error): void }>>(
		[]
	)

	const requestToken = useCallback(
		() =>
			new Promise<string>((resolve, reject) => {
				const first = authWaiters.current.length === 0
				authWaiters.current.push({ resolve, reject })
				if (first) {
					setTokenInput('')
					setAuthOpen(true)
				}
			}),
		[]
	)

	const api: Api = useMemo(
		() =>
			async <T,>(path: string, options?: RequestInit): Promise<T> => {
				for (let attempt = 0; attempt < 3; attempt++) {
					const sentToken = token.current
					const headers = new Headers(options?.headers)
					if (options?.body) headers.set('Content-Type', 'application/json')
					if (sentToken) headers.set('Authorization', `Bearer ${sentToken}`)
					const response = await fetch(`/api/local-boards${path}`, {
						...options,
						headers,
						cache: 'no-store',
					})
					if (response.status === 401 && attempt < 2) {
						if (token.current && token.current !== sentToken) continue
						token.current = await requestToken()
						continue
					}
					const result = await response
						.json()
						.catch(() => ({ error: `Server returned HTTP ${response.status}.` }))
					if (!response.ok) {
						const failure = result as { error?: string; code?: string }
						throw new BoardApiError(
							failure.error || `HTTP ${response.status}`,
							response.status,
							failure.code
						)
					}
					return result as T
				}
				throw new BoardApiError('The access token was not accepted.', 401)
			},
		[requestToken]
	)

	useEffect(() => {
		const waiters = authWaiters.current
		return () => {
			for (const waiter of waiters.splice(0)) waiter.reject(new Error('Board view closed.'))
		}
	}, [])

	useEffect(() => {
		let cancelled = false
		listEpoch.current++
		setListLoading(true)
		void api<BoardList>(`?query=${encodeURIComponent(query)}&limit=50`)
			.then((result) => {
				if (!cancelled) {
					setBoards(result.boards)
					setNextOffset(result.nextOffset)
					setError('')
				}
			})
			.catch((cause) => {
				if (!cancelled) setError(String(cause.message || cause))
			})
			.finally(() => {
				if (!cancelled) setListLoading(false)
			})
		return () => {
			cancelled = true
		}
	}, [api, query, refresh])

	const blocker = useBlocker(
		({ currentLocation, nextLocation }) =>
			Boolean(active.current?.dirty()) &&
			`${currentLocation.pathname}${currentLocation.search}` !==
				`${nextLocation.pathname}${nextLocation.search}`
	)
	useEffect(() => {
		if (blocker.state !== 'blocked') return
		let cancelled = false
		setNavigationError('')
		void (async () => {
			try {
				await active.current?.flush()
				if (!cancelled) blocker.proceed()
			} catch (cause) {
				if (!cancelled)
					setNavigationError(
						`Your changes could not be saved. Stay on this board to resolve the error: ${String((cause as Error).message || cause)}`
					)
			}
		})()
		return () => {
			cancelled = true
		}
	}, [blocker])

	useEffect(() => {
		const beforeUnload = (event: BeforeUnloadEvent) => {
			if (active.current?.dirty()) {
				event.preventDefault()
				// Older browsers need this legacy signal to warn before discarding unsaved edits.
				// eslint-disable-next-line @typescript-eslint/no-deprecated
				event.returnValue = ''
			}
		}
		window.addEventListener('beforeunload', beforeUnload)
		return () => window.removeEventListener('beforeunload', beforeUnload)
	}, [])

	const saved = useCallback(() => setRefresh((value) => value + 1), [])
	const setActive = useCallback((value: ActiveBoard | null) => {
		active.current = value
	}, [])

	async function create(title: string, document: Document) {
		if (!title.trim()) throw new Error('Give the board a name.')
		const id = createNamedBoardId()
		await api<BoardInfo>(`/${id}`, {
			method: 'POST',
			body: JSON.stringify({ title: title.trim(), document, baseRevision: 0 }),
		})
		setRefresh((value) => value + 1)
		setParams({ board: id })
		setNewTitle('')
	}

	async function loadMore() {
		if (nextOffset === null) return
		const epoch = listEpoch.current
		const requestedQuery = query
		setBusy(true)
		try {
			const result = await api<BoardList>(
				`?query=${encodeURIComponent(query)}&limit=50&offset=${nextOffset}`
			)
			if (epoch !== listEpoch.current || requestedQuery !== currentQuery.current) return
			setBoards((current) => [
				...current,
				...result.boards.filter((b) => !current.some((c) => c.id === b.id)),
			])
			setNextOffset(result.nextOffset)
		} catch (cause) {
			setError(String((cause as Error).message || cause))
		} finally {
			setBusy(false)
		}
	}

	return (
		<div className="named-boards">
			<aside className="named-boards-sidebar">
				<h1>My boards</h1>
				<form
					onSubmit={(event) => {
						event.preventDefault()
						setBusy(true)
						setError('')
						void create(newTitle, emptyDocument())
							.catch((cause) => setError(cause.message))
							.finally(() => setBusy(false))
					}}
				>
					<label htmlFor="new-board-title">New board</label>
					<input
						id="new-board-title"
						placeholder="Board name"
						value={newTitle}
						maxLength={128}
						required
						onChange={(event) => setNewTitle(event.target.value)}
					/>
					<button type="submit" disabled={busy || !newTitle.trim()}>
						Create board
					</button>
				</form>
				<button disabled={busy} onClick={() => fileInput.current?.click()}>
					Import board file…
				</button>
				<input
					ref={fileInput}
					type="file"
					hidden
					accept=".tldr,.json"
					onChange={(event) => {
						const file = event.target.files?.[0]
						event.target.value = ''
						if (!file) return
						setBusy(true)
						setError('')
						void importDocument(file)
							.then(({ title, document }) => create(title, document))
							.catch((cause) => setError(cause.message))
							.finally(() => setBusy(false))
					}}
				/>
				<label htmlFor="board-search">Find a board</label>
				<input
					id="board-search"
					type="search"
					placeholder="Search names"
					maxLength={200}
					value={query}
					onChange={(event) => setQuery(event.target.value)}
				/>
				{error && (
					<div role="alert" className="named-boards-error">
						{error}
						<button onClick={() => saved()}>Retry</button>
					</div>
				)}
				<nav aria-label="Saved boards">
					{boards.map((board) => (
						<button
							key={board.id}
							aria-current={board.id === boardId ? 'page' : undefined}
							onClick={() => setParams({ board: board.id })}
						>
							<strong>{board.title}</strong>
							<small>{new Date(board.updatedAt).toLocaleString()}</small>
						</button>
					))}
					{!boards.length && !listLoading && <p>No saved boards found.</p>}
					{listLoading && <p>Loading boards…</p>}
					{nextOffset !== null && (
						<button disabled={busy} onClick={() => void loadMore()}>
							Load more
						</button>
					)}
				</nav>
				<p className="named-boards-help">
					Wait for “Saved” before closing a board. Your agent can find saved boards by name.
				</p>
			</aside>
			<main>
				{boardId ? (
					<BoardWorkspace
						key={boardId}
						id={boardId}
						api={api}
						onSaved={saved}
						onActive={setActive}
					/>
				) : (
					<div className="named-boards-empty">
						<h2>Your boards, ready when you need them</h2>
						<p>
							Create a board or open one from the list. Draw normally, then ask your agent to read
							it by name.
						</p>
					</div>
				)}
			</main>
			{blocker.state === 'blocked' && navigationError && (
				<div
					className="named-boards-modal"
					role="dialog"
					aria-modal="true"
					aria-label="Unsaved changes"
				>
					<div>
						<h2>Unsaved changes</h2>
						<p>{navigationError}</p>
						<button
							onClick={() => {
								blocker.reset()
								setNavigationError('')
							}}
						>
							Stay on this board
						</button>
					</div>
				</div>
			)}
			{authOpen && (
				<div
					className="named-boards-modal"
					role="dialog"
					aria-modal="true"
					aria-label="Server access token"
				>
					<form
						onSubmit={(event) => {
							event.preventDefault()
							const value = tokenInput.trim()
							if (!value) return
							token.current = value
							setAuthOpen(false)
							setTokenInput('')
							for (const waiter of authWaiters.current.splice(0)) waiter.resolve(value)
						}}
					>
						<h2>Server access token</h2>
						<p>
							Your local board service requires an access token. It is kept only for this open page.
						</p>
						<label htmlFor="board-token">Access token</label>
						<input
							id="board-token"
							type="password"
							autoFocus
							autoComplete="off"
							value={tokenInput}
							onChange={(event) => setTokenInput(event.target.value)}
							required
						/>
						<button type="submit">Connect</button>
						<button
							type="button"
							onClick={() => {
								setAuthOpen(false)
								setTokenInput('')
								for (const waiter of authWaiters.current.splice(0))
									waiter.reject(new BoardApiError('An access token is required.', 401))
							}}
						>
							Cancel
						</button>
					</form>
				</div>
			)}
		</div>
	)
}

function BoardWorkspace({ id, api, onSaved, onActive }: BoardWorkspaceProps) {
	const [board, setBoard] = useState<Board | null>(null)
	const [error, setError] = useState('')
	const [reload, setReload] = useState(0)
	useEffect(() => {
		let cancelled = false
		setBoard(null)
		setError('')
		void api<Board>(`/${encodeURIComponent(id)}`)
			.then((value) => {
				if (!cancelled) setBoard(value)
			})
			.catch((cause) => {
				if (!cancelled) setError(cause.message)
			})
		return () => {
			cancelled = true
		}
	}, [id, api, reload])
	if (error)
		return (
			<div className="named-boards-empty" role="alert">
				<p>{error}</p>
				<button onClick={() => setReload((value) => value + 1)}>Retry</button>
			</div>
		)
	if (!board) return <div className="named-boards-empty">Loading board…</div>
	return (
		<BoardEditor
			key={`${id}:${reload}`}
			initial={board}
			api={api}
			onSaved={onSaved}
			onActive={onActive}
			onReload={() => setReload((value) => value + 1)}
		/>
	)
}

function BoardEditor({ initial, api, onSaved, onActive, onReload }: BoardEditorProps) {
	const snapshot = initial.document
	const [title, setTitle] = useState(initial.title)
	const [status, setStatus] = useState<'saved' | 'unsaved' | 'saving' | 'error'>('saved')
	const [error, setError] = useState<Error | undefined>()
	const [savedAt, setSavedAt] = useState(initial.updatedAt)
	const titleRef = useRef(initial.title)
	const editorRef = useRef<Editor | null>(null)
	const autosave = useRef<NamedBoardAutosave<{ title: string; document: Document }> | null>(null)
	const conflict = error instanceof BoardApiError && error.status === 409

	const mount = useCallback(
		(editor: Editor) => {
			editorRef.current = editor
			const saver = new NamedBoardAutosave(
				initial.revision,
				() => ({ title: titleRef.current.trim(), document: editor.store.getStoreSnapshot() }),
				async (value, baseRevision) => {
					if (!value.title) throw new Error('The board needs a name before it can be saved.')
					const result = await api<BoardInfo>(`/${encodeURIComponent(initial.id)}`, {
						method: 'POST',
						body: JSON.stringify({ ...value, baseRevision }),
					})
					setSavedAt(result.updatedAt)
					onSaved()
					return result
				},
				(next, cause) => {
					setStatus(next)
					setError(cause)
				}
			)
			autosave.current = saver
			onActive({ dirty: () => saver.dirty, flush: () => saver.flush() })
			// Store.listen batches to the next animation frame. Synchronous document hooks
			// mark the last keystroke dirty even if navigation happens before that frame.
			const stopListening = (['asset', 'binding', 'document', 'page', 'shape'] as const).flatMap(
				(type) => [
					editor.store.sideEffects.registerAfterCreateHandler(type, () => saver.changed()),
					editor.store.sideEffects.registerAfterChangeHandler(type, () => saver.changed()),
					editor.store.sideEffects.registerAfterDeleteHandler(type, () => saver.changed()),
				]
			)
			// Also observe bulk snapshot loads that intentionally disable side effects.
			stopListening.push(
				editor.store.listen(() => saver.changed(), { scope: 'document', source: 'all' })
			)
			return () => {
				for (const stop of stopListening) stop()
				saver.dispose()
				onActive(null)
				if (autosave.current === saver) autosave.current = null
				if (editorRef.current === editor) editorRef.current = null
			}
		},
		[initial, api, onSaved, onActive]
	)

	function downloadCurrent() {
		const editor = editorRef.current
		if (editor) download(titleRef.current.trim() || initial.title, editor.store.getStoreSnapshot())
	}

	return (
		<div className="named-boards-workspace">
			<header className="named-boards-toolbar">
				<input
					aria-label="Board title"
					value={title}
					maxLength={128}
					onChange={(event) => {
						titleRef.current = event.target.value
						setTitle(event.target.value)
						autosave.current?.changed()
					}}
				/>
				<span role="status" title={`Last saved ${new Date(savedAt).toLocaleString()}`}>
					{status === 'saved'
						? 'Saved'
						: status === 'saving'
							? 'Saving…'
							: status === 'unsaved'
								? 'Unsaved changes'
								: 'Not saved'}
				</span>
				<button onClick={downloadCurrent}>Download copy</button>
			</header>
			{error && (
				<div role="alert" className="named-boards-error">
					{conflict
						? 'Another tab saved a newer version. Your edits are still here. Download a copy before reloading the saved version.'
						: error.message}
					{!conflict && (
						<button onClick={() => void autosave.current?.retry().catch(() => {})}>
							Retry save
						</button>
					)}
					<button onClick={downloadCurrent}>Download unsaved copy</button>
					<button
						onClick={() => {
							if (
								window.confirm(
									'Reload the saved board and discard the unsaved changes in this tab? Download a copy first if you need to keep them.'
								)
							)
								onReload()
						}}
					>
						Reload saved version
					</button>
				</div>
			)}
			<div className="named-boards-editor">
				<Tldraw snapshot={snapshot} assets={inlineBase64AssetStore} onMount={mount} />
			</div>
		</div>
	)
}
