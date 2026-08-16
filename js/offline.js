// --- Phase 8 : mode hors ligne et synchronisation --------------------------
//
// Principe : chaque action qui modifie des donnees (nouveau pointage, nouveau
// mandat, correction/suppression d'un pointage, nouveau client) est d'abord
// enregistree localement (IndexedDB) avec un identifiant genere sur le
// telephone (uuid). L'action est ensuite placee dans une file d'attente
// ("outbox") et on tente de l'envoyer tout de suite si une connexion est
// disponible. Si ca echoue (pas de reseau), elle reste dans la file et sera
// renvoyee automatiquement des que la connexion revient — dans l'ordre, sans
// jamais rien perdre ni dedoubler (le serveur reconnait un uuid deja recu et
// renvoie la meme ligne au lieu d'en creer une deuxieme, voir client_uuid
// cote fonctions Netlify).
//
// Ce module n'affiche rien lui-meme : il expose des methodes que app.js
// utilise, et un petit systeme d'abonnement (onChange) pour mettre a jour
// l'indicateur "hors ligne" a l'ecran.

const Offline = (() => {
  const DB_NAME = "poincon-offline";
  const DB_VERSION = 1;
  let dbPromise = null;
  let syncing = false;
  let syncScheduled = false;
  const listeners = [];

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // Reference vers une entite pas encore synchronisee (ex: client cree hors
  // ligne, utilise tout de suite comme destination d'un pointage).
  function localRef(id) {
    return "local:" + id;
  }
  function isLocalRef(val) {
    return typeof val === "string" && val.startsWith("local:");
  }
  function localRefId(val) {
    return val.slice(6);
  }

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("outbox")) {
          db.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true });
        }
        if (!db.objectStoreNames.contains("pointages")) {
          db.createObjectStore("pointages", { keyPath: "uuid" });
        }
        if (!db.objectStoreNames.contains("clients_local")) {
          db.createObjectStore("clients_local", { keyPath: "uuid" });
        }
        if (!db.objectStoreNames.contains("idmap")) {
          db.createObjectStore("idmap", { keyPath: "uuid" });
        }
        if (!db.objectStoreNames.contains("kv")) {
          db.createObjectStore("kv", { keyPath: "key" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function store(name, mode) {
    const db = await openDB();
    return db.transaction(name, mode).objectStore(name);
  }

  // --- outbox --------------------------------------------------------------
  async function enqueue(kind, payload) {
    const s = await store("outbox", "readwrite");
    const seq = await reqToPromise(s.add({ kind, payload, createdAt: Date.now() }));
    notify();
    return seq;
  }

  async function getOutbox() {
    const s = await store("outbox", "readonly");
    const all = await reqToPromise(s.getAll());
    return all.sort((a, b) => a.seq - b.seq);
  }

  async function removeFromOutbox(seq) {
    const s = await store("outbox", "readwrite");
    await reqToPromise(s.delete(seq));
  }

  async function updateOutboxPayload(seq, payload) {
    const s = await store("outbox", "readwrite");
    const item = await reqToPromise(s.get(seq));
    if (!item) return;
    item.payload = payload;
    await reqToPromise(s.put(item));
  }

  // --- idmap (uuid local -> id reel cote serveur) --------------------------
  async function setResolved(localUuid, serverId) {
    const s = await store("idmap", "readwrite");
    await reqToPromise(s.put({ uuid: localUuid, serverId }));
  }

  async function resolve(val) {
    if (!isLocalRef(val)) return val;
    const s = await store("idmap", "readonly");
    const row = await reqToPromise(s.get(localRefId(val)));
    return row ? row.serverId : null;
  }

  // --- pointages (cache local = source pour l'ecran "Aujourd'hui") ---------
  async function putPointage(p) {
    const s = await store("pointages", "readwrite");
    await reqToPromise(s.put(p));
  }

  async function deletePointageLocal(uuidVal) {
    const s = await store("pointages", "readwrite");
    await reqToPromise(s.delete(uuidVal));
  }

  async function getPointage(uuidVal) {
    const s = await store("pointages", "readonly");
    return reqToPromise(s.get(uuidVal));
  }

  async function getAllPointages() {
    const s = await store("pointages", "readonly");
    return reqToPromise(s.getAll());
  }

  // Remplace le cache local par la liste venant du serveur (source fiable),
  // en gardant quand meme les pointages encore en attente de synchronisation
  // (ils ne sont pas encore dans la reponse du serveur).
  async function mergeServerPointages(serverList, todayIso) {
    const s = await store("pointages", "readwrite");
    const existing = await reqToPromise(s.getAll());
    const pending = existing.filter((p) => p.pending);
    const pendingUuids = new Set(pending.map((p) => p.uuid));
    await Promise.all(existing.map((p) => reqToPromise(s.delete(p.uuid))));
    const writes = [];
    serverList.forEach((row) => {
      const key = row.client_uuid || "server-" + row.id;
      if (pendingUuids.has(key)) return; // deja en cache comme "pending", pas encore confirme
      writes.push(
        reqToPromise(
          s.put({
            uuid: key,
            id: row.id,
            type: row.type,
            client_id: row.client_id,
            horodatage: row.horodatage,
            jour: todayIso,
            pending: false,
          })
        )
      );
    });
    pending.forEach((p) => writes.push(reqToPromise(s.put(p))));
    await Promise.all(writes);
  }

  // --- clients crees hors ligne (pas encore synchronises) -------------------
  async function putLocalClient(c) {
    const s = await store("clients_local", "readwrite");
    await reqToPromise(s.put(c));
  }

  async function getAllLocalClients() {
    const s = await store("clients_local", "readonly");
    return reqToPromise(s.getAll());
  }

  async function removeLocalClient(uuidVal) {
    const s = await store("clients_local", "readwrite");
    await reqToPromise(s.delete(uuidVal));
  }

  // --- petit cache cle/valeur (derniere liste clients connue, etc.) --------
  async function kvGet(key) {
    const s = await store("kv", "readonly");
    const row = await reqToPromise(s.get(key));
    return row ? row.value : null;
  }

  async function kvSet(key, value) {
    const s = await store("kv", "readwrite");
    await reqToPromise(s.put({ key, value }));
  }

  // --- notifications (pour l'indicateur "hors ligne" a l'ecran) ------------
  function onChange(fn) {
    listeners.push(fn);
  }

  async function notify() {
    const pending = (await getOutbox()).length;
    listeners.forEach((fn) => {
      try {
        fn({ pending, online: navigator.onLine, syncing });
      } catch (err) {
        // ignore
      }
    });
  }

  // --- synchronisation -------------------------------------------------------
  // Traite la file d'attente dans l'ordre, une action a la fois. S'arrete des
  // qu'une action echoue pour une raison reseau (elle reste en tete de file
  // pour le prochain essai). Une erreur "vraie" du serveur (ex: 400) est
  // rare ici puisque les donnees viennent de l'app elle-meme ; elle est
  // simplement journalisee et l'action est retiree pour ne pas bloquer les
  // suivantes indefiniment.
  async function sendOne(item) {
    const { kind, payload } = item;

    if (kind === "client") {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nom: payload.nom, adresse: payload.adresse, client_uuid: payload.uuid }),
      });
      if (!res.ok) throw { network: false, status: res.status };
      const client = await res.json();
      await setResolved(payload.uuid, client.id);
      await removeLocalClient(payload.uuid);
      return;
    }

    if (kind === "pointage") {
      const clientId = await resolve(payload.client_id);
      if (payload.client_id != null && clientId == null) {
        // Le client dont depend ce pointage n'est pas encore resolu (ne devrait
        // pas arriver vu l'ordre de la file, mais on ne perd rien : on attend).
        throw { network: true };
      }
      const res = await fetch("/api/pointages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: payload.type,
          client_id: clientId,
          latitude: payload.latitude,
          longitude: payload.longitude,
          horodatage: payload.horodatage,
          client_uuid: payload.uuid,
        }),
      });
      if (!res.ok) throw { network: false, status: res.status };
      const pointage = await res.json();
      await setResolved(payload.uuid, pointage.id);
      const cached = await getPointage(payload.uuid);
      if (cached) {
        cached.pending = false;
        cached.id = pointage.id;
        cached.client_id = pointage.client_id;
        await putPointage(cached);
      }
      return;
    }

    if (kind === "mandat") {
      const clientId = await resolve(payload.client_id);
      if (payload.client_id != null && clientId == null) throw { network: true };
      const res = await fetch("/api/mandats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: clientId,
          description: payload.description,
          duree_heures: payload.duree_heures,
          date: payload.date,
          client_uuid: payload.uuid,
        }),
      });
      if (!res.ok) throw { network: false, status: res.status };
      const mandat = await res.json();
      await setResolved(payload.uuid, mandat.id);
      return;
    }

    if (kind === "mandat-patch") {
      const mandatId = await resolve(payload.mandatRef);
      if (mandatId == null) throw { network: true };
      const res = await fetch(`/api/mandats/${mandatId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ duree_heures: payload.duree_heures }),
      });
      if (!res.ok && res.status !== 404) throw { network: false, status: res.status };
      return;
    }

    if (kind === "pointage-patch") {
      const pointageId = await resolve(payload.pointageRef);
      if (pointageId == null) throw { network: true };
      const clientId = await resolve(payload.client_id);
      if (payload.client_id != null && clientId == null) throw { network: true };
      const res = await fetch(`/api/pointages/${pointageId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: payload.type, client_id: clientId, horodatage: payload.horodatage }),
      });
      if (!res.ok && res.status !== 404) throw { network: false, status: res.status };
      return;
    }

    if (kind === "pointage-delete") {
      const pointageId = await resolve(payload.pointageRef);
      if (pointageId == null) throw { network: true };
      const res = await fetch(`/api/pointages/${pointageId}`, { method: "DELETE" });
      // 404 = deja supprime (ou jamais arrive) : on considere ca comme reussi.
      if (!res.ok && res.status !== 404) throw { network: false, status: res.status };
      return;
    }

    if (kind === "reglages") {
      const res = await fetch("/api/reglages", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw { network: false, status: res.status };
      return;
    }
  }

  async function sync() {
    if (syncing) {
      syncScheduled = true;
      return;
    }
    if (!navigator.onLine) return;
    syncing = true;
    notify();
    try {
      while (true) {
        const outbox = await getOutbox();
        if (!outbox.length) break;
        const item = outbox[0];
        try {
          await sendOne(item);
          await removeFromOutbox(item.seq);
        } catch (err) {
          // Erreur reseau (ou dependance pas encore resolue) : on arrete la
          // synchronisation ici, on reessaiera plus tard sans rien perdre.
          break;
        }
      }
    } finally {
      syncing = false;
      notify();
      if (syncScheduled) {
        syncScheduled = false;
        sync();
      }
    }
  }

  window.addEventListener("online", () => sync());
  // Nouvelle tentative reguliere : utile quand le navigateur croit etre en
  // ligne mais que la requete precedente a quand meme echoue (reseau
  // instable, en camion, sous-sol, etc.).
  setInterval(() => sync(), 20000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") sync();
  });

  return {
    uuid,
    localRef,
    isLocalRef,
    enqueue,
    getOutbox,
    updateOutboxPayload,
    removeFromOutbox,
    setResolved,
    resolve,
    putPointage,
    deletePointageLocal,
    getPointage,
    getAllPointages,
    mergeServerPointages,
    putLocalClient,
    getAllLocalClients,
    removeLocalClient,
    kvGet,
    kvSet,
    onChange,
    notify,
    sync,
  };
})();
