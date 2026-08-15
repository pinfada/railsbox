import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bridgePaths,
  parseDoneMarker,
  buildBridgeRequest,
  deviceRelative,
  filterRequestHeaders,
  parseCurlHeaders,
  sanitizeAppPath,
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

test("bridgePaths nettoie l'identifiant et refuse un identifiant vide", () => {
  assert.equal(bridgePaths("12").head, "/files/res-12.head");
  assert.equal(bridgePaths("a/../b").head, "/files/res-ab.head");
  assert.throws(() => bridgePaths("../.."));
});

test("deviceRelative retire le préfixe de montage", () => {
  assert.equal(deviceRelative("/files/res-1.head", "/files"), "/res-1.head");
  assert.throws(() => deviceRelative("/etc/passwd", "/files"));
});

test("buildBridgeRequest produit un descripteur JSON complet et un cmd statique", () => {
  const { descriptorJson, commandScript } = buildBridgeRequest({
    seq: 7,
    method: "POST",
    path: "/app/posts",
    headers: [
      ["content-type", "application/json"],
      ["Host", "a-jeter"],
    ],
    hasBody: true,
    forwardHost: "localhost:8080",
  });
  const descriptor = JSON.parse(descriptorJson);
  assert.equal(descriptor.method, "POST");
  assert.equal(descriptor.path, "/app/posts");
  assert.equal(descriptor.socket, "/tmp/app.sock");
  assert.deepEqual(descriptor.headers[0], ["host", "localhost:8080"]);
  assert.deepEqual(descriptor.headers[1], ["content-type", "application/json"]);
  assert.equal(descriptor.requestBodyFile, "/data/req-7.body");
  assert.equal(descriptor.headFile, "/files/res-7.head");
  assert.equal(descriptor.bodyFile, "/files/res-7.body");
  assert.equal(descriptor.doneFile, "/files/res-7.done");
  assert.match(
    commandScript,
    /^#!\/bin\/sh\npython3 \/data\/bridge-client\.py '\/data\/req-7\.json'\n$/,
  );
  assert.ok(!commandScript.includes("\r"), "le script ne doit contenir aucun CRLF");
});

test("buildBridgeRequest omet le corps pour un GET et refuse les entrées piégées", () => {
  const { descriptorJson } = buildBridgeRequest({
    seq: 2,
    method: "GET",
    path: "/app/",
    headers: [],
    hasBody: false,
    forwardHost: "evil.com' -H 'X: y",
  });
  const descriptor = JSON.parse(descriptorJson);
  assert.equal(descriptor.requestBodyFile, null);
  assert.equal(descriptor.headers.length, 0, "un host invalide est simplement omis");
  assert.throws(() =>
    buildBridgeRequest({
      seq: 1,
      method: "GET",
      path: "/x'; cat /etc/passwd #",
      headers: [],
      hasBody: false,
    }),
  );
  assert.throws(() =>
    buildBridgeRequest({
      seq: 1,
      method: "GET",
      path: "/",
      headers: [],
      hasBody: false,
      socketPath: "/tmp/x'; id #",
    }),
  );
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

test("parseDoneMarker lit le triplet code/tailles et refuse le reste", () => {
  assert.deepEqual(parseDoneMarker("0 187 5230\n"), { curlExit: 0, headSize: 187, bodySize: 5230 });
  assert.deepEqual(parseDoneMarker("7 0 0"), { curlExit: 7, headSize: 0, bodySize: 0 });
  assert.throws(() => parseDoneMarker(""));
  assert.throws(() => parseDoneMarker("0 x 2"));
  assert.throws(() => parseDoneMarker("0 1"));
});
