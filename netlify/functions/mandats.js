import { getDatabase } from "@netlify/database";

// POST /api/mandats -> creer un mandat { client_id, description, duree_heures, notes }
// Note : plus de montant facture — le suivi se fait uniquement en heures (avec un
// minimum de 1h par mandat, trajet inclus, applique cote client dans app.js).
export default async (req) => {
  const db = getDatabase();

  try {
    if (req.method === "POST") {
      const body = await req.json();
      if (!body.client_id) {
        return new Response(JSON.stringify({ error: "Le client est requis." }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      // date : le jour reel du mandat (utile si enregistre hors ligne pres de minuit
      // et synchronise seulement le lendemain) ; par defaut la date du serveur.
      const date = body.date || new Date().toISOString().slice(0, 10);
      const [mandat] = await db.sql`
        INSERT INTO mandats (client_id, description, duree_heures, notes, date, client_uuid)
        VALUES (${body.client_id}, ${body.description || null}, ${body.duree_heures ?? null}, ${body.notes || null}, ${date}, ${body.client_uuid || null})
        ON CONFLICT (client_uuid) DO UPDATE SET
          client_id = EXCLUDED.client_id,
          description = EXCLUDED.description,
          duree_heures = EXCLUDED.duree_heures,
          notes = EXCLUDED.notes,
          date = EXCLUDED.date
        RETURNING *
      `;
      return new Response(JSON.stringify(mandat), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Method not allowed", { status: 405 });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

export const config = {
  path: "/api/mandats",
};
