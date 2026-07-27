import { request as httpRequest } from "node:http";
import { connect as netConnect, createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isPublicAddress, startPublicProxy, type PublicProxy } from "./public-proxy.ts";

const openProxies: PublicProxy[] = [];

afterEach(async () => {
  await Promise.all(openProxies.splice(0).map((proxy) => proxy.close()));
});

async function proxyGet(proxyUrl: string, targetUrl: string): Promise<number | undefined> {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: proxy.hostname,
      port: proxy.port,
      method: "GET",
      path: targetUrl,
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
    request.end();
  });
}

async function proxyConnect(proxyUrl: string, authority: string, reset = false): Promise<string> {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: proxy.hostname, port: Number(proxy.port) });
    socket.once("connect", () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    socket.once("data", (chunk) => {
      resolve(chunk.toString("utf8"));
      if (reset) socket.resetAndDestroy();
      else socket.destroy();
    });
    socket.once("error", reject);
  });
}

describe("public browser proxy", () => {
  it("classifies only globally routable unicast addresses as public", () => {
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
    expect(isPublicAddress("127.0.0.1")).toBe(false);
    expect(isPublicAddress("10.0.0.1")).toBe(false);
    expect(isPublicAddress("169.254.169.254")).toBe(false);
    expect(isPublicAddress("::1")).toBe(false);
    expect(isPublicAddress("fd00::1")).toBe(false);
  });

  it("rejects private HTTP and HTTPS CONNECT destinations before opening them", async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: "10.0.0.8", family: 4 }]);
    const proxy = await startPublicProxy({ lookup });
    openProxies.push(proxy);

    await expect(proxyGet(proxy.url, "http://internal.example/secret")).resolves.toBe(403);
    await expect(proxyConnect(proxy.url, "internal.example:443")).resolves.toContain("403 Forbidden");
    expect(lookup).toHaveBeenCalledWith("internal.example");
  });

  it("rejects direct loopback and metadata IP literals without DNS resolution", async () => {
    const lookup = vi.fn();
    const proxy = await startPublicProxy({ lookup });
    openProxies.push(proxy);

    await expect(proxyGet(proxy.url, "http://127.0.0.1/admin")).resolves.toBe(403);
    await expect(proxyConnect(proxy.url, "169.254.169.254:443")).resolves.toContain("403 Forbidden");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("contains client resets after an HTTPS tunnel is established", async () => {
    const destination = createServer((socket) => socket.on("error", () => undefined));
    await new Promise<void>((resolve) => destination.listen(0, "127.0.0.1", resolve));
    const address = destination.address();
    if (!address || typeof address === "string") throw new Error("Test destination did not bind");
    const connect = vi.fn().mockImplementation(() => netConnect({
      host: "127.0.0.1",
      port: address.port,
    }));
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const proxy = await startPublicProxy({ lookup, connect });
    openProxies.push(proxy);

    try {
      await expect(proxyConnect(proxy.url, "public.example:443", true)).resolves.toContain("200 Connection Established");
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      expect(connect).toHaveBeenCalledWith({ host: "93.184.216.34", port: 443 });
    } finally {
      destination.close();
    }
  });

  it("rejects hostnames when any resolved address is non-public", async () => {
    const lookup = vi.fn().mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "192.168.1.20", family: 4 },
    ]);
    const proxy = await startPublicProxy({ lookup });
    openProxies.push(proxy);

    await expect(proxyGet(proxy.url, "http://mixed.example/")).resolves.toBe(403);
  });
});
