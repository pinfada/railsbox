// Panneau « Inspecteur d'environnement » : transforme un échec de démarrage
// en étape d'installation guidée. Les variables manquantes sont détectées
// dans les logs de l'application (voir shared/env-detector.js), remplies en
// un clic pour les secrets internes, saisies pour les services tiers, puis
// injectées dans la VM qui relance l'application — sans reconstruire l'image.
const CLE_STOCKAGE = "rib-env-overrides";

export function createEnvironmentDrawer({ registry, onApply, onLog = () => {} }) {
  const elements = buildStructure();
  document.body.append(elements.voile, elements.panneau);

  let occupe = false;

  hydrateFromStorage(registry);

  elements.declencheur.addEventListener("click", () => basculer(true));
  elements.fermer.addEventListener("click", () => basculer(false));
  elements.voile.addEventListener("click", () => basculer(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && elements.panneau.dataset.ouvert === "oui") basculer(false);
  });

  elements.boutonMocks.addEventListener("click", () => {
    const remplies = registry.fillMocks();
    persist(registry);
    rendre();
    annoncer(
      remplies === 0
        ? "Rien à générer : les secrets internes ont déjà une valeur."
        : `${remplies} valeur${remplies > 1 ? "s" : ""} générée${remplies > 1 ? "s" : ""} au format attendu.`,
      remplies === 0 ? "neutre" : "succes",
    );
  });

  elements.boutonAppliquer.addEventListener("click", async () => {
    const charge = registry.toPayload();
    if (Object.keys(charge).length === 0) {
      annoncer("Aucune valeur à appliquer : renseignez au moins une variable.", "erreur");
      return;
    }
    definirOccupe(true);
    annoncer("Écriture de l'environnement puis redémarrage de l'application…", "neutre");
    try {
      await onApply(charge);
      persist(registry);
      annoncer("Application redémarrée avec les nouvelles variables.", "succes");
      rendre();
    } catch (error) {
      annoncer(`Échec : ${error.message}`, "erreur");
    } finally {
      definirOccupe(false);
    }
  });

  function basculer(ouvrir) {
    elements.panneau.dataset.ouvert = ouvrir ? "oui" : "non";
    elements.voile.dataset.ouvert = ouvrir ? "oui" : "non";
    elements.panneau.setAttribute("aria-hidden", ouvrir ? "false" : "true");
    if (ouvrir) {
      rendre();
      elements.fermer.focus();
    } else {
      elements.declencheur.focus();
    }
  }

  function definirOccupe(valeur) {
    occupe = valeur;
    elements.boutonAppliquer.disabled = valeur;
    elements.boutonMocks.disabled = valeur;
    elements.boutonAppliquer.textContent = valeur ? "Redémarrage en cours…" : "Appliquer et redémarrer";
  }

  function annoncer(message, ton = "neutre") {
    elements.etat.textContent = message;
    elements.etat.dataset.ton = ton;
    if (ton !== "neutre") onLog(`[env] ${message}`);
  }

  function rendre() {
    const variables = registry.list();
    // « Bloquante » se juge sur la gravité du message, pas sur la famille :
    // une variable citée dans un simple avertissement laisse l'application
    // démarrer, seule la fonctionnalité associée reste inactive.
    const bloquantes = variables.filter((v) => v.value === "" && v.gravite === "critique").length;
    const facultatives = variables.filter((v) => v.value === "" && v.gravite !== "critique").length;
    const pretes = variables.filter((v) => v.value !== "").length;

    elements.compteBloquantes.textContent = String(bloquantes);
    elements.compteFacultatives.textContent = String(facultatives);
    elements.comptePretes.textContent = String(pretes);
    elements.declencheur.dataset.alerte = bloquantes > 0 ? "oui" : "non";
    elements.badge.textContent = String(variables.length);
    elements.badge.hidden = variables.length === 0;

    elements.corps.replaceChildren();
    if (variables.length === 0) {
      const vide = document.createElement("p");
      vide.className = "env-vide";
      vide.textContent =
        "Aucune variable manquante détectée. Ce panneau se remplit tout seul si l'application signale une configuration incomplète.";
      elements.corps.append(vide);
      return;
    }

    const explication = document.createElement("p");
    explication.className = "env-explication";
    explication.textContent =
      "Détecté dans les journaux de démarrage. Les secrets internes acceptent une valeur générée ; les services tiers exigent vos identifiants, sans quoi la fonctionnalité correspondante reste inactive.";
    elements.corps.append(explication);

    for (const variable of variables) {
      elements.corps.append(construireLigne(variable));
    }
  }

  function construireLigne(variable) {
    const etat =
      variable.value !== "" ? "prete" : variable.gravite === "critique" ? "critique" : "externe";
    const ligne = document.createElement("article");
    ligne.className = "env-variable";
    ligne.dataset.etat = etat;

    const entete = document.createElement("header");
    const nom = document.createElement("span");
    nom.className = "env-nom";
    nom.textContent = variable.name;
    const pastille = document.createElement("span");
    pastille.className = "env-pastille";
    pastille.textContent =
      etat === "prete" ? "prête" : etat === "critique" ? "bloque le démarrage" : "fonctionnalité inactive";
    const famille = document.createElement("span");
    famille.className = "env-famille";
    famille.textContent = variable.label;
    entete.append(nom, pastille, famille);

    const saisie = document.createElement("div");
    saisie.className = "env-saisie";
    const champ = document.createElement("input");
    champ.type = "text";
    champ.spellcheck = false;
    champ.autocomplete = "off";
    champ.value = variable.value;
    champ.setAttribute("aria-label", `Valeur de ${variable.name}`);
    champ.placeholder = variable.mockable ? "valeur générée ou saisie" : "identifiant fourni par le service";
    champ.addEventListener("input", () => {
      registry.setValue(variable.name, champ.value.trim());
      persist(registry);
    });
    champ.addEventListener("change", rendre);
    saisie.append(champ);

    if (variable.mockable) {
      const generer = document.createElement("button");
      generer.type = "button";
      generer.className = "env-bouton-ligne";
      generer.textContent = "Générer";
      generer.addEventListener("click", () => {
        registry.setValue(variable.name, variable.generate());
        persist(registry);
        rendre();
      });
      saisie.append(generer);
    }

    ligne.append(entete, saisie);

    if (variable.source && variable.source !== "ajout manuel") {
      const source = document.createElement("p");
      source.className = "env-source";
      source.textContent = variable.source;
      ligne.append(source);
    }
    return ligne;
  }

  return {
    element: elements.declencheur,
    // Appelé pour chaque ligne de journal : ouvre le panneau à la première
    // variable réellement bloquante, pour que l'utilisateur voie le problème
    // sans avoir à lire les logs. Un simple avertissement ne l'interrompt pas.
    ingest(line) {
      const nouveaux = registry.ingestLogLine(line);
      if (nouveaux.length === 0) return [];
      rendre();
      const bloquant = registry
        .list()
        .some((v) => nouveaux.includes(v.name) && v.gravite === "critique" && v.value === "");
      if (bloquant && !occupe && elements.panneau.dataset.ouvert !== "oui") {
        basculer(true);
      }
      return nouveaux;
    },
    open: () => basculer(true),
    refresh: rendre,
    annoncer,
  };
}

function buildStructure() {
  const declencheur = document.createElement("button");
  declencheur.type = "button";
  declencheur.className = "env-declencheur";
  declencheur.dataset.alerte = "non";
  const badge = document.createElement("span");
  badge.className = "compte";
  badge.hidden = true;
  declencheur.append(document.createTextNode("Environnement"), badge);

  const voile = document.createElement("div");
  voile.className = "env-voile";
  voile.dataset.ouvert = "non";

  const panneau = document.createElement("aside");
  panneau.className = "env-panneau";
  panneau.dataset.ouvert = "non";
  panneau.setAttribute("aria-label", "Inspecteur d'environnement");
  panneau.setAttribute("aria-hidden", "true");
  panneau.innerHTML = `
    <div class="env-entete">
      <h2>Inspecteur d'environnement</h2>
      <button type="button" class="env-fermer" aria-label="Fermer le panneau">✕</button>
    </div>
    <div class="env-resume">
      <div class="bloquantes"><span class="valeur">0</span><span class="libelle">bloquent le boot</span></div>
      <div class="facultatives"><span class="valeur">0</span><span class="libelle">non bloquantes</span></div>
      <div class="pretes"><span class="valeur">0</span><span class="libelle">prêtes</span></div>
    </div>
    <div class="env-corps"></div>
    <div class="env-pied">
      <div class="env-actions">
        <button type="button" class="env-action env-action--mocks">Générer les valeurs internes</button>
        <button type="button" class="env-action env-action--primaire">Appliquer et redémarrer</button>
      </div>
      <p class="env-etat" data-ton="neutre" role="status"></p>
    </div>`;

  return {
    declencheur,
    badge,
    voile,
    panneau,
    fermer: panneau.querySelector(".env-fermer"),
    corps: panneau.querySelector(".env-corps"),
    etat: panneau.querySelector(".env-etat"),
    boutonMocks: panneau.querySelector(".env-action--mocks"),
    boutonAppliquer: panneau.querySelector(".env-action--primaire"),
    compteBloquantes: panneau.querySelector(".bloquantes .valeur"),
    compteFacultatives: panneau.querySelector(".facultatives .valeur"),
    comptePretes: panneau.querySelector(".pretes .valeur"),
  };
}

// Les valeurs saisies survivent au rechargement : sans cela, chaque reprise
// d'instantané obligerait à tout ressaisir. Stockage local uniquement.
function persist(registry) {
  try {
    localStorage.setItem(CLE_STOCKAGE, JSON.stringify(registry.toPayload()));
  } catch {
    // quota ou mode restreint : la perte de confort ne doit rien casser
  }
}

function hydrateFromStorage(registry) {
  try {
    registry.hydrate(JSON.parse(localStorage.getItem(CLE_STOCKAGE) ?? "{}"));
  } catch {
    // contenu illisible : on repart d'un registre vide
  }
}
