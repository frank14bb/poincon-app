import { getDatabase } from "@netlify/database";

// GET /api/clients/:id -> fiche client (infos + historique des mandats)
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
const [client] = await db.sql`
SELECT
c.id, c.nom, c.adresse, c.telephone, c.trajet_minutes,
COALESCE(SUM(m.montant_facture), 0)::float AS total_facture,
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
SELECT id, date, description, duree_heures, montant_facture, notes, nb_photos
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
