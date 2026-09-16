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

function cookieDeSesion(sesion) {
  return `hobbi_sesion=${sesion}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DIAS * 86400}`;
}

/* ---------- Helpers de contraseña (PBKDF2, sin librerías externas) ---------- */

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function hashearPassword(password, saltHex) {
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, keyMaterial, 256);
  return { hash: bytesToHex(new Uint8Array(bits)), salt: bytesToHex(salt) };
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
      headers: { 'Set-Cookie': cookieDeSesion(sesion) }
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

/* ---------- Registro / login con email + contraseña ---------- */

async function handleRegisterPost(request, env) {
  try {
    const { email, password, nombre } = await request.json();
    if (!email || !password || password.length < 6) {
      return new Response('Completá un mail válido y una contraseña de al menos 6 caracteres', { status: 400 });
    }
    const emailNorm = String(email).trim().toLowerCase();

    const existente = await env.DB.prepare('SELECT id, password_hash FROM usuarios WHERE email = ?').bind(emailNorm).first();
    if (existente) {
      if (!existente.password_hash) {
        return new Response('Ese mail ya está registrado con Google. Iniciá sesión con Google.', { status: 409 });
      }
      return new Response('Ese mail ya está registrado. Iniciá sesión.', { status: 409 });
    }

    const usuarioId = crypto.randomUUID();
    const { hash, salt } = await hashearPassword(password);

    await env.DB.prepare(
      `INSERT INTO usuarios (id, email, nombre, password_hash, password_salt) VALUES (?, ?, ?, ?, ?)`
    ).bind(usuarioId, emailNorm, (nombre || '').trim(), hash, salt).run();

    const sesion = await crearSesion(usuarioId, env.SESSION_SECRET);
    return json({ ok: true, email: emailNorm, nombre: (nombre || '').trim(), foto: '' }, {
      headers: { 'Set-Cookie': cookieDeSesion(sesion) }
    });
  } catch (err) {
    return new Response('Error de servidor: ' + err.message, { status: 500 });
  }
}

async function handleLoginPost(request, env) {
  try {
    const { email, password } = await request.json();
    if (!email || !password) return new Response('Faltan datos', { status: 400 });
    const emailNorm = String(email).trim().toLowerCase();

    const usuario = await env.DB.prepare(
      'SELECT id, nombre, foto, password_hash, password_salt FROM usuarios WHERE email = ?'
    ).bind(emailNorm).first();

    if (!usuario || !usuario.password_hash) {
      return new Response('Mail o contraseña incorrectos', { status: 401 });
    }

    const { hash } = await hashearPassword(password, usuario.password_salt);
    if (hash !== usuario.password_hash) {
      return new Response('Mail o contraseña incorrectos', { status: 401 });
    }

    const sesion = await crearSesion(usuario.id, env.SESSION_SECRET);
    return json({ ok: true, email: emailNorm, nombre: usuario.nombre || '', foto: usuario.foto || '' }, {
      headers: { 'Set-Cookie': cookieDeSesion(sesion) }
    });
  } catch (err) {
    return new Response('Error de servidor: ' + err.message, { status: 500 });
  }
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
    if (url.pathname === '/api/auth/register' && request.method === 'POST') return handleRegisterPost(request, env);
    if (url.pathname === '/api/auth/login' && request.method === 'POST') return handleLoginPost(request, env);
    if (url.pathname === '/api/me' && request.method === 'GET') return handleMe(request, env);
    if (url.pathname === '/api/data' && request.method === 'GET') return handleDataGet(request, env);
    if (url.pathname === '/api/data' && request.method === 'POST') return handleDataPost(request, env);

    // Todo lo que no sea /api/* se sirve como archivo estático (index.html, etc).
    return env.ASSETS.fetch(request);
  }
};
