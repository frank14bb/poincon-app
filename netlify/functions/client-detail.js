import { getDatabase } from "@netlify/database";

// GET /api/clients/:id -> fiche client (infos + historique des mandats)
// Le temps de trajet est un temps MOYEN REEL, mesure a partir des pointages
// (ecart entre le dernier depart - entrepot ou client - et l'arrivee chez ce client).
export default async (req, context) => {
  const db = getDatabase();
  const id = Number(context.params.id);

  if (!id) {
    return new Response(JSON.stringify({ error: "Identifiant de client invalide." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const [reglages] = await db.sql`SELECT trajets_calcules FROM reglages WHERE id = 1`;
    const trajetsActifs = !reglages || reglages.trajets_calcules !== false;

    const [client] = trajetsActifs
      ? await db.sql`
          WITH ordered AS (
            SELECT client_id, type, horodatage,
                   LAG(type) OVER (ORDER BY horodatage) AS prev_type,
                   LAG(horodatage) OVER (ORDER BY horodatage) AS prev_horodatage
            FROM pointages
          ),
          trajets AS (
            SELECT EXTRACT(EPOCH FROM (horodatage - prev_horodatage)) / 60 AS minutes
            FROM ordered
            WHERE type = 'arrivee_client'
              AND prev_type IN ('depart_entrepot', 'depart_client')
              AND client_id = ${id}
          )
          SELECT
            c.id, c.nom, c.adresse, c.telephone,
            (SELECT ROUND(AVG(minutes))::int FROM trajets) AS trajet_minutes,
            COALESCE(SUM(m.duree_heures), 0)::float AS total_heures,
            COUNT(m.id)::int AS nb_mandats
          FROM clients c
          LEFT JOIN mandats m ON m.client_id = c.id
          WHERE c.id = ${id}
          GROUP BY c.id
        `
      : await db.sql`
          SELECT
            c.id, c.nom, c.adresse, c.telephone,
            NULL::int AS trajet_minutes,
            COALESCE(SUM(m.duree_heures), 0)::float AS total_heures,
            COUNT(m.id)::int AS nb_mandats
          FROM clients c
          LEFT JOIN mandats m ON m.client_id = c.id
          WHERE c.id = ${id}
          GROUP BY c.id
        `;

    if (!client) {
      return new Response(JSON.stringify({ error: "Client introuvable." }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const mandats = await db.sql`
      SELECT id, date, description, duree_heures, notes, nb_photos
      FROM mandats
      WHERE client_id = ${id}
      ORDER BY date DESC
    `;

    return new Response(JSON.stringify({ ...client, mandats }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

export const config = {
  path: "/api/clients/:id",
};
