function normalizedState(value: unknown): { numeric?: number; name: string } {
	const numeric = typeof value === "bigint" ? Number(value) : Number(value);
	return {
		numeric: Number.isFinite(numeric) ? numeric : undefined,
		name: String(value ?? "").trim().toUpperCase(),
	};
}

export function isSquareMembershipJoined(value: unknown): boolean {
	const state = normalizedState(value);
	return state.numeric === 2 || state.name === "JOINED";
}

export function isSquareMembershipLeft(value: unknown): boolean {
	const state = normalizedState(value);
	return state.numeric === 4 || state.name === "LEFT";
}

export function isSquareChatMembershipJoined(value: unknown): boolean {
	const state = normalizedState(value);
	return state.numeric === 1 || state.name === "JOINED";
}

export function isSquareChatMembershipLeft(value: unknown): boolean {
	const state = normalizedState(value);
	return state.numeric === 2 || state.name === "LEFT";
}
