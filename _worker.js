// _worker.js — punto de entrada único del Worker.
// Cloudflare lo detecta automáticamente si está en la raíz del proyecto junto
// a los assets estáticos (index.html). Rutea /api/* a la lógica de
// autenticación/datos y todo lo demás lo sirve como archivo estático (env.ASSETS).

const GOOGLE_CLIENT_ID = '403618822429-pshtrss0fg4nnojujh6aqqagaboia66h.apps.googleusercontent.com';
const SESSION_DIAS = 30;

/* ---------- Helpers de sesión (cookie firmada con HMAC) ---------- */

async function firmar(valor, secreto) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secreto),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const firma = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(valor));
  return btoa(String.fromCharCode(...new Uint8Array(firma)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function crearSesion(usuarioId, secreto) {
  const exp = Date.now() + SESSION_DIAS * 24 * 60 * 60 * 1000;
  const payload = `${usuarioId}.${exp}`;
  const firma = await firmar(payload, secreto);
  return `${payload}.${firma}`;
}

async function usuarioDesdeCookie(request, secreto) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/hobbi_sesion=([^;]+)/);
  if (!match) return null;

  const partes = match[1].split('.');
  if (partes.length !== 3) return null;
  const [usuarioId, exp, firma] = partes;

  if (Date.now() > Number(exp)) return null;

  const firmaEsperada = await firmar(`${usuarioId}.${exp}`, secreto);
  if (firma !== firmaEsperada) return null;

  return usuarioId;
}

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) }
  });
}

/* ---------- Endpoints ---------- */

async function handleAuthPost(request, env) {
  try {
    const { credential } = await request.json();
    if (!credential) return new Response('Falta credential', { status: 400 });

    const verifRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
    if (!verifRes.ok) return new Response('Token inválido', { status: 401 });
    const payload = await verifRes.json();

    if (payload.aud !== GOOGLE_CLIENT_ID) {
      return new Response('Token de otra app', { status: 401 });
    }

    const usuarioId = payload.sub;
    const email = payload.email || '';
    const nombre = payload.name || '';
    const foto = payload.picture || '';

    await env.DB.prepare(
      `INSERT INTO usuarios (id, email, nombre, foto) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET email = excluded.email, nombre = excluded.nombre, foto = excluded.foto`
    ).bind(usuarioId, email, nombre, foto).run();

    const sesion = await crearSesion(usuarioId, env.SESSION_SECRET);

    return json({ ok: true, email, nombre, foto }, {
      headers: {
        'Set-Cookie': `hobbi_sesion=${sesion}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DIAS * 86400}`
      }
    });
  } catch (err) {
    return new Response('Error de servidor: ' + err.message, { status: 500 });
  }
}

function handleAuthDelete() {
  return json({ ok: true }, {
    headers: { 'Set-Cookie': `hobbi_sesion=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` }
  });
}

async function handleMe(request, env) {
  const usuarioId = await usuarioDesdeCookie(request, env.SESSION_SECRET);
  if (!usuarioId) return json({ logueado: false });

  const usuario = await env.DB.prepare(
    'SELECT email, nombre, foto FROM usuarios WHERE id = ?'
  ).bind(usuarioId).first();

  return json({ logueado: true, ...usuario });
}

async function handleDataGet(request, env) {
  const usuarioId = await usuarioDesdeCookie(request, env.SESSION_SECRET);
  if (!usuarioId) return new Response('No autenticado', { status: 401 });

  const usuario = await env.DB.prepare('SELECT idioma FROM usuarios WHERE id = ?').bind(usuarioId).first();
  const favs = await env.DB.prepare('SELECT datos FROM favoritos WHERE usuario_id = ?').bind(usuarioId).all();
  const vistos = await env.DB.prepare('SELECT episodio_id FROM episodios_vistos WHERE usuario_id = ?').bind(usuarioId).all();

  const favoritos = favs.results.map(r => JSON.parse(r.datos));
  const episodiosVistos = {};
  vistos.results.forEach(r => { episodiosVistos[r.episodio_id] = true; });

  return json({ idioma: usuario?.idioma || 'es', favoritos, episodiosVistos });
}

async function handleDataPost(request, env) {
  const usuarioId = await usuarioDesdeCookie(request, env.SESSION_SECRET);
  if (!usuarioId) return new Response('No autenticado', { status: 401 });

  const { favoritos, episodiosVistos, idioma } = await request.json();
  const statements = [];

  if (idioma) {
    statements.push(env.DB.prepare('UPDATE usuarios SET idioma = ? WHERE id = ?').bind(idioma, usuarioId));
  }

  if (Array.isArray(favoritos)) {
    statements.push(env.DB.prepare('DELETE FROM favoritos WHERE usuario_id = ?').bind(usuarioId));
    favoritos.forEach(f => {
      statements.push(env.DB.prepare(
        'INSERT INTO favoritos (usuario_id, show_id, datos) VALUES (?, ?, ?)'
      ).bind(usuarioId, f.id, JSON.stringify(f)));
    });
  }

  if (episodiosVistos && typeof episodiosVistos === 'object') {
    statements.push(env.DB.prepare('DELETE FROM episodios_vistos WHERE usuario_id = ?').bind(usuarioId));
    Object.keys(episodiosVistos).forEach(epId => {
      if (episodiosVistos[epId]) {
        statements.push(env.DB.prepare(
          'INSERT INTO episodios_vistos (usuario_id, episodio_id, visto) VALUES (?, ?, 1)'
        ).bind(usuarioId, epId));
      }
    });
  }

  if (statements.length) await env.DB.batch(statements);
  return json({ ok: true });
}

/* ---------- Router ---------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/auth' && request.method === 'POST') return handleAuthPost(request, env);
    if (url.pathname === '/api/auth' && request.method === 'DELETE') return handleAuthDelete();
    if (url.pathname === '/api/me' && request.method === 'GET') return handleMe(request, env);
    if (url.pathname === '/api/data' && request.method === 'GET') return handleDataGet(request, env);
    if (url.pathname === '/api/data' && request.method === 'POST') return handleDataPost(request, env);

    // Todo lo que no sea /api/* se sirve como archivo estático (index.html, etc).
    return env.ASSETS.fetch(request);
  }
};
