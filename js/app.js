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

let jourState = { status: "not_started", clientId: null, clientNom: null };
let mainStartedAt = null;
let subStartedAt = null;
let mainTickHandle = null;
let subTickHandle = null;

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

async function postPointage(type, clientId) {
  const pos = await getPosition();
  const res = await fetch("/api/pointages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type,
      client_id: clientId || null,
      latitude: pos ? pos.latitude : null,
      longitude: pos ? pos.longitude : null,
    }),
  });
  if (!res.ok) throw new Error("Réponse " + res.status);
  return res.json();
}

async function postMandat(clientId, payload) {
  const res = await fetch("/api/mandats", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, ...payload }),
  });
  if (!res.ok) throw new Error("Réponse " + res.status);
  return res.json();
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
        <div class="section-title" style="margin-bottom:10px;">Résumé du mandat — ${escapeHtml(jourState.clientNom || "")}</div>
        <div class="inline-form">
          <div class="form-group">
            <label class="form-label" for="mandat-desc">Description</label>
            <input class="form-input" id="mandat-desc" type="text" placeholder="Ex : Diagnostic fuite colonne montante">
          </div>
          <div class="form-group">
            <label class="form-label" for="mandat-montant">Montant facturé ($)</label>
            <input class="form-input" id="mandat-montant" type="number" step="0.01" placeholder="0.00">
          </div>
          <button class="btn btn-primary" data-action="enregistrer-mandat">Enregistrer le mandat</button>
          <button class="btn btn-secondary" data-action="passer-mandat">Passer</button>
        </div>
      </div>
    `;
    return;
  }
}

async function refreshJournal() {
  try {
    const res = await fetch("/api/pointages");
    if (!res.ok) throw new Error("Réponse " + res.status);
    const pointages = await res.json();
    if (!pointages.length) {
      stopsListEl.innerHTML = `<div class="placeholder">Aucun pointage aujourd'hui.</div>`;
      return pointages;
    }
    const clients = await ensureClientsCache();
    const nomOf = (id) => (clients.find((c) => String(c.id) === String(id)) || {}).nom;
    const labelOf = (type) =>
      ({
        depart_entrepot: "Départ de l'entrepôt",
        arrivee_client: "Arrivée",
        depart_client: "Départ",
        retour_entrepot: "Retour à l'entrepôt",
      }[type] || type);
    stopsListEl.innerHTML = pointages
      .map((p) => {
        const heure = new Date(p.horodatage).toLocaleTimeString("fr-CA", { hour: "2-digit", minute: "2-digit" });
        const sub = p.client_id ? nomOf(p.client_id) || "Client" : "";
        return `
      <div class="journal-item">
        <div>
          <div class="journal-item-label">${labelOf(p.type)}</div>
          ${sub ? `<div class="journal-item-sub">${escapeHtml(sub)}</div>` : ""}
        </div>
        <div class="journal-item-time">${heure}</div>
      </div>`;
      })
      .join("");
    return pointages;
  } catch (err) {
    stopsListEl.innerHTML = `<div class="placeholder">Impossible de charger le journal.<br>(${escapeHtml(
      err.message
    )})</div>`;
    return [];
  }
}

btnPunch.addEventListener("click", async () => {
  btnPunch.disabled = true;
  try {
    if (jourState.status === "not_started") {
      await postPointage("depart_entrepot", null);
      mainStartedAt = Date.now();
      startMainTick();
      jourState.status = "en_route";
      updatePunchButton();
      await renderPunchFlow();
      await refreshJournal();
    } else if (jourState.status === "en_route") {
      await postPointage("retour_entrepot", null);
      stopMainTick();
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
      await postPointage("arrivee_client", clientId);
      subStartedAt = Date.now();
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
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nom, adresse }),
      });
      if (!res.ok) throw new Error("Réponse " + res.status);
      const client = await res.json();
      clientsCache = null;
      clientsLoaded = false;
      await postPointage("arrivee_client", client.id);
      subStartedAt = Date.now();
      jourState.status = "chez_client";
      jourState.clientId = client.id;
      jourState.clientNom = client.nom;
      updatePunchButton();
      await renderPunchFlow();
      await refreshJournal();
    } else if (action === "terminer-client") {
      await postPointage("depart_client", jourState.clientId);
      stopSubTick();
      jourState.status = "mandat_form";
      updatePunchButton();
      await renderPunchFlow();
      await refreshJournal();
    } else if (action === "enregistrer-mandat") {
      const description = document.getElementById("mandat-desc").value.trim();
      const montant = document.getElementById("mandat-montant").value;
      await postMandat(jourState.clientId, {
        description: description || null,
        montant_facture: montant ? Number(montant) : null,
      });
      jourState.status = "en_route";
      jourState.clientId = null;
      jourState.clientNom = null;
      clientsLoaded = false;
      updatePunchButton();
      await renderPunchFlow();
    } else if (action === "passer-mandat") {
      jourState.status = "en_route";
      jourState.clientId = null;
      jourState.clientNom = null;
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
  if (last.type === "retour_entrepot") {
    jourState.status = "not_started";
  } else if (last.type === "arrivee_client") {
    jourState.status = "chez_client";
    jourState.clientId = last.client_id;
    jourState.clientNom = nomOf(last.client_id) || "Client";
    subStartedAt = new Date(last.horodatage).getTime();
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
  try {
    const res = await fetch("/api/clients");
    clientsCache = res.ok ? await res.json() : [];
  } catch (err) {
    clientsCache = [];
  }
  return clientsCache;
}

function heures(n) {
  return (Math.round((n || 0) * 10) / 10).toLocaleString("fr-CA") + " h";
}
function argent(n) {
  return (n || 0).toLocaleString("fr-CA", { style: "currency", currency: "CAD" });
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

async function openClient(id) {
  clientsListPanel.style.display = "none";
  clientsDetailPanel.style.display = "block";
  clientDetailContent.innerHTML = `<div class="placeholder">Chargement…</div>`;
  try {
    const res = await fetch(`/api/clients/${id}`);
    if (!res.ok) throw new Error("Réponse " + res.status);
    const c = await res.json();

    const mandatsHtml = c.mandats.length
      ? c.mandats
          .map(
            (m) => `
        <div class="mandat-item">
          <div class="mandat-top">
            <div>
              <div class="mandat-date">${new Date(m.date).toLocaleDateString("fr-CA", {
                day: "2-digit",
                month: "short",
              })}</div>
              <div class="mandat-desc">${escapeHtml(m.description || "Mandat")}</div>
            </div>
            <div class="mandat-value">${heures(m.duree_heures)}</div>
          </div>
          <div class="mandat-meta">${argent(m.montant_facture)}${
              m.nb_photos ? " · " + m.nb_photos + " photos" : ""
            }</div>
        </div>`
          )
          .join("")
      : `<div class="placeholder">Aucun mandat enregistré pour ce client.</div>`;

    clientDetailContent.innerHTML = `
      <div class="client-name-header">${escapeHtml(c.nom)}</div>
      <div class="client-address-header">${escapeHtml(c.adresse || "")}</div>
      <div class="client-stats">
        <div class="client-stat">
          <div class="client-stat-label">Facturé</div>
          <div class="client-stat-value">${argent(c.total_facture)}</div>
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
  } catch (err) {
    clientDetailContent.innerHTML = `<div class="placeholder">Impossible de charger cette fiche.<br>(${escapeHtml(
      err.message
    )})</div>`;
  }
}

btnClientBack.addEventListener("click", () => {
  clientsDetailPanel.style.display = "none";
  clientsListPanel.style.display = "block";
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

initPointageState();

// --- Service worker (rend l'app installable et utilisable hors ligne) ---
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch((err) => {
      console.warn("Service worker non enregistré :", err);
    });
  });
}
