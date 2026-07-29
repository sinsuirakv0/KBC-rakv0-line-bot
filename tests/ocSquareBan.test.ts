import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "@evex/linejs";
import {
	banSquareMember,
	isBannedMembershipState,
	kickAndBanSquareMember,
} from "../src/moderation/ocSquareBan.js";

function mockClient(returnedState: unknown) {
	let updateRequest: unknown;
	const calls: string[] = [];
	const client = {
		base: {
			square: {
				async getSquareMember({ squareMemberMid }: { squareMemberMid: string }) {
					calls.push("get");
					return {
						squareMember: {
							squareMemberMid,
							squareMid: "s-test",
							displayName: "target",
							membershipState: "JOINED",
							role: "MEMBER",
							revision: 42,
						},
					};
				},
				async deleteOtherFromSquare(squareMemberMid: string) {
					calls.push("kick");
					return {
						squareMember: {
							squareMemberMid,
							squareMid: "s-test",
							displayName: "target",
							membershipState: "KICK_OUT",
							role: "MEMBER",
							revision: 43,
						},
					};
				},
				async updateSquareMember(input: {
					request: {
						updatedAttrs: number[];
						updatedPreferenceAttrs: number[];
						squareMember: Record<string, unknown>;
					};
				}) {
					calls.push("ban");
					updateRequest = input;
					return {
						squareMember: {
							...input.request.squareMember,
							membershipState: returnedState,
						},
					};
				},
			},
		},
	} as unknown as Client;
	return {
		client,
		calls,
		getUpdateRequest: () => updateRequest as {
			request: {
				updatedAttrs: number[];
				updatedPreferenceAttrs: number[];
				squareMember: Record<string, unknown>;
			};
		},
	};
}

test("updates the Square membership state to BANNED", async () => {
	const mock = mockClient("BANNED");

	const response = await banSquareMember(mock.client, "p-target");
	const request = mock.getUpdateRequest().request;

	assert.deepEqual(request.updatedAttrs, [5]);
	assert.deepEqual(request.updatedPreferenceAttrs, []);
	assert.equal(request.squareMember.membershipState, "BANNED");
	assert.equal(request.squareMember.revision, 42);
	assert.equal(response.squareMember.membershipState, "BANNED");
});

test("accepts the numeric BANNED state returned by Thrift", () => {
	assert.equal(isBannedMembershipState(6), true);
	assert.equal(isBannedMembershipState("6"), true);
});

test("manual moderation kicks first and always follows with BANNED", async () => {
	const mock = mockClient("BANNED");

	await kickAndBanSquareMember(mock.client, "p-target");
	const request = mock.getUpdateRequest().request;

	assert.deepEqual(mock.calls, ["kick", "ban"]);
	assert.equal(request.squareMember.membershipState, "BANNED");
	assert.equal(request.squareMember.revision, 43);
});

test("does not report a KICK_OUT-only response as a successful ban", async () => {
	const mock = mockClient("KICK_OUT");

	await assert.rejects(
		() => banSquareMember(mock.client, "p-target"),
		/Square ban was not confirmed/,
	);
});

test("manual moderation reports failure when only the kick succeeded", async () => {
	const mock = mockClient("KICK_OUT");

	await assert.rejects(
		() => kickAndBanSquareMember(mock.client, "p-target"),
		/was kicked, but rejoin ban failed/,
	);
	assert.deepEqual(mock.calls, ["kick", "ban"]);
});
