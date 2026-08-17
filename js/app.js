// --- Navigation entre les onglets ---
const tabs = document.querySelectorAll(".tab-btn");
const views = document.querySelectorAll(".view");

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    const name = tab.dataset.view;
    tabs.forEach((t) => t.classList.toggle("active", t === tab));
    views.forEach((v) => v.classList.toggle("active", v.id === "view-" + name));
    if (name === "clients") loadClients();
    if (name === "reglages") loadReglages();
    if (name === "semaine") loadSemaine();
  });
});

// --- Date du jour ---
const todayLabel = document.getElementById("today-label");
const jours = ["dimanche","lundi","mardi","mercredi","jeudi","vendredi","samedi"];
const mois = ["janvier","février","mars","avril","mai","juin","juillet","août","septembre","octobre","novembre","décembre"];
function formatDate(d) {
  return `${jours[d.getDay()]} ${d.getDate()} ${mois[d.getMonth()]}`;
}
todayLabel.textContent = formatDate(new Date());

// --- Pointage (Phase 4 : GPS, trajets reels, lieu inconnu) ---
const chronoTime = document.getElementById("chrono-time");
const chronoSub = document.getElementById("chrono-sub");
const statusBadge = document.getElementById("status-badge");
const btnPunch = document.getElementById("btn-punch");
const punchFlowEl = document.getElementById("punch-flow");
const stopsListEl = document.getElementById("stops-list");
const syncBadge = document.getElementById("sync-badge");

// --- Indicateur "hors ligne / en attente de synchronisation" ---------------
Offline.onChange(({ pending, online, syncing }) => {
  if (!online) {
    syncBadge.style.display = "";
    syncBadge.textContent = pending ? `Hors ligne · ${pending} en attente` : "Hors ligne";
  } else if (pending > 0) {
    syncBadge.style.display = "";
    syncBadge.textContent = syncing ? "Synchronisation…" : `${pending} en attente de synchronisation`;
  } else {
    syncBadge.style.display = "none";
  }
});
window.addEventListener("online", () => Offline.notify());
window.addEventListener("offline", () => Offline.notify());

let jourState = {
  status: "not_started",
  clientId: null,
  clientNom: null,
  dureeHeures: null,
  trajetMinutes: null,
  dureeBaseMinutes: null,
};
let mainStartedAt = null;
let subStartedAt = null;
let mainTickHandle = null;
let subTickHandle = null;
// Horodatage du dernier depart (de l'entrepot ou d'un client) : point de reference
// pour mesurer le vrai temps de trajet vers le prochain arret.
let lastDepartAt = null;
// Mandat en attente de son trajet retour : au moment ou on quitte un client, on ne
// connait pas encore le temps pour se rendre au prochain arret (client suivant ou
// entrepot). On enregistre le mandat tout de suite avec une duree provisoire
// (trajet aller + travail, minimum 1h), puis on la complete avec le trajet retour
// des que le prochain arret est atteint.
let lastMandatId = null;
let lastMandatBaseMinutes = null;

function pad2(n) {
  return String(n).padStart(2, "0");
}

function fmtElapsed(startedAt) {
  if (!startedAt) return "00:00:00";
  const totalSec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

function renderMainChrono() {
  chronoTime.textContent = fmtElapsed(mainStartedAt);
}

function startMainTick() {
  if (mainTickHandle) clearInterval(mainTickHandle);
  mainTickHandle = setInterval(renderMainChrono, 1000);
  renderMainChrono();
}

function stopMainTick() {
  if (mainTickHandle) clearInterval(mainTickHandle);
  mainTickHandle = null;
  mainStartedAt = null;
  chronoTime.textContent = "00:00:00";
}

function startSubTick() {
  if (subTickHandle) clearInterval(subTickHandle);
  const tick = () => {
    const subEl = document.getElementById("sub-chrono");
    if (subEl) subEl.textContent = fmtElapsed(subStartedAt);
  };
  subTickHandle = setInterval(tick, 1000);
  tick();
}

function stopSubTick() {
  if (subTickHandle) clearInterval(subTickHandle);
  subTickHandle = null;
}

function getPosition() {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
    );
  });
}

// --- Ecriture des donnees : toujours "local d'abord" -----------------------
// Chaque action est enregistree immediatement dans IndexedDB (via Offline),
// avec un identifiant genere sur le telephone, puis mise en file d'attente
// pour etre envoyee des que possible. Ca marche exactement pareil que la
// connexion soit presente ou non : quand elle l'est, la synchronisation est
// quasi instantanee ; quand elle ne l'est pas, rien n'est perdu et tout se
// rattrape automatiquement au retour du reseau (voir js/offline.js).

async function queuePointage(type, clientId) {
  const pos = await getPosition();
  const uuid = Offline.uuid();
  const horodatage = new Date().toISOString();
  const payload = {
    uuid,
    type,
    client_id: clientId || null,
    latitude: pos ? pos.latitude : null,
    longitude: pos ? pos.longitude : null,
    horodatage,
  };
  await Offline.putPointage({
    uuid,
    id: null,
    type,
    client_id: clientId || null,
    horodatage,
    jour: toISODateLocal(new Date()),
    pending: true,
  });
  await Offline.enqueue("pointage", payload);
  Offline.sync();
  return { uuid, horodatage };
}

async function queueMandat(clientId, extra) {
  const uuid = Offline.uuid();
  const payload = {
    uuid,
    client_id: clientId,
    description: extra.description,
    duree_heures: extra.duree_heures,
    date: toISODateLocal(new Date()),
  };
  await Offline.enqueue("mandat", payload);
  Offline.sync();
  return { uuid };
}

async function queueClient(nom, adresse) {
  const uuid = Offline.uuid();
  const client = { uuid, nom, adresse: adresse || null };
  await Offline.putLocalClient(client);
  await Offline.enqueue("client", client);
  clientsCache = null;
  clientsLoaded = false;
  Offline.sync();
  return { id: Offline.localRef(uuid), uuid, nom, adresse: adresse || null };
}

// Complete la duree d'un mandat une fois le trajet retour connu (voir lastMandatId
// plus haut). Mise en file comme le reste : aucun appel reseau direct ici, donc
// aucun risque d'echec bruyant meme hors ligne — le mandat garde simplement sa
// duree provisoire jusqu'a la synchronisation.
async function completerTrajetRetour(minutesRetour) {
  if (lastMandatId == null) return;
  const mandatRef = lastMandatId;
  const totalMinutes = (lastMandatBaseMinutes || 0) + Math.max(0, minutesRetour);
  const dureeFinale = Math.round(Math.max(1, totalMinutes / 60) * 100) / 100;
  lastMandatId = null;
  lastMandatBaseMinutes = null;
  await Offline.enqueue("mandat-patch", { mandatRef, duree_heures: dureeFinale });
  Offline.sync();
}

function updatePunchButton() {
  if (jourState.status === "not_started") {
    btnPunch.style.display = "";
    btnPunch.textContent = "Départ de l'entrepôt";
    statusBadge.textContent = "Pas encore parti";
    chronoSub.textContent = "Le compteur démarre au moment où tu quittes l'entrepôt.";
  } else if (jourState.status === "en_route") {
    btnPunch.style.display = "";
    btnPunch.textContent = "Retour à l'entrepôt";
    statusBadge.textContent = "En route";
    chronoSub.textContent = "Choisis ta destination ci-dessous, ou termine ta journée.";
  } else {
    btnPunch.style.display = "none";
    statusBadge.textContent = "Chez un client";
  }
}

async function renderPunchFlow() {
  if (jourState.status === "not_started") {
    punchFlowEl.innerHTML = "";
    return;
  }

  if (jourState.status === "en_route") {
    const clients = await ensureClientsCache();
    const rows = clients
      .map(
        (c) => `
      <div class="picker-item" data-action="arrivee" data-client-id="${c.id}" data-client-nom="${escapeHtml(c.nom)}">
        <div>
          <div class="picker-item-name">${escapeHtml(c.nom)}</div>
          <div class="picker-item-sub">${escapeHtml(c.adresse || "")}</div>
        </div>
        <div class="picker-item-arrow">›</div>
      </div>`
      )
      .join("");
    punchFlowEl.innerHTML = `
      <div class="section-title">Où vas-tu?</div>
      <div class="card list-card">
        ${rows}
        <div class="picker-item unknown" data-action="lieu-inconnu">
          <div>
            <div class="picker-item-name">Lieu inconnu</div>
            <div class="picker-item-sub">Ce client n'est pas encore dans ta liste</div>
          </div>
          <div class="picker-item-arrow">›</div>
        </div>
      </div>
    `;
    return;
  }

  if (jourState.status === "lieu_inconnu_form") {
    punchFlowEl.innerHTML = `
      <div class="card" style="padding:16px;">
        <div class="section-title" style="margin-bottom:10px;">Nouveau client</div>
        <div class="inline-form">
          <div class="form-group">
            <label class="form-label" for="new-client-nom">Nom du client</label>
            <input class="form-input" id="new-client-nom" type="text" placeholder="Ex : Dépanneur Villeray">
          </div>
          <div class="form-group">
            <label class="form-label" for="new-client-adresse">Adresse</label>
            <input class="form-input" id="new-client-adresse" type="text" placeholder="Ex : 123 rue Principale">
          </div>
          <button class="btn btn-primary" data-action="creer-client">Créer et arriver</button>
          <button class="btn btn-secondary" data-action="annuler-lieu-inconnu">Annuler</button>
        </div>
      </div>
    `;
    return;
  }

  if (jourState.status === "chez_client") {
    punchFlowEl.innerHTML = `
      <div class="at-client-banner">
        <div class="at-client-banner-label">Présentement chez</div>
        <div class="at-client-banner-name">${escapeHtml(jourState.clientNom || "Client")}</div>
        <div class="at-client-banner-time" id="sub-chrono">00:00:00</div>
      </div>
      <button class="btn btn-primary" data-action="terminer-client">Terminer chez ${escapeHtml(
        jourState.clientNom || "ce client"
      )}</button>
    `;
    startSubTick();
    return;
  }

  if (jourState.status === "mandat_form") {
    punchFlowEl.innerHTML = `
      <div class="card" style="padding:16px;">
        <div class="section-title" style="margin-bottom:2px;">Résumé du mandat — ${escapeHtml(jourState.clientNom || "")}</div>
        <div class="chrono-sub" style="margin-bottom:10px;">Durée provisoire (trajet aller + travail, minimum 1 h) : ${heures(jourState.dureeHeures)}<br>Le trajet retour s'ajoutera automatiquement à ton prochain départ.</div>
        <div class="inline-form">
          <div class="form-group">
            <label class="form-label" for="mandat-desc">Description</label>
            <input class="form-input" id="mandat-desc" type="text" placeholder="Ex : Diagnostic fuite colonne montante">
          </div>
          <button class="btn btn-primary" data-action="enregistrer-mandat">Enregistrer le mandat</button>
          <button class="btn btn-secondary" data-action="passer-mandat">Passer</button>
        </div>
      </div>
    `;
    return;
  }
}

// --- Correction du journal : modifier ou supprimer un pointage deja enregistre ---
let editingPointageId = null;

const TYPES_POINTAGE = [
  { value: "depart_entrepot", label: "Départ de l'entrepôt" },
  { value: "arrivee_client", label: "Arrivée chez un client" },
  { value: "depart_client", label: "Départ de chez un client" },
  { value: "retour_entrepot", label: "Retour à l'entrepôt" },
];

function labelOfPointage(type) {
  return (TYPES_POINTAGE.find((t) => t.value === type) || {}).label || type;
}

function toTimeInputValue(horodatage) {
  const d = new Date(horodatage);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function renderPointageEditForm(p, clients) {
  const typeOptions = TYPES_POINTAGE.map(
    (t) => `<option value="${t.value}"${t.value === p.type ? " selected" : ""}>${t.label}</option>`
  ).join("");
  const clientOptions =
    `<option value="">— Aucun client —</option>` +
    clients
      .map(
        (c) =>
          `<option value="${c.id}"${
            String(c.id) === String(p.client_id) ? " selected" : ""
          }>${escapeHtml(c.nom)}</option>`
      )
      .join("");
  return `
    <div class="journal-item-edit" data-pointage-uuid="${p.uuid}" data-original-horodatage="${p.horodatage}">
      <div class="form-group">
        <label class="form-label">Type</label>
        <select class="form-select" data-field="type">${typeOptions}</select>
      </div>
      <div class="form-group">
        <label class="form-label">Client (si applicable)</label>
        <select class="form-select" data-field="client">${clientOptions}</select>
      </div>
      <div class="form-group">
        <label class="form-label">Heure</label>
        <input class="form-input" type="time" data-field="heure" value="${toTimeInputValue(p.horodatage)}">
      </div>
      <div class="journal-edit-actions">
        <button class="btn btn-primary" data-action="enregistrer-pointage">Enregistrer</button>
        <button class="btn btn-secondary" data-action="annuler-edit-pointage">Annuler</button>
        <button class="btn btn-danger" data-action="supprimer-pointage">Supprimer ce pointage</button>
      </div>
    </div>
  `;
}

function attachPointageEditHandlers() {
  const editEl = stopsListEl.querySelector(".journal-item-edit");
  if (!editEl) return;
  const uuidVal = editEl.dataset.pointageUuid;

  editEl.querySelector('[data-action="annuler-edit-pointage"]').addEventListener("click", () => {
    editingPointageId = null;
    refreshJournal();
  });

  editEl.querySelector('[data-action="enregistrer-pointage"]').addEventListener("click", async (e) => {
    const btn = e.target;
    btn.disabled = true;
    try {
      const type = editEl.querySelector('[data-field="type"]').value;
      const clientSelectVal = editEl.querySelector('[data-field="client"]').value;
      const heureVal = editEl.querySelector('[data-field="heure"]').value;
      if (!heureVal) {
        alert("L'heure est requise.");
        return;
      }
      const clientId = type === "arrivee_client" || type === "depart_client" ? clientSelectVal || null : null;

      // Reconstruit l'horodatage complet : meme jour que le pointage d'origine, nouvelle heure.
      const original = new Date(editEl.dataset.originalHorodatage);
      const [hh, mm] = heureVal.split(":").map(Number);
      const nouvelleDate = new Date(original.getFullYear(), original.getMonth(), original.getDate(), hh, mm, 0, 0);
      const horodatage = nouvelleDate.toISOString();

      const cached = await Offline.getPointage(uuidVal);
      if (cached && cached.pending) {
        // Pas encore envoye au serveur (peut arriver si on corrige un pointage
        // pris hors ligne avant meme la synchronisation) : on corrige la copie
        // locale et l'action en attente directement, pas besoin de reseau.
        cached.type = type;
        cached.client_id = clientId;
        cached.horodatage = horodatage;
        await Offline.putPointage(cached);
        const outbox = await Offline.getOutbox();
        const item = outbox.find((o) => o.kind === "pointage" && o.payload.uuid === uuidVal);
        if (item) {
          await Offline.updateOutboxPayload(item.seq, { ...item.payload, type, client_id: clientId, horodatage });
        }
      } else {
        // Deja synchronise : on connait deja son vrai identifiant serveur, pas
        // besoin de passer par la resolution differee (utile pour les
        // references pas encore synchronisees, voir queueMandat/queueClient).
        const pointageId = cached ? cached.id : null;
        if (cached) {
          cached.type = type;
          cached.client_id = clientId;
          cached.horodatage = horodatage;
          await Offline.putPointage(cached);
        }
        await Offline.enqueue("pointage-patch", { pointageRef: pointageId, type, client_id: clientId, horodatage });
        Offline.sync();
      }
      editingPointageId = null;
      await refreshJournal();
      await initPointageState(); // reconstruit le chrono/bouton a partir des pointages a jour
    } catch (err) {
      alert("Erreur : " + err.message);
    } finally {
      btn.disabled = false;
    }
  });

  editEl.querySelector('[data-action="supprimer-pointage"]').addEventListener("click", async (e) => {
    if (!confirm("Supprimer ce pointage ? Cette action est irréversible.")) return;
    const btn = e.target;
    btn.disabled = true;
    try {
      const cached = await Offline.getPointage(uuidVal);
      if (cached && cached.pending) {
        const outbox = await Offline.getOutbox();
        const item = outbox.find((o) => o.kind === "pointage" && o.payload.uuid === uuidVal);
        if (item) await Offline.removeFromOutbox(item.seq);
      } else {
        await Offline.enqueue("pointage-delete", { pointageRef: cached.id });
        Offline.sync();
      }
      await Offline.deletePointageLocal(uuidVal);
      editingPointageId = null;
      await refreshJournal();
      await initPointageState();
    } catch (err) {
      alert("Erreur : " + err.message);
    } finally {
      btn.disabled = false;
    }
  });
}

async function refreshJournal() {
  const todayIso = toISODateLocal(new Date());
  // Essaie d'abord d'aller chercher la version a jour du serveur ; si ca rate
  // (hors ligne, reseau instable), on continue silencieusement avec le cache
  // local — c'est exactement le but du mode hors ligne : pas d'erreur qui
  // bloque l'ecran, juste les donnees les plus recentes qu'on a sous la main.
  try {
    const res = await fetch("/api/pointages");
    if (res.ok) {
      const serverPointages = await res.json();
      await Offline.mergeServerPointages(serverPointages, todayIso);
    }
  } catch (err) {
    // Pas grave : on utilise le cache local ci-dessous.
  }

  const all = await Offline.getAllPointages();
  const pointages = all
    .filter((p) => p.jour === todayIso)
    .sort((a, b) => new Date(a.horodatage) - new Date(b.horodatage));

  if (!pointages.length) {
    stopsListEl.innerHTML = `<div class="placeholder">Aucun pointage aujourd'hui.</div>`;
    editingPointageId = null;
    return pointages;
  }
  const clients = await ensureClientsCache();
  const nomOf = (id) => (clients.find((c) => String(c.id) === String(id)) || {}).nom;
  stopsListEl.innerHTML = pointages
    .map((p) => {
      if (p.uuid === editingPointageId) {
        return renderPointageEditForm(p, clients);
      }
      const heure = new Date(p.horodatage).toLocaleTimeString("fr-CA", { hour: "2-digit", minute: "2-digit" });
      const sub = p.client_id ? nomOf(p.client_id) || "Client" : "";
      return `
    <div class="journal-item journal-item-clickable${
      p.pending ? " journal-item-pending" : ""
    }" data-pointage-uuid="${p.uuid}">
      <div>
        <div class="journal-item-label">${labelOfPointage(p.type)}</div>
        ${sub ? `<div class="journal-item-sub">${escapeHtml(sub)}</div>` : ""}
      </div>
      <div class="journal-item-time">${heure}${p.pending ? '<span class="pending-tag">en attente</span>' : ""}</div>
    </div>`;
    })
    .join("");
  stopsListEl.querySelectorAll(".journal-item-clickable").forEach((row) => {
    row.addEventListener("click", () => {
      editingPointageId = row.dataset.pointageUuid;
      refreshJournal();
    });
  });
  attachPointageEditHandlers();
  return pointages;
}

btnPunch.addEventListener("click", async () => {
  btnPunch.disabled = true;
  try {
    if (jourState.status === "not_started") {
      await queuePointage("depart_entrepot", null);
      mainStartedAt = Date.now();
      lastDepartAt = mainStartedAt;
      startMainTick();
      jourState.status = "en_route";
      updatePunchButton();
      await renderPunchFlow();
      await refreshJournal();
    } else if (jourState.status === "en_route") {
      const minutesRetour = lastDepartAt ? Math.max(0, Math.round((Date.now() - lastDepartAt) / 60000)) : 0;
      await queuePointage("retour_entrepot", null);
      await completerTrajetRetour(minutesRetour);
      stopMainTick();
      lastDepartAt = null;
      jourState.status = "not_started";
      updatePunchButton();
      await renderPunchFlow();
      await refreshJournal();
    }
  } catch (err) {
    alert("Erreur de pointage : " + err.message);
  } finally {
    btnPunch.disabled = false;
  }
});

punchFlowEl.addEventListener("click", async (e) => {
  const target = e.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;

  try {
    if (action === "arrivee") {
      const clientId = target.dataset.clientId;
      const clientNom = target.dataset.clientNom;
      await queuePointage("arrivee_client", clientId);
      subStartedAt = Date.now();
      jourState.trajetMinutes = lastDepartAt
        ? Math.max(0, Math.round((subStartedAt - lastDepartAt) / 60000))
        : 0;
      // Ce trajet est aussi le trajet retour du mandat precedent (meme deplacement).
      await completerTrajetRetour(jourState.trajetMinutes);
      jourState.status = "chez_client";
      jourState.clientId = clientId;
      jourState.clientNom = clientNom;
      updatePunchButton();
      await renderPunchFlow();
      await refreshJournal();
    } else if (action === "lieu-inconnu") {
      jourState.status = "lieu_inconnu_form";
      await renderPunchFlow();
    } else if (action === "annuler-lieu-inconnu") {
      jourState.status = "en_route";
      await renderPunchFlow();
    } else if (action === "creer-client") {
      const nom = document.getElementById("new-client-nom").value.trim();
      const adresse = document.getElementById("new-client-adresse").value.trim();
      if (!nom) {
        alert("Le nom du client est requis.");
        return;
      }
      const client = await queueClient(nom, adresse);
      await queuePointage("arrivee_client", client.id);
      subStartedAt = Date.now();
      jourState.trajetMinutes = lastDepartAt
        ? Math.max(0, Math.round((subStartedAt - lastDepartAt) / 60000))
        : 0;
      // Ce trajet est aussi le trajet retour du mandat precedent (meme deplacement).
      await completerTrajetRetour(jourState.trajetMinutes);
      jourState.status = "chez_client";
      jourState.clientId = client.id;
      jourState.clientNom = client.nom;
      updatePunchButton();
      await renderPunchFlow();
      await refreshJournal();
    } else if (action === "terminer-client") {
      await queuePointage("depart_client", jourState.clientId);
      // Duree provisoire du mandat = trajet aller + temps sur place (mesures reels),
      // avec un minimum de 1 h. Le trajet retour n'est pas encore connu (on ne sait
      // pas encore quand on arrivera au prochain arret) : il sera ajoute des que ce
      // prochain arret sera atteint, via completerTrajetRetour().
      const minutesChezClient = subStartedAt ? (Date.now() - subStartedAt) / 60000 : 0;
      const minutesTrajetAller = jourState.trajetMinutes || 0;
      jourState.dureeBaseMinutes = minutesTrajetAller + minutesChezClient;
      jourState.dureeHeures = Math.round(Math.max(1, jourState.dureeBaseMinutes / 60) * 100) / 100;
      lastDepartAt = Date.now();
      stopSubTick();
      jourState.status = "mandat_form";
      updatePunchButton();
      await renderPunchFlow();
      await refreshJournal();
    } else if (action === "enregistrer-mandat") {
      const description = document.getElementById("mandat-desc").value.trim();
      const mandat = await queueMandat(jourState.clientId, {
        description: description || null,
        duree_heures: jourState.dureeHeures,
      });
      lastMandatId = Offline.localRef(mandat.uuid);
      lastMandatBaseMinutes = jourState.dureeBaseMinutes;
      jourState.status = "en_route";
      jourState.clientId = null;
      jourState.clientNom = null;
      jourState.dureeHeures = null;
      jourState.trajetMinutes = null;
      jourState.dureeBaseMinutes = null;
      clientsLoaded = false;
      updatePunchButton();
      await renderPunchFlow();
    } else if (action === "passer-mandat") {
      jourState.status = "en_route";
      jourState.clientId = null;
      jourState.clientNom = null;
      jourState.dureeHeures = null;
      jourState.trajetMinutes = null;
      jourState.dureeBaseMinutes = null;
      updatePunchButton();
      await renderPunchFlow();
    }
  } catch (err) {
    alert("Erreur : " + err.message);
  }
});

async function initPointageState() {
  const pointages = await refreshJournal();
  if (!pointages.length) {
    jourState.status = "not_started";
    lastDepartAt = null;
    updatePunchButton();
    await renderPunchFlow();
    return;
  }
  const clients = await ensureClientsCache();
  const nomOf = (id) => (clients.find((c) => String(c.id) === String(id)) || {}).nom;
  const first = pointages[0];
  const last = pointages[pointages.length - 1];
  if (first.type === "depart_entrepot") {
    mainStartedAt = new Date(first.horodatage).getTime();
  }

  // Reconstruit le point de depart du trajet en cours (entrepot ou dernier client
  // quitte), pour pouvoir mesurer correctement le temps de trajet meme apres un
  // rafraichissement de la page.
  lastDepartAt = null;
  for (let i = pointages.length - 1; i >= 0; i--) {
    if (pointages[i].type === "depart_entrepot" || pointages[i].type === "depart_client") {
      lastDepartAt = new Date(pointages[i].horodatage).getTime();
      break;
    }
  }

  if (last.type === "retour_entrepot") {
    jourState.status = "not_started";
  } else if (last.type === "arrivee_client") {
    jourState.status = "chez_client";
    jourState.clientId = last.client_id;
    jourState.clientNom = nomOf(last.client_id) || "Client";
    subStartedAt = new Date(last.horodatage).getTime();
    jourState.trajetMinutes = lastDepartAt
      ? Math.max(0, Math.round((subStartedAt - lastDepartAt) / 60000))
      : 0;
    startMainTick();
  } else {
    jourState.status = "en_route";
    startMainTick();
  }
  updatePunchButton();
  await renderPunchFlow();
}

// --- Clients (données réelles, via l'API branchée sur Netlify DB) ---
const clientsListEl = document.getElementById("clients-list");
const clientsListPanel = document.getElementById("clients-list-panel");
const clientsDetailPanel = document.getElementById("clients-detail-panel");
const clientDetailContent = document.getElementById("client-detail-content");
const btnClientBack = document.getElementById("btn-client-back");

let clientsLoaded = false;
let clientsCache = null;

async function ensureClientsCache() {
  if (clientsCache) return clientsCache;
  let serverClients = null;
  try {
    const res = await fetch("/api/clients");
    if (res.ok) {
      serverClients = await res.json();
      await Offline.kvSet("clients_cache", serverClients);
    }
  } catch (err) {
    serverClients = null;
  }
  if (!serverClients) {
    // Hors ligne (ou serveur injoignable) : on retombe sur la derniere liste
    // connue, enregistree localement lors du dernier chargement reussi.
    serverClients = (await Offline.kvGet("clients_cache")) || [];
  }
  // Ajoute les clients crees hors ligne mais pas encore synchronises, pour
  // qu'ils soient choisissables tout de suite (ex: "où vas-tu ?").
  const localClients = await Offline.getAllLocalClients();
  const localAsClients = localClients.map((c) => ({
    id: Offline.localRef(c.uuid),
    nom: c.nom,
    adresse: c.adresse,
    trajet_minutes: null,
    heures_semaine: 0,
  }));
  clientsCache = serverClients.concat(localAsClients);
  return clientsCache;
}

function heures(n) {
  return (Math.round((n || 0) * 10) / 10).toLocaleString("fr-CA") + " h";
}

// Convertit une valeur "date seulement" venant de l'API (ex: "2026-08-15" ou
// "2026-08-15T00:00:00.000Z" selon comment la base la renvoie) en Date locale
// a minuit, pour eviter le decalage d'un jour cause par l'interpretation UTC.
function parseDateLocal(value) {
  const iso = String(value).slice(0, 10);
  return new Date(iso + "T00:00:00");
}

async function loadClients(force) {
  if (clientsLoaded && !force) return;
  clientsListEl.innerHTML = `<div class="placeholder">Chargement…</div>`;
  try {
    const res = await fetch("/api/clients");
    if (!res.ok) throw new Error("Réponse " + res.status);
    const clients = await res.json();
    clientsLoaded = true;

    if (clients.length === 0) {
      clientsListEl.innerHTML = `<div class="placeholder">Aucun client pour l'instant.</div>`;
      return;
    }

    clientsListEl.innerHTML = clients
      .map(
        (c) => `
      <div class="client-row" data-id="${c.id}">
        <div>
          <div class="client-row-name">${escapeHtml(c.nom)}</div>
          <div class="client-row-sub">${escapeHtml(c.adresse || "")}${
            c.trajet_minutes ? " · " + c.trajet_minutes + " min de l'entrepôt" : ""
          }</div>
        </div>
        <div class="client-row-value">
          <div class="client-row-hours">${heures(c.heures_semaine)}</div>
          <div class="client-row-trip">cette semaine</div>
        </div>
      </div>`
      )
      .join("");

    clientsListEl.querySelectorAll(".client-row").forEach((row) => {
      row.addEventListener("click", () => openClient(row.dataset.id));
    });
  } catch (err) {
    clientsListEl.innerHTML = `<div class="placeholder">Impossible de charger les clients pour l'instant.<br>(${escapeHtml(
      err.message
    )})</div>`;
  }
}

// --- Ajout manuel d'un client depuis l'écran Clients (sans passer par un pointage) ---
const btnAddClient = document.getElementById("btn-add-client");
const addClientCard = document.getElementById("add-client-card");
let addClientFormOpen = false;

function renderAddClientForm() {
  if (!addClientFormOpen) {
    addClientCard.style.display = "none";
    addClientCard.innerHTML = "";
    return;
  }
  addClientCard.style.display = "block";
  addClientCard.innerHTML = `
    <div class="card" style="padding:16px;">
      <div class="section-title" style="margin-bottom:10px;">Nouveau client</div>
      <div class="inline-form">
        <div class="form-group">
          <label class="form-label" for="add-client-nom">Nom du client</label>
          <input class="form-input" id="add-client-nom" type="text" placeholder="Ex : Dépanneur Villeray">
        </div>
        <div class="form-group">
          <label class="form-label" for="add-client-adresse">Adresse</label>
          <input class="form-input" id="add-client-adresse" type="text" placeholder="Ex : 123 rue Principale">
        </div>
        <button class="btn btn-primary" data-action="confirmer-ajout-client">Créer le client</button>
        <button class="btn btn-secondary" data-action="annuler-ajout-client">Annuler</button>
      </div>
    </div>
  `;
}

btnAddClient.addEventListener("click", () => {
  addClientFormOpen = !addClientFormOpen;
  renderAddClientForm();
  if (addClientFormOpen) {
    document.getElementById("add-client-nom").focus();
  }
});

addClientCard.addEventListener("click", async (e) => {
  const target = e.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;

  if (action === "annuler-ajout-client") {
    addClientFormOpen = false;
    renderAddClientForm();
  } else if (action === "confirmer-ajout-client") {
    const nom = document.getElementById("add-client-nom").value.trim();
    const adresse = document.getElementById("add-client-adresse").value.trim();
    if (!nom) {
      alert("Le nom du client est requis.");
      return;
    }
    target.disabled = true;
    try {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nom, adresse }),
      });
      if (!res.ok) throw new Error("Réponse " + res.status);
      addClientFormOpen = false;
      renderAddClientForm();
      clientsCache = null;
      clientsLoaded = false;
      await loadClients(true);
    } catch (err) {
      alert("Impossible de créer le client : " + err.message);
    } finally {
      target.disabled = false;
    }
  }
});

let currentClientId = null;
let currentClientData = null;
let editingMandatId = null;

async function openClient(id, keepEditState) {
  clientsListPanel.style.display = "none";
  clientsDetailPanel.style.display = "block";
  currentClientId = id;
  if (!keepEditState) editingMandatId = null;
  clientDetailContent.innerHTML = `<div class="placeholder">Chargement…</div>`;
  try {
    const res = await fetch(`/api/clients/${id}`);
    if (!res.ok) throw new Error("Réponse " + res.status);
    const c = await res.json();
    currentClientData = c;
    renderClientDetail(c);
  } catch (err) {
    clientDetailContent.innerHTML = `<div class="placeholder">Impossible de charger cette fiche.<br>(${escapeHtml(
      err.message
    )})</div>`;
  }
}

function renderMandatEditForm(m) {
  return `
    <div class="mandat-item-edit" data-mandat-id="${m.id}">
      <div class="form-group">
        <label class="form-label">Description</label>
        <input class="form-input" type="text" data-field="description" value="${escapeHtml(m.description || "")}">
      </div>
      <div class="form-group">
        <label class="form-label">Durée (heures)</label>
        <input class="form-input" type="number" step="0.25" min="0" data-field="duree" value="${
          m.duree_heures ?? ""
        }">
      </div>
      <div class="form-group">
        <label class="form-label">Notes</label>
        <input class="form-input" type="text" data-field="notes" value="${escapeHtml(m.notes || "")}">
      </div>
      <div class="journal-edit-actions">
        <button class="btn btn-primary" data-action="enregistrer-mandat-edit">Enregistrer</button>
        <button class="btn btn-secondary" data-action="annuler-edit-mandat">Annuler</button>
        <button class="btn btn-danger" data-action="supprimer-mandat">Supprimer ce mandat</button>
      </div>
    </div>
  `;
}

function renderClientDetail(c) {
  const mandatsHtml = c.mandats.length
    ? c.mandats
        .map((m) => {
          if (m.id === editingMandatId) return renderMandatEditForm(m);
          return `
        <div class="mandat-item mandat-item-clickable" data-mandat-id="${m.id}">
          <div class="mandat-top">
            <div>
              <div class="mandat-date">${parseDateLocal(m.date).toLocaleDateString("fr-CA", {
                day: "2-digit",
                month: "short",
              })}</div>
              <div class="mandat-desc">${escapeHtml(m.description || "Mandat")}</div>
            </div>
            <div class="mandat-value">${heures(m.duree_heures)}</div>
          </div>
          ${m.nb_photos ? `<div class="mandat-meta">${m.nb_photos} photos</div>` : ""}
        </div>`;
        })
        .join("")
    : `<div class="placeholder">Aucun mandat enregistré pour ce client.</div>`;

  clientDetailContent.innerHTML = `
    <div class="client-name-header">${escapeHtml(c.nom)}</div>
    <div class="client-address-header">${escapeHtml(c.adresse || "")}</div>
    <div class="client-stats">
      <div class="client-stat">
        <div class="client-stat-label">Heures</div>
        <div class="client-stat-value">${heures(c.total_heures)}</div>
      </div>
      <div class="client-stat">
        <div class="client-stat-label">Mandats</div>
        <div class="client-stat-value">${c.nb_mandats}</div>
      </div>
      <div class="client-stat">
        <div class="client-stat-label">Trajet</div>
        <div class="client-stat-value">${c.trajet_minutes ? c.trajet_minutes + " min" : "—"}</div>
      </div>
    </div>
    <div class="section-title">Historique des mandats</div>
    <div class="card list-card">${mandatsHtml}</div>
  `;

  clientDetailContent.querySelectorAll(".mandat-item-clickable").forEach((row) => {
    row.addEventListener("click", () => {
      editingMandatId = Number(row.dataset.mandatId);
      renderClientDetail(currentClientData);
    });
  });

  attachMandatEditHandlers();
}

function attachMandatEditHandlers() {
  const editEl = clientDetailContent.querySelector(".mandat-item-edit");
  if (!editEl) return;
  const mandatId = Number(editEl.dataset.mandatId);

  editEl.querySelector('[data-action="annuler-edit-mandat"]').addEventListener("click", () => {
    editingMandatId = null;
    renderClientDetail(currentClientData);
  });

  editEl.querySelector('[data-action="enregistrer-mandat-edit"]').addEventListener("click", async (e) => {
    const btn = e.target;
    btn.disabled = true;
    try {
      const description = editEl.querySelector('[data-field="description"]').value.trim();
      const dureeVal = editEl.querySelector('[data-field="duree"]').value;
      const notes = editEl.querySelector('[data-field="notes"]').value.trim();
      const res = await fetch(`/api/mandats/${mandatId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: description || null,
          duree_heures: dureeVal === "" ? null : Number(dureeVal),
          notes: notes || null,
        }),
      });
      if (!res.ok) throw new Error("Réponse " + res.status);
      editingMandatId = null;
      clientsCache = null; // les heures du client ont pu changer -> reconstruit au prochain accès
      await openClient(currentClientId, true);
    } catch (err) {
      alert("Erreur : " + err.message);
    } finally {
      btn.disabled = false;
    }
  });

  editEl.querySelector('[data-action="supprimer-mandat"]').addEventListener("click", async (e) => {
    if (!confirm("Supprimer ce mandat ? Cette action est irréversible.")) return;
    const btn = e.target;
    btn.disabled = true;
    try {
      const res = await fetch(`/api/mandats/${mandatId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Réponse " + res.status);
      editingMandatId = null;
      clientsCache = null;
      await openClient(currentClientId, true);
    } catch (err) {
      alert("Erreur : " + err.message);
    } finally {
      btn.disabled = false;
    }
  });
}

btnClientBack.addEventListener("click", () => {
  clientsDetailPanel.style.display = "none";
  clientsListPanel.style.display = "block";
  editingMandatId = null;
});

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

// --- Réglages (donnees reelles, via l'API branchee sur Netlify DB) ---
const reglagesContent = document.getElementById("reglages-content");
let reglagesLoaded = false;

async function loadReglages(force) {
  if (reglagesLoaded && !force) return;
  reglagesContent.innerHTML = `<div class="placeholder">Chargement…</div>`;
  try {
    const res = await fetch("/api/reglages");
    if (!res.ok) throw new Error("Réponse " + res.status);
    const r = await res.json();
    reglagesLoaded = true;

    reglagesContent.innerHTML = `
      <div class="card" style="padding:16px;">
        <div class="form-group">
          <label class="form-label" for="reg-adresse">Adresse de l'entrepôt</label>
          <input class="form-input" id="reg-adresse" type="text" value="${escapeHtml(r.adresse_entrepot || "")}">
        </div>
        <div class="form-group">
          <label class="form-label" for="reg-arrondi">Arrondi du temps</label>
          <select class="form-select" id="reg-arrondi">
            <option value="15"${Number(r.arrondi_minutes) === 15 ? " selected" : ""}>15 minutes</option>
            <option value="30"${Number(r.arrondi_minutes) === 30 ? " selected" : ""}>30 minutes</option>
            <option value="60"${Number(r.arrondi_minutes) === 60 ? " selected" : ""}>60 minutes</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" for="reg-semaine">Début de semaine</label>
          <select class="form-select" id="reg-semaine">
            <option value="dimanche"${r.semaine_debut === "dimanche" ? " selected" : ""}>Dimanche</option>
            <option value="lundi"${r.semaine_debut === "lundi" ? " selected" : ""}>Lundi</option>
          </select>
        </div>
      </div>

      <div class="card list-card" style="margin-top:16px;">
        <div class="toggle-row">
          <div>
            <div class="toggle-row-label">Détection GPS</div>
            <div class="toggle-row-sub">Capture la position lors des pointages.</div>
          </div>
          <label class="switch">
            <input type="checkbox" id="reg-gps"${r.detection_gps ? " checked" : ""}>
            <span class="switch-track"></span>
          </label>
        </div>
        <div class="toggle-row">
          <div>
            <div class="toggle-row-label">Trajets calculés</div>
            <div class="toggle-row-sub">Calcule automatiquement le temps de trajet vers les clients.</div>
          </div>
          <label class="switch">
            <input type="checkbox" id="reg-trajets"${r.trajets_calcules ? " checked" : ""}>
            <span class="switch-track"></span>
          </label>
        </div>
      </div>

      <button class="btn btn-primary" id="btn-save-reglages" style="margin-top:16px;">Enregistrer</button>
      <div class="save-msg" id="reglages-save-msg"></div>
    `;

    document.getElementById("btn-save-reglages").addEventListener("click", saveReglages);
  } catch (err) {
    reglagesContent.innerHTML = `<div class="placeholder">Impossible de charger les réglages pour l'instant.<br>(${escapeHtml(
      err.message
    )})</div>`;
  }
}

async function saveReglages() {
  const msg = document.getElementById("reglages-save-msg");
  const payload = {
    adresse_entrepot: document.getElementById("reg-adresse").value,
    arrondi_minutes: Number(document.getElementById("reg-arrondi").value),
    semaine_debut: document.getElementById("reg-semaine").value,
    detection_gps: document.getElementById("reg-gps").checked,
    trajets_calcules: document.getElementById("reg-trajets").checked,
  };
  msg.textContent = "Enregistrement…";
  try {
    const res = await fetch("/api/reglages", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error("Réponse " + res.status);
    msg.textContent = "Réglages enregistrés";
    setTimeout(() => {
      msg.textContent = "";
    }, 2500);
  } catch (err) {
    msg.textContent = "Erreur : impossible d'enregistrer.";
  }
}

// --- Semaine (resume + export CSV) ---
const semaineContent = document.getElementById("semaine-content");
let semaineOffset = 0; // 0 = semaine courante, -1 = precedente, +1 = suivante

function startOfWeek(date, semaineDebut) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0 = dimanche ... 6 = samedi
  const diff = semaineDebut === "lundi" ? (day === 0 ? 6 : day - 1) : day;
  d.setDate(d.getDate() - diff);
  return d;
}

function toISODateLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function loadSemaine() {
  semaineContent.innerHTML = `<div class="placeholder">Chargement…</div>`;
  try {
    const reglagesRes = await fetch("/api/reglages");
    const reglages = reglagesRes.ok ? await reglagesRes.json() : {};
    const semaineDebut = reglages.semaine_debut || "dimanche";

    const base = new Date();
    base.setDate(base.getDate() + semaineOffset * 7);
    const debut = startOfWeek(base, semaineDebut);
    const startIso = toISODateLocal(debut);

    const res = await fetch(`/api/semaine?start=${startIso}`);
    if (!res.ok) throw new Error("Réponse " + res.status);
    const data = await res.json();
    renderSemaine(data);
  } catch (err) {
    semaineContent.innerHTML = `<div class="placeholder">Impossible de charger la semaine.<br>(${escapeHtml(
      err.message
    )})</div>`;
  }
}

function renderSemaine(data) {
  const fmtCourt = (iso) => {
    const d = new Date(iso + "T00:00:00");
    return `${d.getDate()} ${mois[d.getMonth()]}`;
  };

  const joursHtml = data.jours
    .map(
      (j) => `
    <div class="stop-item">
      <div>
        <div class="stop-name">${escapeHtml(j.label)}</div>
        <div class="stop-sub">${j.pointages_count} pointage${j.pointages_count > 1 ? "s" : ""}</div>
      </div>
      <div class="stop-value">${heures(j.heures)}</div>
    </div>`
    )
    .join("");

  const mandatsHtml = data.mandats.length
    ? data.mandats
        .map(
          (m) => `
    <div class="mandat-item">
      <div class="mandat-top">
        <div>
          <div class="mandat-date">${parseDateLocal(m.date).toLocaleDateString("fr-CA", {
            day: "2-digit",
            month: "short",
          })} · ${escapeHtml(m.client_nom)}</div>
          <div class="mandat-desc">${escapeHtml(m.description || "Mandat")}</div>
        </div>
        <div class="mandat-value">${heures(m.duree_heures)}</div>
      </div>
    </div>`
        )
        .join("")
    : `<div class="placeholder">Aucun mandat cette semaine.</div>`;

  semaineContent.innerHTML = `
    <div class="chrono-card" style="flex-direction:row;align-items:center;justify-content:space-between;padding:16px;">
      <button class="btn-back" id="btn-semaine-prev">&larr; Préc.</button>
      <div class="chrono-label" style="text-align:center;">${fmtCourt(data.start)} – ${fmtCourt(data.end)}</div>
      <button class="btn-back" id="btn-semaine-next">Suiv. &rarr;</button>
    </div>

    <div class="client-stats" style="grid-template-columns:1fr 1fr;">
      <div class="client-stat">
        <div class="client-stat-label">Heures payées</div>
        <div class="client-stat-value">${heures(data.total_heures)}</div>
      </div>
      <div class="client-stat">
        <div class="client-stat-label">Mandats</div>
        <div class="client-stat-value">${data.mandats.length}</div>
      </div>
    </div>

    <div class="section-title">Jours</div>
    <div class="card list-card">${joursHtml}</div>

    <div class="section-title">Mandats</div>
    <div class="card list-card">${mandatsHtml}</div>

    <button class="btn btn-primary" id="btn-export-csv">Exporter en CSV</button>
  `;

  document.getElementById("btn-semaine-prev").addEventListener("click", () => {
    semaineOffset -= 1;
    loadSemaine();
  });
  document.getElementById("btn-semaine-next").addEventListener("click", () => {
    semaineOffset += 1;
    loadSemaine();
  });
  document.getElementById("btn-export-csv").addEventListener("click", () => exportSemaineCSV(data));
}

function csvEscape(val) {
  const s = String(val ?? "");
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function exportSemaineCSV(data) {
  const lignes = [];
  lignes.push(["Semaine du", data.start, "au", data.end].map(csvEscape).join(","));
  lignes.push("");
  lignes.push(["Jour", "Heures payées", "Pointages"].map(csvEscape).join(","));
  data.jours.forEach((j) => {
    lignes.push([j.label, j.heures, j.pointages_count].map(csvEscape).join(","));
  });
  lignes.push(["Total", data.total_heures, ""].map(csvEscape).join(","));
  lignes.push("");
  lignes.push(["Date", "Client", "Description", "Heures"].map(csvEscape).join(","));
  data.mandats.forEach((m) => {
    lignes.push(
      [m.date, m.client_nom, m.description || "", m.duree_heures ?? ""]
        .map(csvEscape)
        .join(",")
    );
  });

  const csv = "\uFEFF" + lignes.join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `poincon-semaine-${data.start}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

initPointageState();
Offline.notify();
Offline.sync(); // rattrape tout de suite les actions restees en attente d'une session precedente

// --- Service worker (rend l'app installable et utilisable hors ligne) ---
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch((err) => {
      console.warn("Service worker non enregistré :", err);
    });
  });
}
