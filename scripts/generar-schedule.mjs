// Genera public/data/schedule.json con el calendario de TVMaze (/schedule/web) ya "masticado",
// para que la app no tenga que pedir ~50 días a TVMaze en cada visita.
// Se corre desde .github/workflows/schedule.yml (Node 20+, sin dependencias).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const BASE = process.env.TVMAZE_BASE || 'https://api.tvmaze.com';
const SALIDA = process.env.SALIDA || 'public/data/schedule.json';
const DESDE = -7;          // días hacia atrás (rail "Nuevas" usa 5)
const HASTA = 46;          // días hacia adelante (Próximos Estrenos usa 45)
const PAUSA_MS = Number(process.env.PAUSA_MS ?? 700); // ~85 pedidos/min, muy por debajo del límite de TVMaze (20 cada 10 s)
const MIN_DIAS_OK = 40;    // si salen menos días que esto, no se pisa el archivo anterior

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const fechaISO = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

async function pedirDia(fecha) {
  for (let intento = 0; intento < 5; intento++) {
    try {
      const res = await fetch(`${BASE}/schedule/web?date=${fecha}`, {
        headers: { 'User-Agent': 'hobbi-schedule-bot (github.com/mafero171189-byte/hobbi)' },
        signal: AbortSignal.timeout(20000)
      });
      if (res.ok) {
        const json = await res.json();
        if (Array.isArray(json)) return json;
        throw new Error('respuesta no es una lista');
      }
      if (res.status === 429 || res.status >= 500) {
        const ra = parseInt(res.headers.get('Retry-After'), 10);
        await dormir((ra > 0 ? Math.min(ra, 20) : 3 * (intento + 1)) * 1000);
        continue;
      }
      throw new Error('HTTP ' + res.status);
    } catch (e) {
      if (intento === 4) throw e;
      await dormir(2000 * (intento + 1));
    }
  }
  throw new Error('sin respuesta');
}

// Misma forma que deja normalizarEntradaWeb() en index.html (a propósito: el app la vuelve a normalizar sin problema).
function normalizar(ep) {
  const show = ep.show || (ep._embedded && ep._embedded.show) || null;
  if (!show) return [];
  const agrupados = ep._embedded && Array.isArray(ep._embedded.episodes) ? ep._embedded.episodes : null;
  if (agrupados && agrupados.length) {
    return agrupados.map((sub) => ({
      id: sub.id, show, season: sub.season, number: sub.number,
      airstamp: sub.airstamp || ep.airstamp, airtime: sub.airtime || ep.airtime, airdate: sub.airdate || ep.airdate
    }));
  }
  return [{ id: ep.id, show, season: ep.season, number: ep.number, airstamp: ep.airstamp, airtime: ep.airtime, airdate: ep.airdate }];
}

// Solo los campos de la serie que el app usa en los rieles (la ficha completa se pide aparte al abrir una serie).
function adelgazarCanal(c) {
  if (!c) return c ?? null;
  const { officialSite, ...resto } = c;
  return resto;
}
function adelgazarShow(s) {
  return {
    id: s.id, name: s.name, type: s.type, language: s.language, genres: s.genres, status: s.status,
    premiered: s.premiered, ended: s.ended, rating: s.rating, weight: s.weight, schedule: s.schedule,
    network: adelgazarCanal(s.network), webChannel: adelgazarCanal(s.webChannel),
    image: s.image ? { medium: s.image.medium, original: s.image.original } : null
  };
}

// Qué entradas de cada día hace falta guardar (según desfase respecto de HOY en UTC; el app usa su fecha local,
// que puede diferir en ±1 día, por eso las ventanas llevan un día de margen):
//   -2..+8  → todo (Nuevos episodios mira -1..+7 y usa capítulos > 1)
//   más atrás → solo T1E1 (rail "Nuevas")
//   más adelante → solo capítulos número 1 (Estrenos / Vuelven / Próximos Estrenos)
function filtrarPorDesfase(entradas, desfase) {
  if (desfase >= -2 && desfase <= 8) return entradas;
  if (desfase < -2) return entradas.filter((e) => e.season === 1 && e.number === 1);
  return entradas.filter((e) => e.number === 1);
}

async function leerPrevio() {
  try { return JSON.parse(await readFile(SALIDA, 'utf8')); } catch { return null; }
}

const previo = await leerPrevio();
const hoy = new Date();
const hoyUTC = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate()));
const dias = {};
let fallidos = 0;
let seguidosFallidos = 0;

for (let desfase = DESDE; desfase <= HASTA; desfase++) {
  const d = new Date(hoyUTC); d.setUTCDate(d.getUTCDate() + desfase);
  const fecha = fechaISO(d);
  try {
    const crudo = await pedirDia(fecha);
    const entradas = filtrarPorDesfase(crudo.flatMap(normalizar), desfase)
      .map((e) => ({ ...e, show: adelgazarShow(e.show) }));
    dias[fecha] = entradas;
    seguidosFallidos = 0;
  } catch (e) {
    fallidos++;
    seguidosFallidos++;
    console.warn(`⚠️  ${fecha}: ${e.message}`);
    // Si el día falló, se conserva lo de la corrida anterior (si había); si no, queda afuera y el app lo pide a TVMaze.
    if (previo && previo.dias && Array.isArray(previo.dias[fecha])) dias[fecha] = previo.dias[fecha];
  }
  if (seguidosFallidos >= 4) { console.error('❌ TVMaze no responde (4 días seguidos fallidos). Se corta sin tocar el archivo anterior.'); process.exit(1); }
  await dormir(PAUSA_MS);
}

const cantidad = Object.keys(dias).length;
if (cantidad < MIN_DIAS_OK) {
  console.error(`❌ Solo ${cantidad} días armados (mínimo ${MIN_DIAS_OK}). No se toca el archivo anterior.`);
  process.exit(1);
}

await mkdir(dirname(SALIDA), { recursive: true });
await writeFile(SALIDA, JSON.stringify({ generadoEn: Date.now(), dias }));
const totalEntradas = Object.values(dias).reduce((n, l) => n + l.length, 0);
console.log(`✅ ${cantidad} días, ${totalEntradas} entradas, ${fallidos} pedidos fallidos → ${SALIDA}`);
