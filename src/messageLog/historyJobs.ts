export interface ActiveHistoryJob {
	id: string;
	key: string;
	requester: string;
	startedAt: number;
	type: "manual" | "auto";
}

let activeJob: ActiveHistoryJob | undefined;

export function getActiveHistoryJob(): ActiveHistoryJob | undefined {
	return activeJob;
}

export function tryStartHistoryJob(job: ActiveHistoryJob): boolean {
	if (activeJob) return false;
	activeJob = job;
	return true;
}

export function finishHistoryJob(id: string): void {
	if (activeJob?.id === id) activeJob = undefined;
}
