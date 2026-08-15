import { getDatabase } from "@netlify/database";

// GET  /api/clients        -> liste des clients avec heures de la semaine et temps de
//                              trajet MOYEN REEL (mesure a partir des pointages, pas
//                              une valeur entree a la main).
// POST /api/clients        -> créer un client { nom, adresse, telephone }
export default async (req) => {
  const db = getDatabase();

  try {
    if (req.method === "GET") {
      const [reglages] = await db.sql`SELECT trajets_calcules FROM reglages WHERE id = 1`;
      const trajetsActifs = !reglages || reglages.trajets_calcules !== false;

      const clients = trajetsActifs
        ? await db.sql`
            WITH ordered AS (
              SELECT client_id, type, horodatage,
                     LAG(type) OVER (ORDER BY horodatage) AS prev_type,
                     LAG(horodatage) OVER (ORDER BY horodatage) AS prev_horodatage
              FROM pointages
            ),
            trajets AS (
              SELECT client_id, EXTRACT(EPOCH FROM (horodatage - prev_horodatage)) / 60 AS minutes
              FROM ordered
              WHERE type = 'arrivee_client'
                AND prev_type IN ('depart_entrepot', 'depart_client')
                AND client_id IS NOT NULL
            ),
            trajets_moy AS (
              SELECT client_id, ROUND(AVG(minutes))::int AS trajet_minutes
              FROM trajets
              GROUP BY client_id
            )
            SELECT
              c.id,
              c.nom,
              c.adresse,
              c.telephone,
              tm.trajet_minutes,
              COUNT(m.id)::int AS nb_mandats,
              COALESCE(SUM(m.duree_heures) FILTER (
                WHERE m.date >= date_trunc('week', CURRENT_DATE)
              ), 0)::float AS heures_semaine
            FROM clients c
            LEFT JOIN mandats m ON m.client_id = c.id
            LEFT JOIN trajets_moy tm ON tm.client_id = c.id
            GROUP BY c.id, tm.trajet_minutes
            ORDER BY c.nom
          `
        : await db.sql`
            SELECT
              c.id,
              c.nom,
              c.adresse,
              c.telephone,
              NULL::int AS trajet_minutes,
              COUNT(m.id)::int AS nb_mandats,
              COALESCE(SUM(m.duree_heures) FILTER (
                WHERE m.date >= date_trunc('week', CURRENT_DATE)
              ), 0)::float AS heures_semaine
            FROM clients c
            LEFT JOIN mandats m ON m.client_id = c.id
            GROUP BY c.id
            ORDER BY c.nom
          `;

      return new Response(JSON.stringify(clients), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (req.method === "POST") {
      const body = await req.json();
      if (!body.nom) {
        return new Response(JSON.stringify({ error: "Le nom du client est requis." }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const [client] = await db.sql`
        INSERT INTO clients (nom, adresse, telephone)
        VALUES (${body.nom}, ${body.adresse || null}, ${body.telephone || null})
        RETURNING *
      `;
      return new Response(JSON.stringify(client), {
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
  path: "/api/clients",
};
