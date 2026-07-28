import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { chromium, type Browser, type Page } from "playwright-core";
import { createBackgroundToolManager } from "./background-tool.ts";
import { startPublicProxy, type PublicProxy } from "./public-proxy.ts";

const NAVIGATION_TIMEOUT_MS = 20_000;
const RENDER_WAIT_MS = 2_000;
const MAX_LINKS = 100;
const MAX_TEXT_CHARS = 200_000;
const MIN_READABLE_CHARS = 120;

const browserFetchParameters = Type.Object({
	url: Type.String({
		description: "Absolute HTTP or HTTPS URL to fetch",
	}),
});

interface ExtractedPage {
	finalUrl: string;
	title: string;
	text: string;
	links: Array<{ text: string; url: string }>;
}

interface BrowserFetchDetails {
	url: string;
	finalUrl: string;
	title: string;
	status: number | null;
	blockedReason?: string;
	fullOutputPath?: string;
}

function resolveBrowserExecutable(): string {
	const programFiles = process.env.ProgramFiles;
	const programFilesX86 = process.env["ProgramFiles(x86)"];
	const localAppData = process.env.LOCALAPPDATA;
	const candidates = [
		process.env.BROWSER_FETCH_CHROMIUM_PATH,
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/usr/bin/google-chrome",
		programFiles && join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
		programFilesX86 && join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
		localAppData && join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
		programFiles && join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
		programFilesX86 && join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
	].filter((candidate): candidate is string => Boolean(candidate));

	const executable = candidates.find(existsSync);
	if (!executable) {
		throw new Error(
			"No Chromium-based browser found. Set BROWSER_FETCH_CHROMIUM_PATH to its executable.",
		);
	}

	return executable;
}

function parseUrl(rawUrl: string): URL {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new Error(`Invalid URL: ${rawUrl}`);
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`Unsupported URL protocol: ${url.protocol}`);
	}

	return url;
}

function normalizeText(value: unknown): string {
	return String(value ?? "")
		.replace(/\u00a0/g, " ")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{4,}/g, "\n\n\n")
		.trim();
}

function detectBlockedReason(
	status: number | null,
	title: string,
	text: string,
	finalUrl: string,
): string | undefined {
	if (status !== null && [401, 403, 429].includes(status)) {
		return "captcha_or_login";
	}

	try {
		if (new URL(finalUrl).searchParams.has("js_challenge")) {
			return "captcha_or_login";
		}
	} catch {
		// The requested URL was validated before navigation.
	}

	const sample = `${title}\n${text.slice(0, 6_000)}`.toLowerCase();
	const patterns = [
		/captcha/,
		/verify (that )?you are human/,
		/are you a human/,
		/robot check/,
		/unusual traffic/,
		/checking your browser/,
		/access denied/,
		/temporarily blocked/,
		/sign in to continue/,
		/log in to continue/,
		/login required/,
		/you must be logged in/,
		/enable cookies to continue/,
	];

	return patterns.some((pattern) => pattern.test(sample))
		? "captcha_or_login"
		: undefined;
}

async function extractPage(page: Page): Promise<ExtractedPage> {
	const extracted = await page.evaluate((linkLimit) => {
		const clean = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();
		const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
			.map((anchor) => ({
				text: clean(
					anchor.innerText ||
						anchor.getAttribute("aria-label") ||
						anchor.getAttribute("title") ||
						anchor.href,
				),
				url: anchor.href,
			}))
			.filter((link) => link.url)
			.slice(0, linkLimit * 3);

		return {
			finalUrl: window.location.href,
			title: document.title,
			text: document.body?.innerText ?? "",
			links,
		};
	}, MAX_LINKS);

	const seen = new Set<string>();
	const links: Array<{ text: string; url: string }> = [];
	for (const link of extracted.links) {
		try {
			const url = new URL(link.url);
			if (!["http:", "https:"].includes(url.protocol) || seen.has(url.href)) continue;
			seen.add(url.href);
			links.push({ text: normalizeText(link.text).slice(0, 200), url: url.href });
			if (links.length >= MAX_LINKS) break;
		} catch {
			// Ignore malformed links from the page.
		}
	}

	return {
		finalUrl: extracted.finalUrl,
		title: normalizeText(extracted.title).slice(0, 500),
		text: normalizeText(extracted.text).slice(0, MAX_TEXT_CHARS),
		links,
	};
}

function formatPage(page: ExtractedPage): string {
	const sections = [
		`Title: ${page.title || "(untitled)"}`,
		`URL: ${page.finalUrl}`,
		"",
		page.text,
	];

	if (page.links.length > 0) {
		sections.push(
			"",
			"Links:",
			...page.links.map((link) => `- ${link.text || link.url}: ${link.url}`),
		);
	}

	return sections.join("\n");
}

export default function (pi: ExtensionAPI) {
	const background = createBackgroundToolManager(pi, {
		namespace: "browser-fetch",
		statusLabel: "browser_fetch",
		maxActive: 4,
	});

	pi.registerTool(background.wrapReadOnly({
		name: "browser_fetch",
		label: "Browser Fetch",
		description: `Fetch a public HTTP or HTTPS page asynchronously with a fresh headless Chromium profile and return its rendered readable text and links. Returns immediately after starting bounded background work; completion arrives later as one background result. Use it when curl cannot read a page or JavaScript rendering is required. It does not bypass logins, CAPTCHAs, or anti-bot checks, and it rejects non-public network destinations across navigation and page requests. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		promptSnippet: "Start an asynchronous rendered-page fetch with headless Chromium",
		promptGuidelines: [
			"Use browser_fetch when curl fails, returns blocked or nearly empty HTML, or the requested page requires JavaScript rendering.",
			"When multiple browser_fetch calls or other background research calls are independently useful, start them in the same turn so Pi can run them concurrently; do not wait for one result before starting another.",
			"After browser_fetch starts background work, never wait, sleep, or poll for its result. Continue only useful work independent of that result; otherwise end the response so the later background result can be delivered.",
			"If browser_fetch reports a login, CAPTCHA, anti-bot block, or unreadable page, mark the source unverified instead of guessing.",
		],
		parameters: browserFetchParameters,

		async execute(_toolCallId, params, signal) {
			const requestedUrl = parseUrl(params.url).href;
			let browser: Browser | undefined;
			let proxy: PublicProxy | undefined;
			let aborted = false;
			const ensureActive = () => {
				if (aborted) throw new Error("Browser fetch cancelled");
			};
			const abortHandler = () => {
				aborted = true;
				void browser?.close().catch(() => undefined);
				void proxy?.close().catch(() => undefined);
			};
			signal?.addEventListener("abort", abortHandler, { once: true });

			try {
				proxy = await startPublicProxy();
				ensureActive();
				browser = await chromium.launch({
					executablePath: resolveBrowserExecutable(),
					headless: true,
					args: [
						"--disable-dev-shm-usage",
						"--disable-extensions",
						"--disable-quic",
						`--proxy-server=${proxy.url}`,
						"--proxy-bypass-list=<-loopback>",
					],
				});
				ensureActive();
				const context = await browser.newContext({ serviceWorkers: "block" });
				const page = await context.newPage();
				page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);

				const response = await page.goto(requestedUrl, {
					waitUntil: "domcontentloaded",
					timeout: NAVIGATION_TIMEOUT_MS,
				});
				await page
					.waitForLoadState("networkidle", { timeout: RENDER_WAIT_MS })
					.catch(() => undefined);

				ensureActive();

				const extracted = await extractPage(page);
				const status = response?.status() ?? null;
				const blockedReason = detectBlockedReason(
					status,
					extracted.title,
					extracted.text,
					extracted.finalUrl,
				);
				const details: BrowserFetchDetails = {
					url: requestedUrl,
					finalUrl: extracted.finalUrl,
					title: extracted.title,
					status,
					blockedReason,
				};

				if (blockedReason) {
					return {
						content: [{ type: "text" as const, text: `Page blocked: ${blockedReason}\nURL: ${extracted.finalUrl}` }],
						details,
					};
				}

				if (status !== null && status >= 400) {
					throw new Error(`Browser fetch failed with HTTP ${status}: ${extracted.finalUrl}`);
				}

				if (extracted.text.length < MIN_READABLE_CHARS) {
					return {
						content: [{ type: "text" as const, text: `No readable content found at ${extracted.finalUrl}` }],
						details: { ...details, blockedReason: "no_readable_content" },
					};
				}

				const fullOutput = formatPage(extracted);
				const truncation = truncateHead(fullOutput, {
					maxLines: DEFAULT_MAX_LINES,
					maxBytes: DEFAULT_MAX_BYTES,
				});
				let output = truncation.content;

				if (truncation.truncated) {
					const directory = await mkdtemp(join(tmpdir(), "pi-browser-fetch-"));
					const fullOutputPath = join(directory, "page.txt");
					await writeFile(fullOutputPath, fullOutput, "utf8");
					details.fullOutputPath = fullOutputPath;
					output += `\n\n[Output truncated to ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output: ${fullOutputPath}]`;
				}

				return {
					content: [{ type: "text" as const, text: output }],
					details,
				};
			} finally {
				signal?.removeEventListener("abort", abortHandler);
				await browser?.close().catch(() => undefined);
				await proxy?.close().catch(() => undefined);
			}
		},
	}));
}
