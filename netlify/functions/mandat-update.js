import { getDatabase } from "@netlify/database";

// PATCH  /api/mandats/:id -> corrige un mandat deja cree.
//   - Appel interne (trajet-retour, voir completerTrajetRetour() dans app.js) :
//     n'envoie que { duree_heures }.
//   - Appel depuis la fiche client (edition manuelle) : peut envoyer
//     { description, duree_heures, notes }. Tout champ absent du body garde sa
//     valeur actuelle (mise a jour partielle).
// DELETE /api/mandats/:id -> supprime un mandat.
export default async (req, context) => {
  const db = getDatabase();
  const id = Number(context.params.id);

  if (!id) {
    return new Response(JSON.stringify({ error: "Identifiant de mandat invalide." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    if (req.method === "PATCH") {
      const body = await req.json();

      const [existant] = await db.sql`SELECT * FROM mandats WHERE id = ${id}`;
      if (!existant) {
        return new Response(JSON.stringify({ error: "Mandat introuvable." }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      const description = body.description !== undefined ? body.description || null : existant.description;
      const dureeHeures = body.duree_heures !== undefined ? body.duree_heures : existant.duree_heures;
      const notes = body.notes !== undefined ? body.notes || null : existant.notes;

      const [mandat] = await db.sql`
        UPDATE mandats SET description = ${description}, duree_heures = ${dureeHeures}, notes = ${notes}
        WHERE id = ${id}
        RETURNING *
      `;

      return new Response(JSON.stringify(mandat), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (req.method === "DELETE") {
      const [mandat] = await db.sql`DELETE FROM mandats WHERE id = ${id} RETURNING id`;
      if (!mandat) {
        return new Response(JSON.stringify({ error: "Mandat introuvable." }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ deleted: true, id: mandat.id }), {
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
  path: "/api/mandats/:id",
};
