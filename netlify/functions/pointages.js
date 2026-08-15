import { getDatabase } from "@netlify/database";

// GET  /api/pointages?date=YYYY-MM-DD -> pointages d'une journee (defaut : aujourd'hui)
// POST /api/pointages -> creer un pointage { type, client_id, latitude, longitude }
export default async (req) => {
const db = getDatabase();

try {
if (req.method === "GET") {
const url = new URL(req.url);
const date = url.searchParams.get("date");
const pointages = date
? await db.sql`SELECT * FROM pointages WHERE horodatage::date = ${date}::date ORDER BY horodatage ASC`
: await db.sql`SELECT * FROM pointages WHERE horodatage::date = CURRENT_DATE ORDER BY horodatage ASC`;
return new Response(JSON.stringify(pointages), {
headers: { "Content-Type": "application/json" },
});
}

if (req.method === "POST") {
const body = await req.json();
if (!body.type) {
return new Response(JSON.stringify({ error: "Le type de pointage est requis." }), {
status: 400,
headers: { "Content-Type": "application/json" },
});
}
const [pointage] = await db.sql`
INSERT INTO pointages (type, client_id, latitude, longitude)
VALUES (${body.type}, ${body.client_id || null}, ${body.latitude ?? null}, ${body.longitude ?? null})
RETURNING *
`;
return new Response(JSON.stringify(pointage), {
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
path: "/api/pointages",
};
