import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import process from 'node:process';

const originalFetch = globalThis.fetch.bind(globalThis);
const originalHttpRequest = http.request.bind(http);
const originalHttpsRequest = https.request.bind(https);
const originalNetConnect = net.connect.bind(net);
const originalNetCreateConnection = net.createConnection.bind(net);
const originalDnsLookup = dns.lookup.bind(dns);
const originalDnsPromisesLookup = dns.promises.lookup.bind(dns.promises);
const redirects = new Map([
  ['api.openai.com', 'http://fake-llm:4013'],
  ['api.deepseek.com', 'http://fake-llm:4013'],
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

function asUrl(input) {
  if (input instanceof URL) return new URL(input.href);
  if (typeof input === 'string') return new URL(input);
  if (input && typeof input.url === 'string') return new URL(input.url);
  throw new Error('E2E egress guard: input fetch sem URL reconhecível');
}

function requestUrl(args, protocol) {
  const first = args[0];
  if (first instanceof URL) return first;
  if (typeof first === 'string') return new URL(first);
  if (first && typeof first === 'object') {
    const host = first.hostname ?? first.host ?? 'localhost';
    return new URL(
      `${first.protocol ?? protocol}//${host}:${first.port ?? ''}${first.path ?? '/'}`,
    );
  }
  return new URL(`${protocol}//localhost/`);
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
