-- schema.sql — esquema de D1 para Hobbi
-- Aplicar con: wrangler d1 execute hobbi-db --file=./schema.sql --remote

CREATE TABLE IF NOT EXISTS usuarios (
  id TEXT PRIMARY KEY,        -- "sub" de Google: id único y estable de la cuenta
  email TEXT NOT NULL,
  nombre TEXT,
  foto TEXT,
  idioma TEXT DEFAULT 'es',
  creado_en INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS favoritos (
  usuario_id TEXT NOT NULL,
  show_id INTEGER NOT NULL,
  datos TEXT NOT NULL,        -- JSON: { id, name, image, status, episodeIds, totalEpisodesCount, proximoEstreno, agregadaEn }
  PRIMARY KEY (usuario_id, show_id),
  FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
);

CREATE TABLE IF NOT EXISTS episodios_vistos (
  usuario_id TEXT NOT NULL,
  episodio_id INTEGER NOT NULL,
  visto INTEGER DEFAULT 1,
  PRIMARY KEY (usuario_id, episodio_id),
  FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
);

CREATE INDEX IF NOT EXISTS idx_favoritos_usuario ON favoritos(usuario_id);
CREATE INDEX IF NOT EXISTS idx_vistos_usuario ON episodios_vistos(usuario_id);
