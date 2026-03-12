#!/usr/bin/env node

import http from "node:http";
import net from "node:net";

const bindHost = process.env.CDP_PROXY_BIND_HOST ?? "0.0.0.0";
const bindPort = Number(process.env.CDP_PROXY_BIND_PORT ?? "9233");
const targetHost = process.env.CDP_PROXY_TARGET_HOST ?? "host.docker.internal";
const targetPort = Number(process.env.CDP_PROXY_TARGET_PORT ?? "9222");
const targetHostHeader = process.env.CDP_PROXY_TARGET_HOST_HEADER ?? `127.0.0.1:${targetPort}`;
const publicHost = process.env.CDP_PROXY_PUBLIC_HOST ?? `openclaw-cdp-proxy:${bindPort}`;
const publicWsScheme = process.env.CDP_PROXY_PUBLIC_WS_SCHEME ?? "ws";

function shouldRewriteJson(reqPath, contentType, body) {
  if (!reqPath.startsWith("/json/")) {
    return false;
  }
  const type = String(contentType ?? "").toLowerCase();
  if (!type.includes("application/json")) {
    return false;
  }
  return body.includes(`ws://127.0.0.1:${targetPort}`);
}

function rewriteJsonWsUrls(body) {
  return body.split(`ws://127.0.0.1:${targetPort}`).join(`${publicWsScheme}://${publicHost}`);
}

function cloneHeaders(headers) {
  const next = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== "undefined") {
      next[key] = value;
    }
  }
  return next;
}

const server = http.createServer((req, res) => {
  const reqPath = req.url ?? "/";
  const upstreamHeaders = cloneHeaders(req.headers);
  upstreamHeaders.host = targetHostHeader;

  const upstreamReq = http.request(
    {
      host: targetHost,
      port: targetPort,
      method: req.method,
      path: reqPath,
      headers: upstreamHeaders,
    },
    (upstreamRes) => {
      const chunks = [];
      upstreamRes.on("data", (chunk) => chunks.push(chunk));
      upstreamRes.on("end", () => {
        let payload = Buffer.concat(chunks);
        const responseHeaders = cloneHeaders(upstreamRes.headers);
        delete responseHeaders["transfer-encoding"];

        if (shouldRewriteJson(reqPath, responseHeaders["content-type"], payload.toString("utf8"))) {
          const rewritten = rewriteJsonWsUrls(payload.toString("utf8"));
          payload = Buffer.from(rewritten, "utf8");
        }
        responseHeaders["content-length"] = String(payload.byteLength);

        res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
        res.end(payload);
      });
    },
  );

  upstreamReq.on("error", (err) => {
    res.statusCode = 502;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end(`cdp upstream error: ${err.message}`);
  });

  req.pipe(upstreamReq);
});

server.on("upgrade", (req, clientSocket, head) => {
  const upstreamSocket = net.connect(targetPort, targetHost);

  const fail = () => {
    try {
      clientSocket.destroy();
    } catch {}
    try {
      upstreamSocket.destroy();
    } catch {}
  };

  upstreamSocket.on("error", fail);
  clientSocket.on("error", fail);

  upstreamSocket.on("connect", () => {
    const requestLine = `GET ${req.url ?? "/"} HTTP/1.1`;
    const lines = [requestLine];
    const raw = req.rawHeaders ?? [];
    for (let i = 0; i < raw.length; i += 2) {
      const key = raw[i];
      const value = raw[i + 1] ?? "";
      if (key.toLowerCase() === "host") {
        lines.push(`Host: ${targetHostHeader}`);
      } else {
        lines.push(`${key}: ${value}`);
      }
    }
    if (!raw.some((h) => String(h).toLowerCase() === "host")) {
      lines.push(`Host: ${targetHostHeader}`);
    }
    lines.push("", "");

    upstreamSocket.write(lines.join("\r\n"));
    if (head?.length) {
      upstreamSocket.write(head);
    }

    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
  });
});

server.on("clientError", (err, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  console.error(`[cdp-proxy] client error: ${err.message}`);
});

server.on("error", (err) => {
  console.error(`[cdp-proxy] server error: ${err.message}`);
  process.exit(1);
});

server.listen(bindPort, bindHost, () => {
  console.log(
    `[cdp-proxy] listening on ${bindHost}:${bindPort}, forwarding to ${targetHost}:${targetPort}, host header => ${targetHostHeader}, public ws => ${publicWsScheme}://${publicHost}`,
  );
});
