import { getDatabase } from "@netlify/database";

// GET /api/semaine?start=YYYY-MM-DD -> resume de la semaine de 7 jours a partir de "start"
export default async (req) => {
  const db = getDatabase();

  try {
    if (req.method !== "GET") {
      return new Response("Method not allowed", { status: 405 });
    }

    const url = new URL(req.url);
    const startParam = url.searchParams.get("start");
    const start = startParam && /^\d{4}-\d{2}-\d{2}$/.test(startParam) ? startParam : null;
    if (!start) {
      return new Response(JSON.stringify({ error: "Le parametre 'start' (YYYY-MM-DD) est requis." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const [reglages] = await db.sql`SELECT arrondi_minutes FROM reglages WHERE id = 1`;
    const arrondi = (reglages && reglages.arrondi_minutes) || 30;

    const pointages = await db.sql`
      SELECT id, type, client_id, horodatage
      FROM pointages
      WHERE horodatage::date >= ${start}::date
        AND horodatage::date < ${start}::date + INTERVAL '7 days'
      ORDER BY horodatage ASC
    `;

    const mandats = await db.sql`
      SELECT m.id, m.date, m.description, m.duree_heures, m.montant_facture, c.nom AS client_nom
      FROM mandats m
      JOIN clients c ON c.id = m.client_id
      WHERE m.date >= ${start}::date
        AND m.date < ${start}::date + INTERVAL '7 days'
      ORDER BY m.date ASC, m.id ASC
    `;

    // Regrouper les pointages par jour et calculer les heures payees (entrepot a entrepot)
    const parJour = {};
    for (let i = 0; i < 7; i++) {
      const d = new Date(start + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() + i);
      const iso = d.toISOString().slice(0, 10);
      parJour[iso] = { date: iso, minutes: 0, pointages: 0 };
    }

    let curDepart = null;
    for (const p of pointages) {
      const iso = new Date(p.horodatage).toISOString().slice(0, 10);
      if (parJour[iso]) parJour[iso].pointages += 1;
      if (p.type === "depart_entrepot") {
        curDepart = new Date(p.horodatage).getTime();
      } else if (p.type === "retour_entrepot" && curDepart) {
        const minutes = Math.max(0, Math.round((new Date(p.horodatage).getTime() - curDepart) / 60000));
        if (parJour[iso]) parJour[iso].minutes += minutes;
        curDepart = null;
      }
    }

    const arrondirMinutes = (m) => (arrondi > 0 ? Math.round(m / arrondi) * arrondi : m);

    const nomsJours = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
    const nomsMois = [
      "janvier", "février", "mars", "avril", "mai", "juin",
      "juillet", "août", "septembre", "octobre", "novembre", "décembre",
    ];

    const jours = Object.values(parJour).map((j) => {
      const d = new Date(j.date + "T00:00:00Z");
      const minutesArrondies = arrondirMinutes(j.minutes);
      return {
        date: j.date,
        label: `${nomsJours[d.getUTCDay()]} ${d.getUTCDate()} ${nomsMois[d.getUTCMonth()]}`,
        minutes: minutesArrondies,
        heures: Math.round((minutesArrondies / 60) * 100) / 100,
        pointages_count: j.pointages,
      };
    });

    const totalMinutes = jours.reduce((s, j) => s + j.minutes, 0);
    const totalFacture = mandats.reduce((s, m) => s + Number(m.montant_facture || 0), 0);

    const end = new Date(start + "T00:00:00Z");
    end.setUTCDate(end.getUTCDate() + 6);

    return new Response(
      JSON.stringify({
        start,
        end: end.toISOString().slice(0, 10),
        jours,
        total_minutes: totalMinutes,
        total_heures: Math.round((totalMinutes / 60) * 100) / 100,
        total_facture: totalFacture,
        mandats,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

export const config = {
  path: "/api/semaine",
};
