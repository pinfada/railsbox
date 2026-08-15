// Mesure le coût du chemin chaud du pont série : v86 émet UN événement JS par
// octet, donc l'assembleur doit rester O(1) sans allocation par octet.
//   node tools/bench-serial.mjs
import { bytesToBase64, createLineAssembler, createResponseAssembler } from "../public/shared/serial-codec.js";

const ASSET_BYTES = 270 * 1024; // CSS tailwind compilé de jiyufit
const CHUNK = 8000; // taille des tranches DAT côté démon

const payload = bytesToBase64(new Uint8Array(ASSET_BYTES).map((_, index) => index % 251));
const frames = [`@RIB1 RSB 1 ${payload.length}`];
for (let offset = 0; offset < payload.length; offset += CHUNK) {
  frames.push(`@RIB1 DAT 1 ${payload.slice(offset, offset + CHUNK)}`);
}
frames.push("@RIB1 END 1");
const wire = new TextEncoder().encode(`${frames.join("\n")}\n`);

let decodedBytes = 0;
const responses = createResponseAssembler({
  onResponse: (_id, bytes) => {
    decodedBytes = bytes.length;
  },
  onError: () => {},
  onLog: () => {},
});
const lines = createLineAssembler((line) => responses.handleLine(line));

const startedAt = performance.now();
for (const byte of wire) {
  lines.feedByte(byte);
}
const elapsed = performance.now() - startedAt;

console.log(`asset            : ${ASSET_BYTES / 1024} Ko`);
console.log(`octets sur le fil: ${wire.length} (base64 + trames)`);
console.log(`événements JS    : ${lines.stats.bytes} (un par octet, imposé par v86)`);
console.log(`décodé           : ${decodedBytes} octets`);
console.log(`temps assembleur : ${elapsed.toFixed(1)} ms`);
console.log(`débit            : ${Math.round(wire.length / 1024 / (elapsed / 1000))} Ko/s côté JS`);
console.log(`coût par octet   : ${((elapsed * 1e6) / wire.length).toFixed(0)} ns`);
