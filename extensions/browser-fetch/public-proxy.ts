import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, createServer, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import ipaddr from "ipaddr.js";

interface LookupAddress {
	address: string;
	family: number;
}

export interface PublicProxyOptions {
	lookup?: (hostname: string) => Promise<LookupAddress[]>;
	connect?: (options: { host: string; port: number }) => Socket;
}

export interface PublicProxy {
	url: string;
	close(): Promise<void>;
}

function hostnameOf(url: URL): string {
	return url.hostname.replace(/^\[|\]$/g, "");
}

export function isPublicAddress(address: string): boolean {
	return ipaddr.isValid(address) && ipaddr.process(address).range() === "unicast";
}

async function resolvePublicAddress(
	hostname: string,
	lookup: NonNullable<PublicProxyOptions["lookup"]>,
): Promise<string> {
	const addresses = ipaddr.isValid(hostname)
		? [{ address: hostname, family: ipaddr.process(hostname).kind() === "ipv4" ? 4 : 6 }]
		: await lookup(hostname);

	if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
		throw new Error(`Non-public network destination is not allowed: ${hostname}`);
	}

	return addresses[0].address;
}

function targetFromRequest(request: IncomingMessage): URL {
	const target = new URL(request.url ?? "");
	if (target.protocol !== "http:" && target.protocol !== "ws:") {
		throw new Error(`Unsupported proxy protocol: ${target.protocol}`);
	}
	if (target.username || target.password) throw new Error("URL credentials are not supported");
	return target;
}

function connectTargetFromAuthority(authority: string): URL {
	const target = new URL(`https://${authority}`);
	if (target.username || target.password) throw new Error("URL credentials are not supported");
	if (target.pathname !== "/" || target.search || target.hash) throw new Error("Invalid CONNECT authority");
	return target;
}

function forwardedHeaders(headers: IncomingHttpHeaders, host: string): IncomingHttpHeaders {
	const forwarded: Record<string, string | string[] | undefined> = { ...headers, host };
	delete forwarded["proxy-authorization"];
	delete forwarded["proxy-connection"];
	return forwarded;
}

function writeProxyError(socket: Duplex, status: 403 | 502): void {
	if (socket.destroyed) return;
	const label = status === 403 ? "Forbidden" : "Bad Gateway";
	socket.end(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export async function startPublicProxy(options: PublicProxyOptions = {}): Promise<PublicProxy> {
	const lookup = options.lookup ?? (async (hostname) => dnsLookup(hostname, { all: true, verbatim: true }));
	const connect = options.connect ?? netConnect;
	const sockets = new Set<Duplex>();
	let closed = false;
	const track = (socket: Duplex) => {
		sockets.add(socket);
		socket.on("error", () => socket.destroy());
		socket.once("close", () => sockets.delete(socket));
		return socket;
	};
	const server = createServer(async (request, response) => {
		try {
			const target = targetFromRequest(request);
			const address = await resolvePublicAddress(hostnameOf(target), lookup);
			if (closed || request.destroyed) throw new Error("Browser proxy closed");
			const upstream = httpRequest({
				host: address,
				port: target.port || 80,
				method: request.method,
				path: `${target.pathname}${target.search}`,
				headers: forwardedHeaders(request.headers, target.host),
			});
			upstream.on("socket", track);
			upstream.on("response", (upstreamResponse) => {
				response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
				upstreamResponse.pipe(response);
			});
			upstream.on("error", () => {
				if (!response.headersSent) response.writeHead(502);
				response.end();
			});
			request.pipe(upstream);
		} catch {
			response.writeHead(403);
			response.end();
		}
	});

	server.on("connection", track);
	server.on("connect", async (request, client, head) => {
		try {
			const target = connectTargetFromAuthority(request.url ?? "");
			const address = await resolvePublicAddress(hostnameOf(target), lookup);
			if (closed || client.destroyed) throw new Error("Browser proxy closed");
			const upstream = track(connect({ host: address, port: Number(target.port || 443) }));
			upstream.once("connect", () => {
				client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
				if (head.length > 0) upstream.write(head);
				client.pipe(upstream).pipe(client);
			});
			upstream.once("error", () => writeProxyError(client, 502));
		} catch {
			writeProxyError(client, 403);
		}
	});

	server.on("upgrade", async (request, client, head) => {
		try {
			const target = targetFromRequest(request);
			const address = await resolvePublicAddress(hostnameOf(target), lookup);
			if (closed || client.destroyed) throw new Error("Browser proxy closed");
			const upstream = track(connect({ host: address, port: Number(target.port || 80) }));
			upstream.once("connect", () => {
				const headers = forwardedHeaders(request.headers, target.host);
				const headerLines = Object.entries(headers).flatMap(([name, value]) =>
					Array.isArray(value)
						? value.map((item) => `${name}: ${item}`)
						: value === undefined ? [] : [`${name}: ${value}`],
				);
				upstream.write(`${request.method ?? "GET"} ${target.pathname}${target.search} HTTP/${request.httpVersion}\r\n${headerLines.join("\r\n")}\r\n\r\n`);
				if (head.length > 0) upstream.write(head);
				client.pipe(upstream).pipe(client);
			});
			upstream.once("error", () => writeProxyError(client, 502));
		} catch {
			writeProxyError(client, 403);
		}
	});

	server.on("clientError", (_error, socket) => writeProxyError(socket, 502));
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Browser proxy did not bind a TCP port");

	let closePromise: Promise<void> | undefined;
	return {
		url: `http://127.0.0.1:${address.port}`,
		close() {
			closed = true;
			closePromise ??= new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy();
				server.close(() => resolve());
			});
			return closePromise;
		},
	};
}
