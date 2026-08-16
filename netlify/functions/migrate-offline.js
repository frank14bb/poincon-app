import { getDatabase } from "@netlify/database";

// GET /api/migrate-offline -> migration ponctuelle et sans danger (aucune donnee
// supprimee ni modifiee) pour supporter le mode hors ligne (Phase 8) : ajoute une
// colonne client_uuid (identifiant genere sur le telephone au moment de l'action,
// avant meme d'avoir une connexion) sur clients/pointages/mandats, ce qui permet de
// synchroniser sans jamais creer de doublon si une action est renvoyee deux fois.
// "ADD COLUMN IF NOT EXISTS" ne fait rien si la colonne existe deja : cette route
// peut etre appelee plusieurs fois sans risque.
export default async (req) => {
  if (req.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }
  const db = getDatabase();
  try {
    await db.sql`ALTER TABLE clients ADD COLUMN IF NOT EXISTS client_uuid UUID UNIQUE`;
    await db.sql`ALTER TABLE pointages ADD COLUMN IF NOT EXISTS client_uuid UUID UNIQUE`;
    await db.sql`ALTER TABLE mandats ADD COLUMN IF NOT EXISTS client_uuid UUID UNIQUE`;
    return new Response(JSON.stringify({ ok: true }), {
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
  path: "/api/migrate-offline",
};
