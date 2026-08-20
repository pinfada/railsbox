// Banc d'essai du VRAI public/sw-proxy.js, hors navigateur.
//
// POURQUOI PAS UNE COPIE DE LA LOGIQUE. Les décisions pures du worker vivent
// déjà dans shared/*.js et y sont testées. Ce qui reste dans sw-proxy.js est
// le CÂBLAGE — et c'est précisément là que se logent les défauts qu'aucun test
// unitaire de module pur ne peut voir : la condition de mise en cache écrite
// en ligne, l'ordre des opérations, la réponse effectivement rendue à v86.
// Réécrire cette condition dans un test la validerait contre elle-même.
//
// On installe donc un environnement de Service Worker minimal, on importe le
// fichier réel, on capture ses écouteurs, et on lui dispatche de faux
// événements. Ce qui est observé est ce que le worker fait vraiment.
//
// Chaque chargement est isolé : l'état du module (cache adopté, rétention en
// cours) ne doit pas fuir d'un test à l'autre.

let compteur = 0;

/**
 * Réponse en trompe-l'œil : un objet qui a la FORME d'une Response pour tout
 * ce que sw-proxy.js en lit. Nécessaire parce que `redirected` est un
 * accesseur en lecture seule sur une vraie Response — et que c'est justement
 * la propriété dont dépend l'empoisonnement du cache par une page de connexion
 * servie derrière une redirection.
 * @param {{ status?: number, type?: string, redirected?: boolean, headers?: Record<string, string>, body?: string }} forme
 */
export function reponseFactice({
  status = 200,
  type = "basic",
  redirected = false,
  headers = {},
  body = "octets",
} = {}) {
  const entetes = new Headers(headers);
  const faire = () => ({
    status,
    statusText: "",
    type,
    redirected,
    ok: status >= 200 && status < 300,
    headers: entetes,
    body: null,
    bodyUsed: false,
    clone: () => faire(),
    text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  });
  return faire();
}

/**
 * Charge une instance neuve du Service Worker.
 * @param {{ scope?: string, repondre: (request: Request) => any }} options
 *   `repondre` est le `fetch` truqué : il reçoit la requête réelle du worker.
 */
export async function chargerWorker({ scope = "http://localhost/", repondre }) {
  /** @type {Map<string, Function[]>} */
  const ecouteurs = new Map();
  /** @type {Array<{ nom: string, url: string, corps: any }>} */
  const misEnCache = [];
  /** @type {Array<{ url: string, message: any }>} */
  const messagesAuxClients = [];
  // Messages reçus sur le CANAL PRIVÉ. C'est là que passe désormais tout ce
  // que le worker dit à la coquille ; le canal public ne porte plus que la
  // demande de rétablir le canal.
  /** @type {any[]} */
  const messagesAuCanal = [];
  /** @type {any} */
  let canal = null;
  /** @type {Promise<any>[]} */
  const differes = [];
  /** @type {Request[]} */
  const requetesReseau = [];
  /** @type {any[]} */
  let clients = [];

  const entrees = new Map(); // "nom\u0000url" -> corps

  const cacheFactice = (nom) => ({
    match: async (url) => entrees.get(`${nom}\u0000${url}`) ?? undefined,
    put: async (url, reponse) => {
      entrees.set(`${nom}\u0000${url}`, reponse);
      misEnCache.push({ nom, url: String(url), corps: reponse });
    },
    delete: async () => true,
  });

  const precedents = {};
  const poser = (nom, valeur) => {
    precedents[nom] = /** @type {any} */ (globalThis)[nom];
    /** @type {any} */ (globalThis)[nom] = valeur;
  };

  // Le plafond de rétention est une minuterie de DIX MINUTES, armée dès qu'une
  // lecture est retenue. Un test qui laisse volontairement une lecture en
  // suspens (c'est le comportement même qu'il éprouve) tiendrait donc la
  // boucle d'événements de Node éveillée jusqu'au bout. On garde la trace de
  // toutes les minuteries armées pendant la vie du banc pour les couper à la
  // fermeture — sans quoi la suite ne se termine jamais.
  const vraiSetTimeout = globalThis.setTimeout;
  /** @type {any[]} */
  const minuteries = [];
  poser("setTimeout", (fn, ms, ...reste) => {
    const id = vraiSetTimeout(fn, ms, ...reste);
    minuteries.push(id);
    return id;
  });

  poser("self", {
    registration: { scope },
    location: new URL(scope),
    skipWaiting: () => {},
    addEventListener: (nom, fn) => {
      if (!ecouteurs.has(nom)) ecouteurs.set(nom, []);
      ecouteurs.get(nom).push(fn);
    },
    clients: {
      claim: async () => {},
      matchAll: async () => clients,
      // Le worker s'en sert pour savoir si le porteur du canal vit encore :
      // tant qu'il vit, aucun second canal n'est adopté.
      get: async (id) => clients.find((client) => client.id === id),
    },
  });
  poser("caches", {
    open: async (nom) => cacheFactice(nom),
    keys: async () => [],
    delete: async () => true,
  });
  poser("fetch", async (request) => {
    requetesReseau.push(request);
    return repondre(request);
  });
  poser("indexedDB", {
    open: () => {
      throw new Error("IndexedDB non simulée : hors du chemin des artefacts");
    },
  });

  // Cache-busting : chaque chargement doit repartir d'un état de module vierge.
  compteur += 1;
  const module = new URL(`../public/sw-proxy.js?essai=${compteur}`, import.meta.url).href;
  await import(module);

  /** @param {string} nom @param {any} evenement */
  const dispatcher = (nom, evenement) => {
    for (const fn of ecouteurs.get(nom) ?? []) fn(evenement);
  };

  return {
    /**
     * Demande au worker d'ouvrir un TOUR de rétablissement, et rend les nonces
     * qu'il a adressés à chaque client. C'est ce que fait `demanderCanal()`
     * dans main.js.
     * @param {{ url?: string, id?: string }} [client] émetteur de la demande
     * @returns {Promise<Array<{ url: string, nonce: string }>>}
     */
    async ouvrirTour({ url = `${scope}index.html`, id = "coquille-1" } = {}) {
      const avant = messagesAuxClients.length;
      /** @type {Promise<any>[]} */
      const attentes = [];
      dispatcher("message", {
        data: { type: "coquille-canal-demande" },
        source: { url, id },
        ports: [],
        waitUntil: (p) => attentes.push(p),
      });
      await Promise.all(attentes);
      return messagesAuxClients
        .slice(avant)
        .filter((envoi) => envoi.message?.type === "coquille-canal-request")
        .map((envoi) => ({ url: envoi.url, nonce: envoi.message.nonce }));
    },

    /**
     * RÉPOND à un tour, avec un nonce. Le port est un objet à nous : les
     * `MessagePort` de Node ne remplissent pas `event.ports`, dont le
     * transfert du pont a besoin.
     * @param {{ nonce?: string, url?: string, id?: string }} reponse
     */
    async repondreAuTour({ nonce, url = `${scope}index.html`, id = "coquille-1" } = {}) {
      const port = {
        onmessage: null,
        start() {},
        postMessage: (message) => messagesAuCanal.push(message),
      };
      /** @type {Promise<any>[]} */
      const attentes = [];
      dispatcher("message", {
        data: { type: "coquille-canal", nonce },
        source: { url, id },
        ports: [port],
        waitUntil: (p) => attentes.push(p),
      });
      await Promise.all(attentes);
      // Adopté seulement si le worker a bien branché son écouteur : un canal
      // refusé laisse le port muet, et le banc doit le dire plutôt que de
      // prêter au test un canal qui n'existe pas.
      if (typeof port.onmessage !== "function") return null;
      canal = port;
      return port;
    },

    /**
     * Le tour complet, comme au démarrage d'une coquille : demander, puis
     * répondre au nonce qui nous est adressé.
     * @param {{ url?: string, id?: string }} [client]
     */
    async etablirCanal({ url = `${scope}index.html`, id = "coquille-1" } = {}) {
      const tour = await this.ouvrirTour({ url, id });
      const pour = tour.find((demande) => demande.url === url);
      if (!pour) return null;
      return this.repondreAuTour({ nonce: pour.nonce, url, id });
    },

    /**
     * Commande le proxy PAR LE CANAL PRIVÉ, comme le fait main.js.
     * @param {Record<string, any>} data
     * @param {any[]} [ports]
     */
    async commander(data, ports = []) {
      if (!canal) throw new Error("aucun canal privé établi");
      // `traiterCommande` rend la promesse d'adoption pour `artifact-config` :
      // sans elle, un test ne saurait pas quand la configuration a pris.
      await canal.onmessage({ data, ports });
    },

    /**
     * Déclare la configuration d'artefacts comme le fait main.js.
     * @param {Record<string, any>} config
     */
    async declarerConfig(config) {
      if (!canal) await this.etablirCanal();
      await this.commander({ type: "artifact-config", config });
    },

    /**
     * Envoie un message sur le CANAL PUBLIC. Ne sert plus qu'à éprouver le
     * refus : c'est exactement ce que fait un script injecté dans la coquille.
     * @param {Record<string, any>} data
     * @param {string} [url] URL du client émetteur
     */
    envoyerMessage(data, url = `${scope}index.html`) {
      dispatcher("message", {
        data,
        source: { url, id: "intrus" },
        ports: [],
        waitUntil: () => {},
      });
    },

    /**
     * Dispatche une requête. Rend la promesse passée à `respondWith`, ou null
     * si le worker a laissé la requête au navigateur.
     * @param {string} url
     * @returns {Promise<any> | null}
     */
    requeter(url) {
      let rendue = null;
      dispatcher("fetch", {
        request: new Request(url),
        respondWith: (promesse) => {
          rendue = promesse;
        },
        waitUntil: (promesse) => differes.push(Promise.resolve(promesse).catch(() => {})),
      });
      return rendue;
    },

    /** Attend les écritures différées (`waitUntil`) déjà programmées. */
    async viderDifferes() {
      // Deux tours : `storeArtifact` est programmé depuis une continuation.
      await Promise.resolve();
      await Promise.all(differes.splice(0));
      await Promise.resolve();
      await Promise.all(differes.splice(0));
    },

    /** @param {Array<{ url: string, id?: string }>} liste */
    poserClients(liste) {
      clients = liste.map((client) => ({
        ...client,
        postMessage: (message) => messagesAuxClients.push({ url: client.url, message }),
      }));
    },

    misEnCache,
    messagesAuxClients,
    messagesAuCanal,
    requetesReseau,

    /** Coupe les minuteries en cours et rend les globales à leur état d'avant. */
    fermer() {
      for (const id of minuteries.splice(0)) clearTimeout(id);
      for (const [nom, valeur] of Object.entries(precedents)) {
        if (valeur === undefined) delete (/** @type {any} */ (globalThis)[nom]);
        else /** @type {any} */ (globalThis)[nom] = valeur;
      }
    },
  };
}

/** Configuration minimale décrivant un disque découpé, servi par le scope. */
export function configFactice(scope = "http://localhost/") {
  return {
    name: "essai",
    baseName: "essai-base",
    builtAt: "2026-08-18T00:00:00Z",
    disk: `${scope}disks/essai.ext2.zst`,
    diskSize: 4_194_304,
    diskChunkSize: 4_194_304,
  };
}

/** URL du premier morceau du disque de {@link configFactice}. */
export function urlMorceau(scope = "http://localhost/") {
  return `${scope}disks/essai-0-4194304.ext2.zst`;
}
