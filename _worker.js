// _worker.js — punto de entrada único del Worker.
// Cloudflare lo detecta automáticamente si está en la raíz del proyecto junto
// a los assets estáticos (index.html). Rutea /api/* a la lógica de
// autenticación/datos y todo lo demás lo sirve como archivo estático (env.ASSETS).

const GOOGLE_CLIENT_ID = '403618822429-pshtrss0fg4nnojujh6aqqagaboia66h.apps.googleusercontent.com';
const SESSION_DIAS = 30;
const OMDB_API_KEY = 'a58fd568'; // OMDb — búsqueda de películas
const WATCHMODE_API_KEY = 'AqTbQT531bCAi2qT6BB8X8WZAJ0NFIsAjlvVdGUy'; // Watchmode — cartelera (populares, próximos estrenos, por plataforma)

// Versión actual del contenido de la app, para el chequeo de Live Update de
// la APK (ver index.html: chequearActualizacionApk). Va acá como constante
// del Worker y NO como archivo estático en public/ — si fuera un archivo
// físico, Cloudflare lo serviría directo sin pasar por este código, y
// entonces nunca llevaría los headers CORS que la APK necesita para poder
// leer la respuesta (por eso fallaba con "Failed to fetch": el archivo se
// servía bien, pero sin CORS, y el navegador bloqueaba la lectura).
// Para publicar una actualización de contenido: subís este número y
// desplegás — nada más.
const APP_LATEST_VERSION = '2026.09.20.2';

/* ---------- CORS (necesario desde que existe la APK de Capacitor) ----------
   La PWA se sirve desde este mismo dominio, así que nunca necesitó CORS
   (mismo origen). La APK corre en un origen distinto (https://localhost en
   Android/Capacitor), así que el navegador exige que el servidor declare
   explícitamente que permite ese origen — si no, bloquea el pedido antes de
   que el JS de la app pueda ver la respuesta ("Failed to fetch").
   Con cookies (credentials:'include' en el fetch del cliente), el header
   Access-Control-Allow-Origin NO puede ser '*' — tiene que ser el origen
   exacto, de ahí la lista blanca en vez de aceptar cualquiera. */
const ORIGENES_PERMITIDOS = [
  'https://localhost',          // APK Android (Capacitor, androidScheme: 'https')
  'capacitor://localhost',      // por si en el futuro se compila también para iOS
  'https://hobbi.mafero171189.workers.dev' // la propia PWA — no debería necesitarlo (mismo origen), pero no molesta
];

function headersCors(request) {
  const origen = request.headers.get('Origin');
  if (!origen || !ORIGENES_PERMITIDOS.includes(origen)) return {};
  return {
    'Access-Control-Allow-Origin': origen,
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin'
  };
}

function respuestaPreflight(request) {
  const origen = request.headers.get('Origin');
  if (!origen || !ORIGENES_PERMITIDOS.includes(origen)) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origen,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    }
  });
}

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
  // SameSite=None (en vez de Lax) porque la APK pide desde un origen distinto
  // (https://localhost) — con Lax, el navegador directamente descarta la
  // cookie en pedidos cross-origin y la sesión nunca queda guardada, aunque
  // el login haya funcionado bien del lado del servidor. None exige Secure
  // (ya lo tenía) para que el navegador la acepte igual.
  return `hobbi_sesion=${sesion}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${SESSION_DIAS * 86400}`;
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
    headers: {
      'Content-Type': 'application/json',
      // Hardening estándar: evita que el navegador intente adivinar un
      // Content-Type distinto al declarado (nosniff), y evita que este sitio
      // se pueda embeber dentro de un <iframe> de otro dominio (clickjacking).
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      ...(init.headers || {})
    }
  });
}

// Mismo criterio que json() pero para las respuestas de error en texto plano
// que ya usaba cada endpoint (login inválido, faltan datos, etc.) — antes no
// llevaban ningún header de seguridad porque se armaban con new Response(...)
// directo. Reemplaza uno por uno esos new Response(texto, {status}) sin
// cambiar el mensaje ni el status code que ya devolvía cada uno.
function errorResponse(mensaje, status) {
  return new Response(mensaje, {
    status,
    headers: { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' }
  });
}

/* ---------- Rate limiting (prevención de brute-force y enumeración) ---------- */

// Impide intentos ilimitados en login/registro por IP. Cada IP tiene un presupuesto
// de N intentos por ventana de tiempo (ej. 5 intentos en 5 minutos). Si se agota,
// se rechaza con 429 (Too Many Requests) hasta que la ventana expira.
async function chequearRateLimit(env, clave, maxIntentos = 5, ventanaSegundos = 300) {
  const actual = parseInt(await env.RATE_LIMIT_KV.get(clave) || '0', 10);
  if (actual >= maxIntentos) return false; // rechazar
  await env.RATE_LIMIT_KV.put(clave, String(actual + 1), { expirationTtl: ventanaSegundos });
  return true; // permitir
}

/* ---------- Endpoints ---------- */

async function handleAuthPost(request, env) {
  try {
    const { credential } = await request.json();
    if (!credential) return errorResponse('Falta credential', 400);

    const verifRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
    if (!verifRes.ok) return errorResponse('Token inválido', 401);
    const payload = await verifRes.json();

    if (payload.aud !== GOOGLE_CLIENT_ID) {
      return errorResponse('Token de otra app', 401);
    }

    const usuarioId = payload.sub;
    const email = String(payload.email || '').trim().toLowerCase();
    const nombre = payload.name || '';
    const foto = payload.picture || '';

    // Chequeo de colisión: si el email ya existe pero el ID es distinto, significa
    // que alguien se registró antes con ese email + contraseña (sin ser el dueño
    // real de la cuenta de Google). Rechazamos con un mensaje claro en vez de
    // intentar insertar, que rompería el UNIQUE INDEX(email) sin permiso.
    // Ver hallazgo #2 de la auditoría: "Colisión de email entre login Google y login por contraseña".
    const existentePorEmail = await env.DB.prepare(
      'SELECT id FROM usuarios WHERE email = ? AND id != ?'
    ).bind(email, usuarioId).first();

    if (existentePorEmail) {
      return errorResponse(
        'Este email ya está registrado con otro método. Iniciá sesión con el método que usaste antes, o contactá soporte si necesitás ayuda.',
        409
      );
    }

    await env.DB.prepare(
      `INSERT INTO usuarios (id, email, nombre, foto) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET email = excluded.email, nombre = excluded.nombre, foto = excluded.foto`
    ).bind(usuarioId, email, nombre, foto).run();

    const sesion = await crearSesion(usuarioId, env.SESSION_SECRET);

    return json({ ok: true, email, nombre, foto }, {
      headers: { 'Set-Cookie': cookieDeSesion(sesion) }
    });
  } catch (err) {
    return errorResponse('Error de servidor: ' + err.message, 500);
  }
}

function handleAuthDelete() {
  return json({ ok: true }, {
    headers: { 'Set-Cookie': `hobbi_sesion=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0` }
  });
}

/* ---------- Registro / login con email + contraseña ---------- */

async function handleRegisterPost(request, env) {
  try {
    const { email, password, nombre } = await request.json();
    if (!email || !password || password.length < 6) {
      return errorResponse('Completá un mail válido y una contraseña de al menos 6 caracteres', 400);
    }
    const emailNorm = String(email).trim().toLowerCase();

    // Rate limiting: máx 10 intentos por IP en 15 minutos. Previene enumeración de usuarios
    // y spam de registros. El límite es más generoso que login (10 vs 5) porque el registro
    // es menos frecuente en uso legítimo, pero igual corta el abuso automatizado.
    const ip = request.headers.get('CF-Connecting-IP') || 'desconocida';
    const permitido = await chequearRateLimit(env, `register:${ip}`, 10, 900);
    if (!permitido) {
      return errorResponse('Demasiados intentos. Probá de nuevo en unos minutos.', 429);
    }

    const existente = await env.DB.prepare('SELECT id, password_hash FROM usuarios WHERE email = ?').bind(emailNorm).first();
    if (existente) {
      // NO diferenciamos entre "ya registrado con Google" y "ya registrado con password"
      // para no filtra qué emails existen (prevención de enumeración de usuarios).
      // El mensaje es genérico: si el usuario no sabe qué método usó, puede intentar
      // loguearse con ambas opciones, que es UX razonable.
      return errorResponse('No se pudo completar el registro. Probá iniciando sesión si ya tenés cuenta.', 409);
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
    return errorResponse('Error de servidor: ' + err.message, 500);
  }
}

async function handleLoginPost(request, env) {
  try {
    const { email, password } = await request.json();
    if (!email || !password) return errorResponse('Faltan datos', 400);
    const emailNorm = String(email).trim().toLowerCase();

    // Rate limiting: máx 5 intentos por IP en 5 minutos. Previene brute-force de contraseñas.
    const ip = request.headers.get('CF-Connecting-IP') || 'desconocida';
    const permitido = await chequearRateLimit(env, `login:${ip}`, 5, 300);
    if (!permitido) {
      return errorResponse('Demasiados intentos. Probá de nuevo en unos minutos.', 429);
    }

    const usuario = await env.DB.prepare(
      'SELECT id, nombre, foto, password_hash, password_salt FROM usuarios WHERE email = ?'
    ).bind(emailNorm).first();

    if (!usuario || !usuario.password_hash) {
      return errorResponse('Mail o contraseña incorrectos', 401);
    }

    const { hash } = await hashearPassword(password, usuario.password_salt);
    if (hash !== usuario.password_hash) {
      return errorResponse('Mail o contraseña incorrectos', 401);
    }

    const sesion = await crearSesion(usuario.id, env.SESSION_SECRET);
    return json({ ok: true, email: emailNorm, nombre: usuario.nombre || '', foto: usuario.foto || '' }, {
      headers: { 'Set-Cookie': cookieDeSesion(sesion) }
    });
  } catch (err) {
    return errorResponse('Error de servidor: ' + err.message, 500);
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

/* ---------- Datos (favoritos + episodios vistos) ----------
   Guardados como UN SOLO JSON por usuario, en 2 columnas de la tabla
   usuarios (favoritos_json, episodios_vistos_json), en vez de una fila por
   serie/episodio. Esto baja el consumo de escrituras de D1 de ~cientos de
   filas por sync a 1 sola fila (UPDATE) por sync — con el diseño anterior
   (DELETE + INSERT por cada favorito y cada episodio visto), una cuenta con
   pocos favoritos pero muchos episodios marcados podía gastar el límite
   diario gratis de D1 en una sola sesión de uso normal. */

async function handleDataGet(request, env) {
  const usuarioId = await usuarioDesdeCookie(request, env.SESSION_SECRET);
  if (!usuarioId) return errorResponse('No autenticado', 401);

  const usuario = await env.DB.prepare(
    'SELECT idioma, favoritos_json, episodios_vistos_json FROM usuarios WHERE id = ?'
  ).bind(usuarioId).first();

  let favoritos = [];
  let episodiosVistos = {};
  try {
    if (usuario?.favoritos_json) favoritos = JSON.parse(usuario.favoritos_json);
    if (usuario?.episodios_vistos_json) episodiosVistos = JSON.parse(usuario.episodios_vistos_json);
  } catch {
    // Si el JSON guardado estuviera corrupto por algún motivo, mejor devolver
    // vacío que romper el endpoint entero — el cliente lo toma como "sin datos".
  }

  return json({ idioma: usuario?.idioma || 'es', favoritos, episodiosVistos });
}

async function handleDataPost(request, env) {
  const usuarioId = await usuarioDesdeCookie(request, env.SESSION_SECRET);
  if (!usuarioId) return errorResponse('No autenticado', 401);

  const { favoritos, episodiosVistos, idioma } = await request.json();

  // Sin este chequeo, una cuenta autenticada (crearla es gratis e instantáneo,
  // sin ningún freno) podía mandar un array de favoritos con miles de
  // entradas falsas, o strings gigantes repetidos, e inflar el storage/las
  // escrituras de D1 sin límite — justo el tipo de abuso que agota la cuota
  // gratis con pocos usuarios maliciosos, sin que haga falta tráfico real.
  // Los topes de acá son generosos para cualquier uso real (nadie tiene miles
  // de series favoritas) pero cortan el abuso.
  const MAX_FAVORITOS = 500;
  const MAX_EPISODIOS_VISTOS = 5000;
  const IDIOMAS_VALIDOS = new Set(['es', 'en']);

  if (idioma && !IDIOMAS_VALIDOS.has(idioma)) {
    return errorResponse('Idioma inválido', 400);
  }
  if (Array.isArray(favoritos)) {
    if (favoritos.length > MAX_FAVORITOS) {
      return errorResponse('Demasiados favoritos', 400);
    }
    // El id puede ser numérico (series, TVMaze) o string (películas, IMDb —
    // ej. "tt1234567"). Antes solo se aceptaba number, así que cualquier
    // favorito de película hacía fallar la validación entera del array.
    const formaValida = favoritos.every(f =>
      f && typeof f === 'object'
      && (typeof f.id === 'number' || (typeof f.id === 'string' && f.id.length < 50))
      && typeof f.name === 'string' && f.name.length < 300
    );
    if (!formaValida) return errorResponse('Formato de favoritos inválido', 400);
  }
  if (episodiosVistos && typeof episodiosVistos === 'object') {
    if (Object.keys(episodiosVistos).length > MAX_EPISODIOS_VISTOS) {
      return errorResponse('Demasiados episodios marcados', 400);
    }
  }

  const campos = [];
  const valores = [];

  if (idioma) {
    campos.push('idioma = ?');
    valores.push(idioma);
  }
  if (Array.isArray(favoritos)) {
    campos.push('favoritos_json = ?');
    valores.push(JSON.stringify(favoritos));
  }
  if (episodiosVistos && typeof episodiosVistos === 'object') {
    campos.push('episodios_vistos_json = ?');
    valores.push(JSON.stringify(episodiosVistos));
  }

  // Nada que guardar (body vacío o sin ninguno de los 3 campos esperados):
  // no hace falta tocar la base.
  if (!campos.length) return json({ ok: true });

  valores.push(usuarioId);
  await env.DB.prepare(
    `UPDATE usuarios SET ${campos.join(', ')} WHERE id = ?`
  ).bind(...valores).run();

  return json({ ok: true });
}

/* ---------- Eliminar cuenta ---------- */

async function handleAccountDelete(request, env) {
  const usuarioId = await usuarioDesdeCookie(request, env.SESSION_SECRET);
  if (!usuarioId) return errorResponse('No autenticado', 401);

  try {
    // Las tablas favoritos/episodios_vistos ya no se usan para escribir datos
    // nuevos, pero por las dudas de que un usuario viejo todavía tenga filas
    // ahí (de antes de esta migración), las limpiamos igual al borrar la cuenta.
    await env.DB.batch([
      env.DB.prepare('DELETE FROM favoritos WHERE usuario_id = ?').bind(usuarioId),
      env.DB.prepare('DELETE FROM episodios_vistos WHERE usuario_id = ?').bind(usuarioId),
      env.DB.prepare('DELETE FROM usuarios WHERE id = ?').bind(usuarioId)
    ]);
  } catch (err) {
    return errorResponse('Error de servidor: ' + err.message, 500);
  }

  // Además de borrar los datos, cerramos la sesión: la cookie ya no sirve
  // porque el usuario al que apuntaba dejó de existir.
  return json({ ok: true }, {
    headers: { 'Set-Cookie': `hobbi_sesion=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0` }
  });
}

/* ---------- Búsqueda de películas (OMDb) ---------- */

async function handleMoviesSearch(request, env) {
  const url = new URL(request.url);
  const q = url.searchParams.get('q') || '';
  
  if (!q || q.length < 2) {
    return errorResponse('Parámetro q requerido (mín. 2 caracteres)', 400);
  }

  try {
    const res = await fetch(
      `https://www.omdbapi.com/?apikey=${OMDB_API_KEY}&s=${encodeURIComponent(q)}&type=movie`
    );
    const data = await res.json();
    
    // OMDb devuelve { Search: [...], totalResults, Response }. Cuando
    // Response es "False", puede ser "no encontró nada" (data.Error =
    // "Movie not found!") — eso sí es un resultado vacío normal — o puede
    // ser un problema real (key inválida/sin activar, límite alcanzado,
    // etc), que antes tapábamos por accidente devolviendo igual un array
    // vacío: parecía "no encontró nada" cuando en realidad OMDb ni
    // siquiera llegó a buscar. Ahora esos casos sí devuelven error real.
    if (data.Response === 'False') {
      if (data.Error === 'Movie not found!') {
        return json({ resultados: [] });
      }
      return errorResponse('OMDb: ' + (data.Error || 'error desconocido'), 502);
    }
    if (!data.Search) {
      return json({ resultados: [] });
    }
    
    // Mapeamos al formato que espera el frontend (compatible con TVMaze)
    const resultados = data.Search.slice(0, 10).map(m => ({
      id: m.imdbID,
      name: m.Title,
      tipo: 'pelicula',
      image: m.Poster !== 'N/A' ? m.Poster : null,
      year: m.Year,
      imdbID: m.imdbID
    }));
    
    return json({ resultados });
  } catch (err) {
    return errorResponse('Error buscando en OMDb: ' + err.message, 500);
  }
}

// OMDb devuelve "Released" como "15 Mar 2024" (o "N/A" si no se sabe).
// Lo convertimos a YYYY-MM-DD para que el frontend lo trate igual que
// cualquier otra fecha de la app (comparaciones, ordenamiento, etc).
function parsearFechaOMDb(released) {
  if (!released || released === 'N/A') return null;
  const meses = { Jan:'01', Feb:'02', Mar:'03', Apr:'04', May:'05', Jun:'06', Jul:'07', Aug:'08', Sep:'09', Oct:'10', Nov:'11', Dec:'12' };
  const partes = released.split(' '); // ["15", "Mar", "2024"]
  if (partes.length !== 3 || !meses[partes[1]]) return null;
  return `${partes[2]}-${meses[partes[1]]}-${partes[0].padStart(2, '0')}`;
}

async function handleMoviesDetalle(request, env) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id') || '';
  if (!id) return errorResponse('Parámetro id requerido', 400);

  try {
    const res = await fetch(`https://www.omdbapi.com/?apikey=${OMDB_API_KEY}&i=${encodeURIComponent(id)}&plot=short`);
    const data = await res.json();
    if (data.Response === 'False') return errorResponse(data.Error || 'No encontrada', 404);

    return json({
      id: data.imdbID,
      name: data.Title,
      tipo: 'pelicula',
      image: data.Poster !== 'N/A' ? data.Poster : null,
      year: data.Year,
      fechaEstreno: parsearFechaOMDb(data.Released),
      rating: data.imdbRating !== 'N/A' ? Number(data.imdbRating) : null,
      sinopsis: data.Plot !== 'N/A' ? data.Plot : ''
    });
  } catch (err) {
    return errorResponse('Error buscando en OMDb: ' + err.message, 500);
  }
}

/* ---------- Cartelera de películas (Watchmode) ----------
   A diferencia de OMDb (solo buscador), Watchmode SÍ tiene "populares",
   "próximos estrenos" y catálogo filtrado por plataforma de streaming.
   El plan gratis tiene 1.000 pedidos/mes — como este catálogo es EL MISMO
   para todos los usuarios (no es nada personal), lo cacheamos acá en KV
   por 12hs, compartido entre todo el mundo: si 500 personas abren la app
   en esas 12hs, Watchmode solo se consulta 1 vez, no 500. */

async function watchmodeGet(path, params) {
  const qs = new URLSearchParams({ apiKey: WATCHMODE_API_KEY, ...params });
  const res = await fetch(`https://api.watchmode.com/v1${path}?${qs.toString()}`);
  let data;
  try { data = await res.json(); } catch { data = null; }
  return { ok: res.ok, data };
}

// La lista de plataformas (id numérico de cada una en Watchmode) se resuelve
// por nombre en vez de hardcodear ids a mano — así no hay riesgo de tener un
// número viejo/incorrecto; se cachea 24hs porque casi no cambia.
async function obtenerFuentesWatchmode(env) {
  const cacheKey = 'watchmode_sources_v1';
  const cacheado = await env.RATE_LIMIT_KV.get(cacheKey);
  if (cacheado) {
    try { return JSON.parse(cacheado); } catch { /* si el cache quedó corrupto, lo repedimos */ }
  }
  const { ok, data } = await watchmodeGet('/sources/', {});
  if (!ok || !Array.isArray(data)) return [];
  await env.RATE_LIMIT_KV.put(cacheKey, JSON.stringify(data), { expirationTtl: 86400 });
  return data;
}

async function resolverSourceId(env, nombrePlataforma) {
  const fuentes = await obtenerFuentesWatchmode(env);
  const norm = nombrePlataforma.toLowerCase();
  const match = fuentes.find(f => f.name && f.name.toLowerCase().includes(norm));
  return match ? match.id : null;
}

// Watchmode no siempre trae poster en list-titles (depende del campo que
// use según el plan) — probamos los nombres de campo más probables, y si no
// aparece ninguno el frontend ya sabe caer solo al placeholder con inicial
// (mismo mecanismo que usan las series sin imagen).
function mapearTituloWatchmode(t) {
  const poster = t.poster || t.poster_url || t.image_url || null;
  return {
    id: 'wm_' + t.id,
    tipo: 'pelicula',
    name: t.title,
    image: poster,
    year: t.year ? String(t.year) : '',
    imdbID: t.imdb_id || null
  };
}

async function handleMoviesCartelera(request, env) {
  const url = new URL(request.url);
  const modo = url.searchParams.get('modo') || 'populares';
  const plataforma = url.searchParams.get('plataforma') || '';

  const cacheKey = `watchmode_cartelera_v1_${modo}_${plataforma.toLowerCase()}`;
  const cacheado = await env.RATE_LIMIT_KV.get(cacheKey);
  if (cacheado) {
    try { return json(JSON.parse(cacheado)); } catch { /* cache corrupto, seguimos y lo regeneramos */ }
  }

  const params = { types: 'movie', limit: '20' };
  if (modo === 'proximos') {
    // Watchmode espera release_date_start en formato YYYYMMDD sin guiones
    // — con guiones ("2026-09-23") lo trataba como si faltara el parámetro.
    const hoy = new Date().toISOString().split('T')[0].replace(/-/g, '');
    params.release_date_start = hoy;
    params.sort_by = 'release_date_asc';
  } else if (modo === 'plataforma') {
    if (!plataforma) return errorResponse('Falta parámetro plataforma', 400);
    const sourceId = await resolverSourceId(env, plataforma);
    if (!sourceId) return json({ resultados: [] }); // Watchmode no tiene esa plataforma con ese nombre
    params.source_ids = String(sourceId);
    params.sort_by = 'popularity_desc';
  } else {
    params.sort_by = 'popularity_desc';
  }

  try {
    const { ok, data } = await watchmodeGet('/list-titles/', params);
    if (!ok || !data) {
      return errorResponse('Watchmode: ' + (data && (data.statusMessage || data.Error) || 'error desconocido'), 502);
    }
    const titulos = Array.isArray(data.titles) ? data.titles.map(mapearTituloWatchmode) : [];
    const payload = { resultados: titulos };
    await env.RATE_LIMIT_KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: 43200 }); // 12hs, compartido entre todos
    return json(payload);
  } catch (err) {
    return errorResponse('Error consultando Watchmode: ' + err.message, 500);
  }
}

/* ---------- Router ---------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // /version.json necesita los mismos headers CORS que /api/* — la APK lo
    // pide cross-origin (desde https://localhost) para el chequeo de Live
    // Update. No es información sensible ni usa cookies, pero igual el
    // navegador exige el header Access-Control-Allow-Origin para dejar que
    // el JS de la app lea la respuesta.
    const esRutaApi = url.pathname.startsWith('/api/') || url.pathname === '/version.json';

    // El navegador manda un OPTIONS de "permiso" antes de cualquier POST/DELETE
    // con credentials:'include' desde un origen distinto (la APK). Si no lo
    // respondemos con los headers correctos, el pedido real nunca sale.
    if (esRutaApi && request.method === 'OPTIONS') {
      return respuestaPreflight(request);
    }

    let respuesta;
    if (url.pathname === '/api/auth' && request.method === 'POST') respuesta = await handleAuthPost(request, env);
    else if (url.pathname === '/api/auth' && request.method === 'DELETE') respuesta = handleAuthDelete();
    else if (url.pathname === '/api/auth/register' && request.method === 'POST') respuesta = await handleRegisterPost(request, env);
    else if (url.pathname === '/api/auth/login' && request.method === 'POST') respuesta = await handleLoginPost(request, env);
    else if (url.pathname === '/api/me' && request.method === 'GET') respuesta = await handleMe(request, env);
    else if (url.pathname === '/api/data' && request.method === 'GET') respuesta = await handleDataGet(request, env);
    else if (url.pathname === '/api/data' && request.method === 'POST') respuesta = await handleDataPost(request, env);
    else if (url.pathname === '/api/account' && request.method === 'DELETE') respuesta = await handleAccountDelete(request, env);
    else if (url.pathname === '/api/movies/search' && request.method === 'GET') respuesta = await handleMoviesSearch(request, env);
    else if (url.pathname === '/api/movies/detalle' && request.method === 'GET') respuesta = await handleMoviesDetalle(request, env);
    else if (url.pathname === '/api/movies/cartelera' && request.method === 'GET') respuesta = await handleMoviesCartelera(request, env);
    else if (url.pathname === '/version.json' && request.method === 'GET') respuesta = json({ version: APP_LATEST_VERSION });
    else {
      // Todo lo que no sea /api/* se sirve como archivo estático (index.html, etc).
      return env.ASSETS.fetch(request);
    }

    // Agregamos los headers CORS a la respuesta real de cualquier endpoint
    // /api/* — un solo lugar central, así no hay riesgo de que algún handler
    // se quede afuera si el día de mañana se agrega uno nuevo.
    const corsHeaders = headersCors(request);
    if (Object.keys(corsHeaders).length === 0) return respuesta;

    const headersFinales = new Headers(respuesta.headers);
    for (const [clave, valor] of Object.entries(corsHeaders)) headersFinales.set(clave, valor);
    return new Response(respuesta.body, {
      status: respuesta.status,
      statusText: respuesta.statusText,
      headers: headersFinales
    });
  }
};
