-- Ajoute la position GPS aux pointages

ALTER TABLE pointages ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION;
ALTER TABLE pointages ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;
