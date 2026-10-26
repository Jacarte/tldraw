import { uniqueId } from 'tldraw'

export function createNamedBoardId() {
	// HTTP LAN origins lack randomUUID; the prefix also permits NanoIDs starting with _ or -.
	return `board_${uniqueId()}`
}
