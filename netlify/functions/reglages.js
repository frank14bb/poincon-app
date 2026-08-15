import { getDatabase } from "@netlify/database";

// GET /api/reglages -> les reglages actuels
// PUT /api/reglages -> met a jour les reglages { adresse_entrepot, arrondi_minutes, semaine_debut, detection_gps, trajets_calcules }
export default async (req) => {
  const db = getDatabase();

  try {
    if (req.method === "GET") {
      const [reglages] = await db.sql`SELECT * FROM reglages WHERE id = 1`;
      return new Response(JSON.stringify(reglages || {}), {
        headers: { "Content-Type": "application/json" },
        });
      }

    if (req.method === "PUT") {
      const body = await req.json();
      const [reglages] = await db.sql`
      UPDATE reglages SET
      adresse_entrepot = ${body.adresse_entrepot ?? null},
      arrondi_minutes = ${body.arrondi_minutes ?? 30},
      semaine_debut = ${body.semaine_debut ?? "dimanche"},
      detection_gps = ${body.detection_gps ?? true},
      trajets_calcules = ${body.trajets_calcules ?? true}
      WHERE id = 1
      RETURNING *
      `;
      return new Response(JSON.stringify(reglages), {
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
  path: "/api/reglages",
  };
