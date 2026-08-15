import { test } from "node:test";
import assert from "node:assert/strict";
import {
  base64ToBytes,
  buildRequestFrames,
  buildTimeSyncFrame,
  bytesToBase64,
  createLineAssembler,
  createResponseAssembler,
  parseFrameLine,
  splitHttpResponse,
} from "../public/shared/serial-codec.js";

test("bytesToBase64/base64ToBytes font l'aller-retour, y compris binaire", () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255, 10, 13]);
  assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
  const big = new Uint8Array(200_000).map((_, i) => i % 256);
  assert.deepEqual(base64ToBytes(bytesToBase64(big)), big);
});

test("buildRequestFrames sépare le descripteur du corps (une seule couche base64)", () => {
  const { head, bodyChunks, tail } = buildRequestFrames("42", {
    method: "post",
    path: "/app/login",
    headers: [
      ["Content-Type", "application/x-www-form-urlencoded"],
      ["Host", "a-jeter"],
    ],
    forwardHost: "localhost:8080",
    bodyBytes: new TextEncoder().encode("user=x"),
  });
  assert.match(head, /^@RIB1 REQ 42 [A-Za-z0-9+/=]+\n$/);
  const descriptor = JSON.parse(new TextDecoder().decode(base64ToBytes(head.trim().split(" ")[3])));
  assert.equal(descriptor.method, "POST");
  assert.equal(descriptor.path, "/app/login");
  assert.deepEqual(descriptor.headers[0], ["host", "localhost:8080"]);
  assert.equal(descriptor.bodyLength, 6);
  assert.equal(descriptor.body, undefined, "le corps ne doit plus être dans le descripteur");
  assert.equal(bodyChunks.length, 1);
  assert.equal(
    new TextDecoder().decode(base64ToBytes(bodyChunks[0].trim().split(" ")[3])),
    "user=x",
  );
  assert.equal(tail, "@RIB1 FIN 42\n");
});

test("buildRequestFrames découpe un gros corps en tranches acquittables", () => {
  const corps = new Uint8Array(200 * 1024).map((_, index) => index % 256);
  const { bodyChunks } = buildRequestFrames("7", {
    method: "POST",
    path: "/app/upload",
    headers: [],
    bodyBytes: corps,
  });
  assert.equal(bodyChunks.length, Math.ceil(corps.length / 1536));
  for (const chunk of bodyChunks) {
    // Chaque ligne doit rester bien sous la limite canonique du TTY (4096).
    assert.ok(chunk.length < 3000, `tranche trop longue: ${chunk.length}`);
  }
  // Le réassemblage doit rendre le corps à l'octet près.
  const reassemble = bodyChunks.map((c) => base64ToBytes(c.trim().split(" ")[3]));
  const total = reassemble.reduce((sum, part) => sum + part.length, 0);
  assert.equal(total, corps.length);
  const plat = new Uint8Array(total);
  let offset = 0;
  for (const part of reassemble) {
    plat.set(part, offset);
    offset += part.length;
  }
  assert.deepEqual(plat, corps);
});

test("buildRequestFrames refuse un chemin piégé", () => {
  assert.throws(() =>
    buildRequestFrames("1", { method: "GET", path: "/x'; id", headers: [], bodyBytes: null }),
  );
});

test("parseFrameLine reconnaît les types de trames et rejette le bruit", () => {
  assert.deepEqual(parseFrameLine("@RIB1 RSB 3 120"), { kind: "RSB", id: "3", value: "120" });
  assert.deepEqual(parseFrameLine("@RIB1 END 3"), { kind: "END", id: "3", value: "" });
  assert.deepEqual(parseFrameLine("@RIB1 ERR 3 7"), { kind: "ERR", id: "3", value: "7" });
  assert.deepEqual(parseFrameLine("@RIB1 LOG pont serie pret"), {
    kind: "LOG",
    id: null,
    value: "pont serie pret",
  });
  assert.equal(parseFrameLine("[ 12.3] kernel: bruit de boot"), null);
  assert.equal(parseFrameLine("@RIB1 XYZ 1 a"), null);
});

test("createLineAssembler découpe les octets en lignes et tolère les CR", () => {
  const lines = [];
  const assembler = createLineAssembler((line) => lines.push(line));
  for (const byte of new TextEncoder().encode("hello\r\n@RIB1 END 1\n\n")) {
    assembler.feedByte(byte);
  }
  assert.deepEqual(lines, ["hello", "@RIB1 END 1"]);
});

test("createResponseAssembler décode en flux (RSB annonce la taille brute)", () => {
  const responses = [];
  const errors = [];
  const logs = [];
  const acks = [];
  const assembler = createResponseAssembler({
    onResponse: (id, bytes) => responses.push([id, new TextDecoder().decode(bytes)]),
    onError: (id, code) => errors.push([id, code]),
    onLog: (line) => logs.push(line),
    onAck: (id) => acks.push(id),
  });
  const brut = new TextEncoder().encode("HTTP/1.1 200 OK\r\n\r\nsalut");
  // Tranches multiples de 4 caractères base64 : décodables isolément.
  const payload = bytesToBase64(brut);
  const coupe = 12;
  assembler.handleLine("bruit du noyau");
  assembler.handleLine(`@RIB1 RSB 5 ${brut.length}`);
  assembler.handleLine(`@RIB1 DAT 5 ${payload.slice(0, coupe)}`);
  assembler.handleLine(`@RIB1 DAT 5 ${payload.slice(coupe)}`);
  assembler.handleLine("@RIB1 END 5");
  assembler.handleLine("@RIB1 ERR 6 7");
  assembler.handleLine("@RIB1 ACK 8");
  assert.deepEqual(responses, [["5", "HTTP/1.1 200 OK\r\n\r\nsalut"]]);
  assert.deepEqual(errors, [["6", 7]]);
  assert.deepEqual(logs, ["bruit du noyau"]);
  assert.deepEqual(acks, ["8"]);
});

test("createResponseAssembler signale une réponse tronquée au lieu de la livrer", () => {
  const responses = [];
  const errors = [];
  const assembler = createResponseAssembler({
    onResponse: (id, bytes) => responses.push([id, bytes.length]),
    onError: (id, code) => errors.push([id, code]),
    onLog: () => {},
  });
  const brut = new Uint8Array(300);
  const payload = bytesToBase64(brut);
  assembler.handleLine(`@RIB1 RSB 3 ${brut.length}`);
  assembler.handleLine(`@RIB1 DAT 3 ${payload.slice(0, 40)}`); // volontairement incomplet
  assembler.handleLine("@RIB1 END 3");
  assert.deepEqual(responses, [], "aucun corps partiel ne doit être livré");
  assert.deepEqual(errors, [["3", 56]]);
});

test("buildTimeSyncFrame émet une trame TIME entière et refuse l'invalide", () => {
  assert.equal(buildTimeSyncFrame(1786752000.87), "@RIB1 TIME 1786752000\n");
  assert.deepEqual(
    parseFrameLine("@RIB1 TIME 1786752000"),
    null,
    "TIME est entrant, pas une réponse",
  );
  for (const invalide of [0, -1, NaN, "hier", undefined]) {
    assert.throws(() => buildTimeSyncFrame(invalide), undefined, `aurait dû refuser: ${invalide}`);
  }
});

test("createLineAssembler gère les lignes plus longues que son tampon initial", () => {
  const lines = [];
  const assembler = createLineAssembler((line) => lines.push(line));
  const longue = "x".repeat(50_000); // > INITIAL_LINE_CAPACITY (16 Ko)
  for (const byte of new TextEncoder().encode(`${longue}\ncourte\n`)) {
    assembler.feedByte(byte);
  }
  assert.equal(lines.length, 2);
  assert.equal(lines[0].length, 50_000);
  assert.equal(lines[1], "courte");
  assert.equal(assembler.stats.lines, 2);
  assert.equal(assembler.stats.bytes, 50_008);
  assert.equal(assembler.stats.truncated, 0);
});

test("createResponseAssembler mesure le débit du transfert", () => {
  const payload = bytesToBase64(new Uint8Array(4096));
  let horloge = 1000;
  const assembler = createResponseAssembler({
    onResponse: () => {},
    onError: () => {},
    onLog: () => {},
    now: () => horloge,
  });
  assembler.handleLine("@RIB1 RSB 9 4096"); // taille brute, pas base64
  horloge += 200;
  assembler.handleLine(`@RIB1 DAT 9 ${payload}`);
  assembler.handleLine("@RIB1 END 9");
  assert.equal(assembler.lastTransfer.bytes, 4096);
  assert.equal(assembler.lastTransfer.milliseconds, 200);
  assert.equal(assembler.lastTransfer.kilobytesPerSecond, 20);
});

test("splitHttpResponse sépare tête et corps binaire", () => {
  const raw = new TextEncoder().encode("HTTP/1.1 302 Found\r\nLocation: /app/\r\n\r\ncorps");
  const { headText, bodyBytes } = splitHttpResponse(raw);
  assert.match(headText, /^HTTP\/1\.1 302 Found/);
  assert.equal(new TextDecoder().decode(bodyBytes), "corps");
  assert.throws(() => splitHttpResponse(new TextEncoder().encode("pas de separateur")));
});
