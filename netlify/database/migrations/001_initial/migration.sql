-- Schema initial : clients, mandats, pointages, reglages

CREATE TABLE IF NOT EXISTS clients (
  id SERIAL PRIMARY KEY,
  nom TEXT NOT NULL,
  adresse TEXT,
  telephone TEXT,
  trajet_minutes INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

CREATE TABLE IF NOT EXISTS mandats (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  description TEXT,
  duree_heures NUMERIC(5,2),
  montant_facture NUMERIC(10,2),
  notes TEXT,
  nb_photos INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

CREATE TABLE IF NOT EXISTS pointages (
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL,
  client_id INTEGER REFERENCES clients(id),
  horodatage TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

CREATE TABLE IF NOT EXISTS reglages (
  id INTEGER PRIMARY KEY DEFAULT 1,
  adresse_entrepot TEXT,
  arrondi_minutes INTEGER NOT NULL DEFAULT 30,
  semaine_debut TEXT NOT NULL DEFAULT 'dimanche',
  detection_gps BOOLEAN NOT NULL DEFAULT true,
  trajets_calcules BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT reglages_single_row CHECK (id = 1)
  );

INSERT INTO reglages (id, adresse_entrepot)
VALUES (1, '1450 rue Ontario E., Montreal')
ON CONFLICT (id) DO NOTHING;

INSERT INTO clients (nom, adresse, trajet_minutes)
SELECT * FROM (VALUES
  ('Clinique Dentaire Roy', '1240 rue Saint-Zotique E.', 26),
  ('Copropriete Lafontaine', '3400 rue Papineau', 22),
  ('Residence Beaulieu', '78 rue Fabre', 25)
  ) AS seed(nom, adresse, trajet_minutes)
WHERE NOT EXISTS (SELECT 1 FROM clients);
