import type { Client } from "@evex/linejs";

const MEMBERSHIP_STATE_ATTRIBUTE = 5;
const BANNED_MEMBERSHIP_STATE = 6;

function validateSquareMemberMid(squareMemberMid: string): void {
	if (!squareMemberMid.startsWith("p")) {
		throw new Error("Invalid value: squareMemberMid");
	}
}

export function isBannedMembershipState(state: unknown): boolean {
	return state === "BANNED" || state === BANNED_MEMBERSHIP_STATE || state === String(BANNED_MEMBERSHIP_STATE);
}

export async function banSquareMember(client: Client, squareMemberMid: string) {
	validateSquareMemberMid(squareMemberMid);
	const current = await client.base.square.getSquareMember({ squareMemberMid });
	const response = await client.base.square.updateSquareMember({
		request: {
			updatedAttrs: [MEMBERSHIP_STATE_ATTRIBUTE],
			updatedPreferenceAttrs: [],
			squareMember: {
				...current.squareMember,
				membershipState: "BANNED",
			},
		},
	});

	if (!isBannedMembershipState(response.squareMember?.membershipState)) {
		throw new Error(
			`Square ban was not confirmed: membershipState=${String(response.squareMember?.membershipState)}`,
		);
	}
	return response;
}

export async function kickAndBanSquareMember(client: Client, squareMemberMid: string) {
	validateSquareMemberMid(squareMemberMid);
	const kicked = await client.base.square.deleteOtherFromSquare(squareMemberMid);
	try {
		const response = await client.base.square.updateSquareMember({
			request: {
				updatedAttrs: [MEMBERSHIP_STATE_ATTRIBUTE],
				updatedPreferenceAttrs: [],
				squareMember: {
					...kicked.squareMember,
					membershipState: "BANNED",
				},
			},
		});

		if (!isBannedMembershipState(response.squareMember?.membershipState)) {
			throw new Error(
				`membershipState=${String(response.squareMember?.membershipState)}`,
			);
		}
		return response;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Square member was kicked, but rejoin ban failed: ${detail}`,
		);
	}
}
