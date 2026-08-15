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

// --- Chrono (pointage manuel — Phase 1 : logique de base seulement) ---
// La vraie logique (GPS, calcul de trajet, lieu inconnu) arrive en Phase 3-4.
// Ici on pose juste le squelette : un bouton qui démarre/arrête un chrono local.
const chronoTime = document.getElementById("chrono-time");
const chronoSub = document.getElementById("chrono-sub");
const statusBadge = document.getElementById("status-badge");
const btnPunch = document.getElementById("btn-punch");

let startedAt = null;
let tickHandle = null;

function pad(n) { return String(n).padStart(2, "0"); }

function renderChrono() {
  if (!startedAt) {
    chronoTime.textContent = "00:00:00";
    return;
  }
  const elapsedMs = Date.now() - startedAt;
  const totalSec = Math.floor(elapsedMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  chronoTime.textContent = `${pad(h)}:${pad(m)}:${pad(s)}`;
}

btnPunch.addEventListener("click", () => {
  if (!startedAt) {
    startedAt = Date.now();
    tickHandle = setInterval(renderChrono, 1000);
    statusBadge.textContent = "En cours";
    chronoSub.textContent = "Parti de l'entrepôt à " + new Date(startedAt).toLocaleTimeString("fr-CA", { hour: "2-digit", minute: "2-digit" });
    btnPunch.textContent = "Sortie / fin de journée";
  } else {
    clearInterval(tickHandle);
    statusBadge.textContent = "Pas encore parti";
    chronoSub.textContent = "Le compteur démarre au moment où tu quittes l'entrepôt.";
    btnPunch.textContent = "Départ de l'entrepôt";
    startedAt = null;
    renderChrono();
  }
});

// --- Clients (données réelles, via l'API branchée sur Netlify DB) ---
const clientsListEl = document.getElementById("clients-list");
const clientsListPanel = document.getElementById("clients-list-panel");
const clientsDetailPanel = document.getElementById("clients-detail-panel");
const clientDetailContent = document.getElementById("client-detail-content");
const btnClientBack = document.getElementById("btn-client-back");

let clientsLoaded = false;

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

// --- Service worker (rend l'app installable et utilisable hors ligne) ---
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch((err) => {
      console.warn("Service worker non enregistré :", err);
    });
  });
}
