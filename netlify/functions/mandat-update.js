import { getDatabase } from "@netlify/database";

// PATCH /api/mandats/:id -> ajuste la duree d'un mandat deja cree.
// Sert a completer la duree provisoire (trajet aller + travail) avec le trajet
// retour, une fois connu (voir completerTrajetRetour() dans app.js).
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
    if (req.method !== "PATCH") {
      return new Response("Method not allowed", { status: 405 });
    }

    const body = await req.json();
    const [mandat] = await db.sql`
      UPDATE mandats SET duree_heures = ${body.duree_heures ?? null}
      WHERE id = ${id}
      RETURNING *
    `;

    if (!mandat) {
      return new Response(JSON.stringify({ error: "Mandat introuvable." }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify(mandat), {
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
  path: "/api/mandats/:id",
};
