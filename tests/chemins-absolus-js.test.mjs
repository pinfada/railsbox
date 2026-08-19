// Incident mesuré en réel : une application publiée s'affichait parfaitement,
// et un clic sur un bouton cassait la page. Ses contrôleurs Stimulus appelaient
// `fetch("/api/likes")` — un chemin absolu depuis la racine du DOMAINE, alors
// que la sandbox monte l'application sous `/<depot>/app/`. La requête partait
// donc sur `https://<compte>.github.io/api/likes`, hors du périmètre proxifié
// par le Service Worker : GitHub Pages répondait par sa page 404, l'iframe la
// chargeait, et le contexte devenu étranger cassait tout.
//
// AUCUN test GET n'attrape ça : la page s'affiche, tout semble marcher, seule
// une interaction d'écriture révèle la panne. D'où une détection statique.
//
// La moitié de cette suite porte sur les FAUX POSITIFS. Un diagnostic qui crie
// sur `fetch("https://…")` ou sur `fetch(prefix + "/api")` serait ignoré au
// deuxième rapport, et le vrai cas passerait avec lui.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  APPELS_RESEAU,
  absolutePathFindings,
  scanAbsolutePaths,
} from "../tools/detect/chemins-absolus-js.mjs";
import { detectApp } from "../tools/detect/detect.mjs";
import { REMEDIES } from "../tools/detect/report.mjs";

/**
 * Raccourci : les chemins relevés dans un source unique.
 * @param {string} text contenu du fichier JavaScript
 * @param {string} [name] nom affiché du fichier
 * @returns {string[]} chemins absolus trouvés, dans l'ordre du fichier
 */
function chemins(text, name = "app/javascript/controllers/test_controller.js") {
  return scanAbsolutePaths([{ name, text }]).map((occurrence) => occurrence.path);
}

// --- Le cas fondateur ------------------------------------------------------

test('fetch("/api/likes") est relevé — le cas qui a cassé une sandbox publiée', () => {
  assert.deepEqual(chemins('fetch("/api/likes", { method: "POST" })'), ["/api/likes"]);
});

test("les trois formes de guillemets sont couvertes", () => {
  assert.deepEqual(chemins("fetch('/api/likes')"), ["/api/likes"]);
  assert.deepEqual(chemins('fetch("/api/likes")'), ["/api/likes"]);
  assert.deepEqual(chemins("fetch(`/api/likes`)"), ["/api/likes"]);
});

test("un gabarit interpolé APRÈS la barre initiale reste un chemin absolu", () => {
  // `/api/likes/${id}` sort du site exactement comme `/api/likes` : c'est le
  // PREMIER caractère qui décide, pas le reste.
  assert.deepEqual(chemins("fetch(`/api/likes/${id}`)"), ["/api/likes/${id}"]);
});

test("window.fetch est reconnu comme fetch", () => {
  assert.deepEqual(chemins('window.fetch("/api/likes")'), ["/api/likes"]);
});

// --- Les autres clients ----------------------------------------------------

test("axios.get et axios.post sont relevés", () => {
  assert.deepEqual(chemins('axios.get("/api/v1/posts")'), ["/api/v1/posts"]);
  assert.deepEqual(chemins('axios.post("/api/v1/posts", corps)'), ["/api/v1/posts"]);
});

test("axios.create({ baseURL }) est relevé — le cas nommé par le README", () => {
  assert.deepEqual(chemins('const api = axios.create({ baseURL: "/api/v1" })'), ["/api/v1"]);
});

test("EventSource et WebSocket sont signalés", () => {
  assert.deepEqual(chemins('new EventSource("/events")'), ["/events"]);
  assert.deepEqual(chemins('new WebSocket("/cable")'), ["/cable"]);
});

test("le message dit que les WebSockets sont hors périmètre railsbox", () => {
  // Information utile en soi : le pont série ne transporte que du HTTP, une
  // WebSocket ne fonctionnera pas dans la sandbox même bien préfixée.
  const findings = absolutePathFindings(
    scanAbsolutePaths([{ name: "app/javascript/cable.js", text: 'new WebSocket("/cable")' }]),
  );
  assert.match(findings[0].message, /WebSocket/);
});

test("XMLHttpRequest.open(methode, chemin) est relevé", () => {
  const source = 'const xhr = new XMLHttpRequest();\nxhr.open("POST", "/api/likes");';
  assert.deepEqual(chemins(source), ["/api/likes"]);
});

test("un .open() dans un fichier sans XMLHttpRequest est ignoré", () => {
  // `.open` est un nom de méthode banal (dialogue, tiroir, connexion) : sans la
  // mention de XMLHttpRequest dans le fichier, la reconnaissance serait un
  // générateur de bruit.
  assert.deepEqual(chemins('tiroir.open("gauche", "/menu/principal")'), []);
});

// --- Faux positifs : ce que la détection NE DOIT PAS dire ------------------

test("une URL absolue avec protocole n'est pas un chemin de site", () => {
  assert.deepEqual(chemins('fetch("https://exemple.test/api/likes")'), []);
  assert.deepEqual(chemins("fetch('http://exemple.test/api')"), []);
});

test("une URL protocol-relative (« //cdn… ») n'est pas un chemin de site", () => {
  assert.deepEqual(chemins('fetch("//cdn.exemple.test/lib.js")'), []);
  assert.deepEqual(chemins("fetch(`//cdn.exemple.test/lib.js`)"), []);
});

test("un chemin déjà préfixé par une variable est CORRECT et se tait", () => {
  assert.deepEqual(chemins('fetch(prefix + "/api/likes")'), []);
  assert.deepEqual(chemins("fetch(`${racine}/api/likes`)"), []);
  assert.deepEqual(chemins('axios.get(getMountPrefix() + "/api/v1/posts")'), []);
  assert.deepEqual(chemins("axios.create({ baseURL: `${prefixe}/api/v1` })"), []);
});

test("un appel commenté ne compte pas", () => {
  assert.deepEqual(chemins('// fetch("/api/likes")'), []);
  assert.deepEqual(chemins('/* fetch("/api/likes") */'), []);
  assert.deepEqual(chemins('/**\n * Exemple : fetch("/api/likes")\n */'), []);
});

test("le retrait des commentaires ne se laisse pas piéger par un « // » de chaîne", () => {
  // Un scanner naïf couperait la ligne au « // » de « https:// » et perdrait
  // tout ce qui suit dans le fichier — y compris le vrai chemin absolu.
  const source = 'const cdn = "https://exemple.test/lib.js";\nfetch("/api/likes");';
  assert.deepEqual(chemins(source), ["/api/likes"]);
});

test("une chaîne qui n'est pas un appel réseau ne compte pas", () => {
  assert.deepEqual(chemins('const message = "/api/likes n\'est pas préfixé";'), []);
  assert.deepEqual(chemins('const chemins = ["/a", "/b"];'), []);
});

test("une méthode .fetch() d'un objet quelconque n'est pas le fetch du navigateur", () => {
  assert.deepEqual(chemins('depot.fetch("/api/likes")'), []);
});

test("un chemin relatif ne sort pas du site et ne dit rien", () => {
  assert.deepEqual(chemins('fetch("api/likes")'), []);
  assert.deepEqual(chemins('fetch("./api/likes")'), []);
});

// --- Le diagnostic ---------------------------------------------------------

test("le diagnostic porte le code stable et la sévérité AVERTISSEMENT", () => {
  const findings = absolutePathFindings(
    scanAbsolutePaths([{ name: "app/javascript/a.js", text: 'fetch("/api/likes")' }]),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "chemin-absolu-javascript");
  assert.equal(findings[0].severity, "warning");
});

test("le diagnostic n'est JAMAIS un refus", () => {
  // L'application peut être montée à la racine chez elle, et une analyse
  // statique ne peut pas prouver que le chemin sera appelé.
  const findings = absolutePathFindings(
    scanAbsolutePaths([{ name: "app/javascript/a.js", text: 'fetch("/api/likes")' }]),
  );
  assert.notEqual(findings[0].severity, "blocking");
});

test("un seul diagnostic, quel que soit le nombre d'appels", () => {
  const text = 'fetch("/a")\nfetch("/b")\naxios.get("/c")';
  const findings = absolutePathFindings(scanAbsolutePaths([{ name: "app/javascript/a.js", text }]));
  assert.equal(findings.length, 1, "un seul diagnostic, pas un par appel");
});

test("le diagnostic nomme le fichier et la ligne", () => {
  const text = 'const a = 1;\n\nfetch("/api/likes");';
  const [occurrence] = scanAbsolutePaths([{ name: "app/javascript/likes.js", text }]);
  assert.equal(occurrence.file, "app/javascript/likes.js");
  assert.equal(occurrence.line, 3);
  const findings = absolutePathFindings([occurrence]);
  assert.match(findings[0].message, /app\/javascript\/likes\.js:3/);
});

test("la liste est plafonnée et annonce le reste par un compte", () => {
  const text = Array.from({ length: 14 }, (_, i) => `fetch("/api/${i}")`).join("\n");
  const occurrences = scanAbsolutePaths([{ name: "app/javascript/a.js", text }]);
  assert.equal(occurrences.length, 14);
  const [finding] = absolutePathFindings(occurrences);
  assert.match(finding.message, /et 4 autres/);
  assert.ok(
    !finding.message.includes("/api/10"),
    "les appels au-delà du plafond ne sont pas listés",
  );
});

test("aucun fichier, aucun appel : aucun diagnostic", () => {
  assert.deepEqual(scanAbsolutePaths([]), []);
  assert.deepEqual(scanAbsolutePaths(undefined), []);
  assert.deepEqual(absolutePathFindings([]), []);
});

test("le catalogue des appels est exporté, pour que doc et tests s'y réfèrent", () => {
  assert.ok(Array.isArray(APPELS_RESEAU));
  assert.ok(APPELS_RESEAU.some((appel) => appel.nom === "fetch()"));
  for (const appel of APPELS_RESEAU) assert.equal(typeof appel.nom, "string");
});

test("le code du diagnostic porte un remède", () => {
  const remede = REMEDIES["chemin-absolu-javascript"];
  assert.equal(typeof remede, "string");
  assert.match(remede, /relative_url_root/);
});

// --- Branchement dans la détection -----------------------------------------

const dossiersCrees = [];

/**
 * Crée une application factice dans un dossier temporaire.
 * @param {Record<string, string>} files chemins relatifs vers contenus
 * @returns {Promise<string>} racine du dossier créé
 */
async function creerApp(files) {
  const dir = await mkdtemp(join(tmpdir(), "railsbox-chemins-"));
  dossiersCrees.push(dir);
  for (const [relatif, contenu] of Object.entries(files)) {
    const cible = join(dir, relatif);
    await mkdir(dirname(cible), { recursive: true });
    await writeFile(cible, contenu, "utf8");
  }
  return dir;
}

after(async () => {
  await Promise.all(dossiersCrees.map((dir) => rm(dir, { recursive: true, force: true })));
});

test("detectApp lit app/javascript et remonte le diagnostic", async () => {
  const dir = await creerApp({
    Gemfile: 'gem "rails"\n',
    "app/javascript/controllers/likes_controller.js": 'fetch("/api/likes", { method: "POST" })\n',
  });
  const { findings } = await detectApp(dir);
  const trouve = findings.find((finding) => finding.code === "chemin-absolu-javascript");
  assert.ok(trouve, "le diagnostic doit remonter jusqu'au rapport");
  assert.match(trouve.message, /likes_controller\.js/);
});

test("detectApp lit aussi app/assets/javascripts", async () => {
  const dir = await creerApp({
    Gemfile: 'gem "rails"\n',
    "app/assets/javascripts/legacy.js": 'axios.get("/api/v1/posts")\n',
  });
  const { findings } = await detectApp(dir);
  assert.ok(findings.some((finding) => finding.code === "chemin-absolu-javascript"));
});

test("node_modules et vendor ne sont jamais parcourus", async () => {
  const dir = await creerApp({
    Gemfile: 'gem "rails"\n',
    "app/javascript/node_modules/paquet/index.js": 'fetch("/api/tiers")\n',
    "app/javascript/vendor/lib.js": 'fetch("/api/vendorise")\n',
  });
  const { findings } = await detectApp(dir);
  assert.equal(
    findings.filter((finding) => finding.code === "chemin-absolu-javascript").length,
    0,
    "les dépendances tierces ne regardent pas l'auteur de l'application",
  );
});

test("une application sans JavaScript ne déclenche rien", async () => {
  const dir = await creerApp({ Gemfile: 'gem "rails"\n' });
  const { findings } = await detectApp(dir);
  assert.equal(findings.filter((finding) => finding.code === "chemin-absolu-javascript").length, 0);
});
