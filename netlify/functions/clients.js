import { getDatabase } from "@netlify/database";

// GET  /api/clients        -> liste des clients avec total facture et heures de la semaine
// POST /api/clients        -> creer un client { nom, adresse, telephone, trajet_minutes }
export default async (req) => {
const db = getDatabase();

try {
if (req.method === "GET") {
const clients = await db.sql`
SELECT
c.id,
c.nom,
c.adresse,
c.telephone,
c.trajet_minutes,
COALESCE(SUM(m.montant_facture), 0)::float AS total_facture,
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
INSERT INTO clients (nom, adresse, telephone, trajet_minutes)
VALUES (${body.nom}, ${body.adresse || null}, ${body.telephone || null}, ${body.trajet_minutes || null})
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
