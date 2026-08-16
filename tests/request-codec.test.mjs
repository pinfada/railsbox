import { test } from "node:test";
import assert from "node:assert/strict";
import {
  filterRequestHeaders,
  parseCurlHeaders,
  sanitizeAppPath,
  sanitizeCookieHeader,
  sanitizeForwardHost,
  sanitizeMethod,
  shellSingleQuote,
} from "../public/shared/request-codec.js";

test("shellSingleQuote neutralise les apostrophes", () => {
  assert.equal(shellSingleQuote("abc"), "'abc'");
  assert.equal(shellSingleQuote("a'b"), "'a'\\''b'");
});

test("sanitizeMethod accepte les méthodes standard et refuse le reste", () => {
  assert.equal(sanitizeMethod("post"), "POST");
  assert.throws(() => sanitizeMethod("TRACE"));
  assert.throws(() => sanitizeMethod("GET; rm -rf /"));
});

test("sanitizeAppPath accepte un chemin encodé normal", () => {
  assert.equal(sanitizeAppPath("/app/posts?page=2&q=caf%C3%A9"), "/app/posts?page=2&q=caf%C3%A9");
});

test("sanitizeAppPath refuse les métacaractères shell", () => {
  for (const evil of ["/x'; rm -rf /", "/a b", '/a"b', "/a`id`", "/a$HOME", "/a\\b", "relatif"]) {
    assert.throws(() => sanitizeAppPath(evil), undefined, `aurait dû refuser: ${evil}`);
  }
});

test("sanitizeForwardHost filtre les hosts invalides", () => {
  assert.equal(sanitizeForwardHost("localhost:8080"), "localhost:8080");
  assert.equal(sanitizeForwardHost("evil.com' -H 'X: y"), null);
  assert.equal(sanitizeForwardHost(""), null);
});

test("filterRequestHeaders retire host, les CRLF et les noms exotiques", () => {
  const kept = filterRequestHeaders([
    ["Host", "localhost"],
    ["Accept", "text/html"],
    ["X-Evil", "a\r\nInjected: oui"],
    ["Weird Name!", "x"],
    ["Content-Type", "application/x-www-form-urlencoded"],
  ]);
  assert.deepEqual(kept, [
    ["accept", "text/html"],
    ["content-type", "application/x-www-form-urlencoded"],
  ]);
});

test("filterRequestHeaders retire Cookie et Origin, venus du navigateur", () => {
  // Cookie : le bocal du Service Worker est la source UNIQUE (canal dédié de
  // buildRequestFrames). Origin : Rails le compare à request.base_url, que le
  // guest ne peut pas deviner — le retirer rend la vérification neutre, la
  // protection CSRF restant portée par le jeton de session.
  const kept = filterRequestHeaders([
    ["Cookie", "_demo_session=forge"],
    ["Origin", "https://pinfada.github.io"],
    ["Accept", "text/html"],
  ]);
  assert.deepEqual(kept, [["accept", "text/html"]]);
});

test("sanitizeCookieHeader accepte un en-tête normal et refuse les injections", () => {
  assert.equal(sanitizeCookieHeader("_demo_session=abc; autre=1"), "_demo_session=abc; autre=1");
  assert.equal(sanitizeCookieHeader(""), null);
  assert.equal(sanitizeCookieHeader(null), null);
  assert.equal(
    sanitizeCookieHeader(`a=1${String.fromCharCode(13)}${String.fromCharCode(10)}X-Injecte: oui`),
    null,
  );
  assert.equal(sanitizeCookieHeader(`a=${String.fromCharCode(0)}`), null);
  assert.equal(sanitizeCookieHeader("a=".padEnd(9000, "x")), null, "en-tête démesuré refusé");
});

test("parseCurlHeaders lit statut + en-têtes et retire les hop-by-hop", () => {
  const parsed = parseCurlHeaders(
    "HTTP/1.1 302 Found\r\nLocation: /app/login\r\nContent-Length: 12\r\nConnection: close\r\nSet-Cookie: s=1\r\n\r\n",
  );
  assert.equal(parsed.status, 302);
  assert.equal(parsed.statusText, "Found");
  assert.deepEqual(parsed.headers, [
    ["location", "/app/login"],
    ["set-cookie", "s=1"],
  ]);
});

test("parseCurlHeaders ne garde que le dernier bloc (100 Continue)", () => {
  const parsed = parseCurlHeaders(
    "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 201 Created\r\nContent-Type: text/html\r\n\r\n",
  );
  assert.equal(parsed.status, 201);
  assert.deepEqual(parsed.headers, [["content-type", "text/html"]]);
});

test("parseCurlHeaders échoue proprement sur une sortie vide ou corrompue", () => {
  assert.throws(() => parseCurlHeaders(""));
  assert.throws(() => parseCurlHeaders("pas du http"));
});
