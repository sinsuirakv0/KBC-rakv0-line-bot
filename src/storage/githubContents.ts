import { appConfig } from "../config.js";

interface GithubFileResponse {
	content?: string;
	encoding?: string;
	sha?: string;
}

export interface GithubTextFile {
	content: string;
	sha?: string;
}

export class GithubContentsClient {
	get enabled(): boolean {
		return Boolean(
			appConfig.pushSubscriptionsGithubRepo && appConfig.pushSubscriptionsGithubToken,
		);
	}

	async read(filePath: string): Promise<GithubTextFile | null> {
		const file = await this.getFile(filePath);
		if (!file) return null;
		if (file.encoding !== "base64" || !file.content) {
			throw new Error("GitHub file content is not available as base64");
		}
		return {
			content: Buffer.from(file.content.replace(/\s/g, ""), "base64").toString("utf8"),
			sha: file.sha,
		};
	}

	async readSha(filePath: string): Promise<string | undefined> {
		const file = await this.getFile(filePath);
		return file?.sha;
	}

	private async getFile(filePath: string): Promise<GithubFileResponse | null> {
		const url = new URL(this.url(filePath));
		url.searchParams.set("ref", appConfig.pushSubscriptionsGithubBranch);
		const response = await fetch(url, {
			headers: this.headers(),
			signal: AbortSignal.timeout(appConfig.githubContentsTimeoutMs),
		});
		if (response.status === 404) return null;
		if (!response.ok) throw new Error(`GitHub read failed: HTTP ${response.status}`);
		const file = await response.json() as GithubFileResponse;
		return file;
	}

	async write(
		filePath: string,
		content: string,
		message: string,
		sha?: string,
	): Promise<string | undefined> {
		let nextSha = sha;
		let lastStatus = 0;
		let lastDetail = "";
		for (let attempt = 1; attempt <= 5; attempt++) {
			const response = await this.put(filePath, content, message, nextSha);
			if (response.ok) {
				const result = await response.json() as { content?: { sha?: string } };
				return result.content?.sha;
			}
			lastStatus = response.status;
			lastDetail = await response.text();
			if (response.status !== 409 && response.status !== 422) break;
			const latestSha = await this.readSha(filePath).catch(() => undefined);
			if (!latestSha) break;
			nextSha = latestSha;
			console.warn(`[github] retrying ${filePath} with latest sha after HTTP ${response.status} (attempt ${attempt})`);
			await this.sleep(250 * attempt);
		}
		throw new Error(`GitHub write failed: HTTP ${lastStatus} ${lastDetail.slice(0, 1000)}`);
	}

	private async put(
		filePath: string,
		content: string,
		message: string,
		sha?: string,
	): Promise<Response> {
		return await fetch(this.url(filePath), {
			method: "PUT",
			headers: { ...this.headers(), "Content-Type": "application/json" },
			signal: AbortSignal.timeout(appConfig.githubContentsTimeoutMs),
			body: JSON.stringify({
				message,
				content: Buffer.from(content, "utf8").toString("base64"),
				branch: appConfig.pushSubscriptionsGithubBranch,
				...(sha ? { sha } : {}),
			}),
		});
	}

	async delete(filePath: string, message: string, sha: string): Promise<void> {
		const response = await fetch(this.url(filePath), {
			method: "DELETE",
			headers: { ...this.headers(), "Content-Type": "application/json" },
			signal: AbortSignal.timeout(appConfig.githubContentsTimeoutMs),
			body: JSON.stringify({
				message,
				sha,
				branch: appConfig.pushSubscriptionsGithubBranch,
			}),
		});
		if (!response.ok) {
			const detail = await response.text();
			throw new Error(`GitHub delete failed: HTTP ${response.status} ${detail.slice(0, 300)}`);
		}
	}

	private url(filePath: string): string {
		const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
		return `https://api.github.com/repos/${appConfig.pushSubscriptionsGithubRepo}/contents/${encodedPath}`;
	}

	private headers(): Record<string, string> {
		return {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${appConfig.pushSubscriptionsGithubToken}`,
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "KBC-rakv0-line-bot",
		};
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}

export const githubContentsClient = new GithubContentsClient();
