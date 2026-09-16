-- migracion_login_email.sql — agrega soporte de login con email+contraseña
-- Aplicar con: wrangler d1 execute hobbi-db --file=./migracion_login_email.sql --remote

ALTER TABLE usuarios ADD COLUMN password_hash TEXT;
ALTER TABLE usuarios ADD COLUMN password_salt TEXT;

-- Evita que se registren dos cuentas con el mismo mail (una por Google y otra
-- por contraseña, por ejemplo).
CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_email ON usuarios(email);
