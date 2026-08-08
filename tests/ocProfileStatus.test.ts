import assert from "node:assert/strict";
import test from "node:test";
import { OcProfileStatusManager } from "../src/runtime/ocProfileStatus.js";

const SQUARE_MID = "s00000000000000000000000000000000";
const MEMBER_MID = "p00000000000000000000000000000000";

test("OC profile status restores the base name and only applies restart or stop suffixes", async () => {
	const updates: string[] = [];
	const member = {
		squareMemberMid: MEMBER_MID,
		squareMid: SQUARE_MID,
		displayName: "超健康bot Munin (再起動中)",
		membershipState: "JOINED",
		revision: 1,
	};
	const client = {
		base: {
			square: {
				async getJoinedSquares() {
					return {
						members: { [SQUARE_MID]: { ...member } },
						continuationToken: "",
					};
				},
				async updateSquareMember(input: {
					request: { squareMember: typeof member };
				}) {
					const displayName = input.request.squareMember.displayName;
					updates.push(displayName);
					return {
						squareMember: {
							...input.request.squareMember,
							revision: input.request.squareMember.revision + 1,
						},
					};
				},
			},
		},
	};
	const values = new Map<string, unknown>();
	const storage = {
		async get(key: string) {
			return values.get(key);
		},
		async set(key: string, value: unknown) {
			values.set(key, value);
		},
	};
	const manager = new OcProfileStatusManager();
	await manager.bind(client as never, storage as never);
	assert.deepEqual(updates, ["超健康bot Munin"]);

	await manager.setGlobalStatus("stopped");
	assert.equal(updates.at(-1), "超健康bot Munin (停止中)");

	await manager.setGlobalStatus("restarting");
	assert.equal(updates.at(-1), "超健康bot Munin (停止中)");

	await manager.setGlobalStatus(undefined);
	assert.equal(updates.at(-1), "超健康bot Munin");
});
