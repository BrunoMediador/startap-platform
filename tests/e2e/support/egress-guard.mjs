import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import process from 'node:process';
import { urlToHttpOptions } from 'node:url';

const originalFetch = globalThis.fetch.bind(globalThis);
const originalHttpRequest = http.request.bind(http);
const originalHttpsRequest = https.request.bind(https);
const originalNetConnect = net.connect.bind(net);
const originalNetCreateConnection = net.createConnection.bind(net);
const originalDnsLookup = dns.lookup.bind(dns);
const originalDnsPromisesLookup = dns.promises.lookup.bind(dns.promises);
const llmRedirect = process.env.E2E_LLM_REDIRECT_URL ?? 'http://fake-llm:4013';
const redirects = new Map([
  ['api.openai.com', llmRedirect],
  ['api.deepseek.com', llmRedirect],
  ['oauth2.googleapis.com', 'http://fake-gcal:4011'],
  ['www.googleapis.com', 'http://fake-gcal:4011'],
  ['api.abacatepay.com', 'http://fake-abacatepay:4012'],
]);
const allowed = new Set(
  (process.env.E2E_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
);

function blocked(host) {
  const error = new Error(`E2E_EGRESS_BLOCKED:${host}`);
  error.code = 'E2E_EGRESS_BLOCKED';
  return error;
}

function allowedHost(host) {
  const normalized = String(host || 'localhost')
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return (
    allowed.has(normalized) ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === 'localhost'
  );
}

function allowedDnsLookupCallbackHost(host) {
  const normalized = String(host || 'localhost')
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return allowedHost(normalized) || normalized === '0.0.0.0' || normalized === '0.0.0';
}

function asUrl(input) {
  if (input instanceof URL) return new URL(input.href);
  if (typeof input === 'string') return new URL(input);
  if (input && typeof input.url === 'string') return new URL(input.url);
  throw new Error('E2E egress guard: input fetch sem URL reconhecível');
}

function requestUrl(args, protocol) {
  const first = args[0];
  const second = args[1];
  if (first instanceof URL || typeof first === 'string') {
    const base = new URL(first instanceof URL ? first.href : first);
    if (!second || typeof second !== 'object') return base;
    const host = second.hostname ?? second.host ?? base.hostname;
    return new URL(
      `${second.protocol ?? base.protocol}//${host}:${second.port ?? base.port}${second.path ?? `${base.pathname}${base.search}`}`,
    );
  }
  if (first && typeof first === 'object') {
    const host = first.hostname ?? first.host ?? 'localhost';
    return new URL(
      `${first.protocol ?? protocol}//${host}:${first.port ?? ''}${first.path ?? '/'}`,
    );
  }
  return new URL(`${protocol}//localhost/`);
}

function requestOptions(args) {
  const first = args[0];
  const second = args[1];
  if (first instanceof URL || typeof first === 'string') {
    const fromUrl = urlToHttpOptions(new URL(first instanceof URL ? first.href : first));
    return { ...fromUrl, ...(second && typeof second === 'object' ? second : {}) };
  }
  return first && typeof first === 'object' ? { ...first } : {};
}

function requestCallback(args) {
  return args.findLast((arg) => typeof arg === 'function');
}

function redirectedHeaders(headers, targetHost) {
  if (!headers || typeof headers !== 'object') return headers;
  if (Array.isArray(headers)) {
    return headers.map((entry) =>
      Array.isArray(entry) && String(entry[0]).toLowerCase() === 'host'
        ? [entry[0], targetHost]
        : entry,
    );
  }
  const rewritten = { ...headers };
  for (const key of Object.keys(rewritten)) {
    if (key.toLowerCase() === 'host') rewritten[key] = targetHost;
  }
  return rewritten;
}

function redirectedHttpRequest(args, sourceUrl, targetBase) {
  const target = new URL(`${sourceUrl.pathname}${sourceUrl.search}`, targetBase);
  if (!allowedHost(target.hostname)) throw blocked(target.hostname);
  const options = requestOptions(args);
  const redirected = {
    ...options,
    protocol: 'http:',
    hostname: target.hostname,
    host: target.hostname,
    port: target.port || '80',
    path: `${target.pathname}${target.search}`,
    pathname: target.pathname,
    search: target.search,
    href: target.href,
    auth: undefined,
    agent: undefined,
    servername: undefined,
    headers: redirectedHeaders(options.headers, target.host),
  };
  const callback = requestCallback(args);
  return callback ? originalHttpRequest(redirected, callback) : originalHttpRequest(redirected);
}

globalThis.fetch = async (input, init) => {
  const url = asUrl(input);
  const target = redirects.get(url.hostname);
  if (target) {
    const redirected = new URL(`${url.pathname}${url.search}`, target);
    return originalFetch(redirected, init);
  }
  if (allowedHost(url.hostname)) return originalFetch(input, init);
  throw blocked(url.hostname);
};

http.request = function guardedHttpRequest(...args) {
  const url = requestUrl(args, 'http:');
  if (!allowedHost(url.hostname)) throw blocked(url.hostname);
  return originalHttpRequest(...args);
};
http.get = function guardedHttpGet(...args) {
  const request = http.request(...args);
  request.end();
  return request;
};

https.request = function guardedHttpsRequest(...args) {
  const url = requestUrl(args, 'https:');
  const target = redirects.get(url.hostname);
  if (target) return redirectedHttpRequest(args, url, target);
  if (!allowedHost(url.hostname)) throw blocked(url.hostname);
  return originalHttpsRequest(...args);
};
https.get = function guardedHttpsGet(...args) {
  const request = https.request(...args);
  request.end();
  return request;
};

function netHost(args) {
  const first = args[0];
  if (first && typeof first === 'object') return first.host ?? 'localhost';
  if (typeof first === 'number') return typeof args[1] === 'string' ? args[1] : 'localhost';
  if (typeof first === 'string' && /^\d+$/u.test(first)) return args[1] ?? 'localhost';
  return null;
}

net.connect = function guardedNetConnect(...args) {
  const host = netHost(args);
  if (host !== null && !allowedHost(host)) throw blocked(host);
  return originalNetConnect(...args);
};
net.createConnection = function guardedNetCreateConnection(...args) {
  const host = netHost(args);
  if (host !== null && !allowedHost(host)) throw blocked(host);
  return originalNetCreateConnection(...args);
};

dns.lookup = function guardedDnsLookup(hostname, ...args) {
  if (allowedHost(hostname)) return originalDnsLookup(hostname, ...args);
  const callback = args.findLast((item) => typeof item === 'function');
  if (callback && allowedDnsLookupCallbackHost(hostname)) {
    return originalDnsLookup(hostname, ...args);
  }
  if (callback) {
    queueMicrotask(() => callback(blocked(hostname)));
    return undefined;
  }
  throw blocked(hostname);
};
dns.promises.lookup = async function guardedDnsPromisesLookup(hostname, options) {
  if (!allowedHost(hostname)) throw blocked(hostname);
  return originalDnsPromisesLookup(hostname, options);
};

syncBuiltinESMExports();
