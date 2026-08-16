import { getDatabase } from "@netlify/database";

const TYPES_VALIDES = ["depart_entrepot", "arrivee_client", "depart_client", "retour_entrepot"];

// PATCH  /api/pointages/:id -> corrige un pointage deja enregistre (type, client, heure)
// DELETE /api/pointages/:id -> supprime un pointage
export default async (req, context) => {
  const db = getDatabase();
  const id = Number(context.params.id);

  if (!id) {
    return new Response(JSON.stringify({ error: "Identifiant de pointage invalide." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    if (req.method === "PATCH") {
      const body = await req.json();
      if (body.type && !TYPES_VALIDES.includes(body.type)) {
        return new Response(JSON.stringify({ error: "Type de pointage invalide." }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const [existant] = await db.sql`SELECT * FROM pointages WHERE id = ${id}`;
      if (!existant) {
        return new Response(JSON.stringify({ error: "Pointage introuvable." }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      const type = body.type ?? existant.type;
      const clientId = body.client_id !== undefined ? body.client_id || null : existant.client_id;
      const horodatage = body.horodatage ?? existant.horodatage;

      const [pointage] = await db.sql`
        UPDATE pointages SET type = ${type}, client_id = ${clientId}, horodatage = ${horodatage}
        WHERE id = ${id}
        RETURNING *
      `;
      return new Response(JSON.stringify(pointage), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (req.method === "DELETE") {
      const [pointage] = await db.sql`DELETE FROM pointages WHERE id = ${id} RETURNING id`;
      if (!pointage) {
        return new Response(JSON.stringify({ error: "Pointage introuvable." }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ deleted: true, id: pointage.id }), {
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
  path: "/api/pointages/:id",
};
