import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';

const { PJN_USER, PJN_PASS, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

if (!PJN_USER || !PJN_PASS || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error('Faltan variables de entorno: PJN_USER, PJN_PASS, SUPABASE_URL, SUPABASE_SERVICE_KEY');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const HORA = /^\d{1,2}:\d{2}$/;
const DIA_MES = /^\d{1,2}\s+[a-záéíóúñ]{3,4}\.?$/i;

const MESES = {
  ene: 0, feb: 1, mar: 2, abr: 3, may: 4, jun: 5,
  jul: 6, ago: 7, sep: 8, set: 8, oct: 9, nov: 10, dic: 11,
};

// La grilla del PJN no muestra el año, así que lo inferimos a partir de "ahora":
// si la fecha calculada cae muy en el futuro, es del año anterior.
function parseFechaOrden(fecha_label, ahora = new Date()) {
  if (!fecha_label) return null;
  if (HORA.test(fecha_label)) {
    const [h, min] = fecha_label.split(':').map(Number);
    return new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), ahora.getUTCDate(), h, min)).toISOString();
  }
  const m = fecha_label.match(/^(\d{1,2})\s+([a-záéíóúñ]{3,4})\.?$/i);
  if (!m) return null;
  const dia = Number(m[1]);
  const mesKey = m[2].toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').slice(0, 3);
  const mes = MESES[mesKey];
  if (mes === undefined) return null;
  let fecha = new Date(Date.UTC(ahora.getUTCFullYear(), mes, dia, 12, 0, 0));
  if (fecha.getTime() - ahora.getTime() > 30 * 24 * 60 * 60 * 1000) {
    fecha = new Date(Date.UTC(ahora.getUTCFullYear() - 1, mes, dia, 12, 0, 0));
  }
  return fecha.toISOString();
}

function parseEventos(rowsData) {
  return rowsData.map(({ ariaLabel, href, texto }) => {
    if (!href) return null;
    let url;
    try {
      url = new URL(href);
    } catch {
      return null;
    }
    const eid = url.searchParams.get('eid');
    if (!eid) return null;

    const m = (ariaLabel || '').match(/Tipo de evento:\s*([^.]+)\.\s*Expediente\s+(.+?)\s-\s(.+)/s);
    const tipo_evento = m ? m[1].trim() : null;
    const expediente = m ? m[2].trim() : null;
    const caratula = m ? m[3].trim() : null;

    const lineas = (texto || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const fecha_label = lineas.find((l) => HORA.test(l) || DIA_MES.test(l)) || null;

    return {
      id: eid,
      expediente: expediente || '(sin expediente)',
      caratula,
      tipo_evento,
      fecha_label,
      fecha_orden: parseFechaOrden(fecha_label),
      link_causa: href,
      scraped_at: new Date().toISOString(),
    };
  }).filter(Boolean);
}

async function diagnosticar(page, etiqueta) {
  try {
    console.log(`--- DIAGNOSTICO (${etiqueta}) ---`);
    console.log('URL actual:', page.url());
    const texto = await page.locator('body').innerText();
    console.log('Texto visible de la pagina:');
    console.log(texto.slice(0, 3000));
    await page.screenshot({ path: 'debug.png', fullPage: true });
    console.log('Screenshot guardado en scripts/debug.png');
  } catch (e) {
    console.log('No se pudo generar el diagnostico:', e.message);
  }
}

// ── Detalle de lo proveído ──────────────────────────────────────────────
// Al abrir la novedad, el SCW muestra la lista de actuaciones con su detalle
// en texto ("FIRMA DESPACHO · DECRETO - INCORPORESE INFORME..."). Lo leemos
// gratis, sin IA, y lo guardamos en eventos_pjn.detalle para la agenda.
// OJO: el repo es público, así que nunca se imprime el contenido en los logs.
const TIPOS = { 'FIRMA DESPACHO': 'Despacho', 'ESCRITO AGREGADO': 'Escrito', 'DEO': 'Oficio' };
const SALTEAR = /^(EVENTO|CEDULA)/i;

function prolijo(txt) {
  const orig = txt.trim().split(/\s+/);
  const out = orig.map((w, i) => {
    if (/\d/.test(w) || !/[AEIOUÁÉÍÓÚaeiouáéíóú]/.test(w)) return w; // siglas (RPL, SPF) y números quedan
    const l = w.toLowerCase();
    return i === 0 ? l.charAt(0).toUpperCase() + l.slice(1) : l;
  });
  return out.join(' ');
}

function leerActuaciones(texto, fechaIso) {
  const [y, m, d] = fechaIso.split('-').map(Number);
  const re = /Fecha:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*Tipo actuacion:\s*([^\t\n]+)\s*Detalle:\s*([^\t\n]+)(?:[ \t]*\n\s*(\d+)\s*\/\s*(\d+))?/g;
  const partes = [];
  for (const x of texto.matchAll(re)) {
    if (+x[1] !== d || +x[2] !== m || +x[3] !== y) continue;
    const tipo = x[4].trim();
    if (SALTEAR.test(tipo)) continue;
    let det = prolijo(x[5].trim().replace(/\[Presentado[^\]]*\]/i, ''));
    if (x[6]) det += x[6] === x[7] ? ` (fs. ${x[6]})` : ` (fs. ${x[6]}-${x[7]})`;
    partes.push(`${TIPOS[tipo.toUpperCase()] || prolijo(tipo)}: ${det}`);
  }
  return partes.join(' · ');
}

async function completarDetalles(page, eventos) {
  const hace15 = new Date(Date.now() - 15 * 864e5).toISOString();
  const recientes = eventos.filter((e) => e.fecha_orden && e.fecha_orden >= hace15);
  if (!recientes.length) return [];
  const { data: previos } = await supabase.from('eventos_pjn').select('id,detalle_fecha').in('id', recientes.map((e) => e.id));
  const ya = new Map((previos || []).map((p) => [p.id, p.detalle_fecha]));
  let leidos = 0, vacios = 0, fallas = 0;
  const nuevos = [];
  for (const e of recientes.slice(0, 20)) {
    const fecha = new Date(new Date(e.fecha_orden).getTime() - 3 * 3600e3).toISOString().slice(0, 10);
    if (ya.get(e.id) === fecha) continue;
    try {
      await page.goto(e.link_causa, { waitUntil: 'networkidle', timeout: 45000 });
      const detalle = leerActuaciones(await page.locator('body').innerText(), fecha);
      nuevos.push({ id: e.id, detalle: detalle || null, detalle_fecha: fecha });
      detalle ? leidos++ : vacios++;
    } catch (err) {
      fallas++;
    }
  }
  console.log(`Detalles: ${leidos} leidos, ${vacios} sin actuacion ese dia, ${fallas} fallas`);
  return nuevos;
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.goto('https://portalpjn.pjn.gov.ar/inicio', { waitUntil: 'networkidle' });

  if (page.url().includes('sso.pjn.gov.ar')) {
    await page.getByLabel('Usuario').fill(PJN_USER);
    await page.getByLabel('Contraseña').fill(PJN_PASS);
    await page.getByRole('button', { name: 'Ingresar' }).click();
    try {
      await page.waitForURL('**/inicio', { timeout: 30000 });
    } catch (e) {
      await diagnosticar(page, 'fallo esperando redireccion post-login');
      await browser.close();
      throw e;
    }
  }

  const grid = page.getByRole('grid', { name: 'Listado de eventos' });
  try {
    await grid.waitFor({ timeout: 30000 });
  } catch (e) {
    await diagnosticar(page, 'fallo esperando grid de eventos');
    await browser.close();
    throw e;
  }

  // La lista de "Entradas" queda en caché de la sesión hasta que se pulsa
  // "Refrescar"; sin este clic el scraper lee eventos viejos. Además, tras
  // el clic la grilla se actualiza de forma asincrónica, así que esperamos
  // a que su contenido deje de cambiar antes de leerla (si no, hay carrera
  // entre la lectura y el refresco y se cuelan filas viejas).
  try {
    await page.getByRole('button', { name: /refrescar/i }).click({ timeout: 10000 });
    await page.waitForLoadState('networkidle');
    let previo = null;
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(1000);
      const actual = await grid.innerText();
      if (actual === previo) break;
      previo = actual;
    }
  } catch (e) {
    console.log('No se pudo hacer clic en Refrescar:', e.message);
  }

  const rows = await grid.getByRole('row').all();
  const rowsData = [];
  for (const row of rows) {
    const ariaLabel = await row.getAttribute('aria-label');
    const texto = await row.innerText();
    const linkEl = row.locator('a[href*="consultaNovedad"]').first();
    const href = (await linkEl.count()) ? await linkEl.getAttribute('href') : null;
    rowsData.push({ ariaLabel, texto, href });
  }

  const eventosConDuplicados = parseEventos(rowsData);

  // El portal lista el mismo evento (mismo eid) mas de una vez cuando tiene
  // varios documentos asociados, y cada fila puede traer una fecha distinta
  // (la del documento que le toco, no necesariamente la mas reciente). Nos
  // quedamos con la fila de fecha_orden mas nueva por id, no con la ultima
  // que aparezca en el grid, para no perder actualizaciones reales.
  const porId = new Map();
  for (const e of eventosConDuplicados) {
    const previo = porId.get(e.id);
    if (!previo || (e.fecha_orden && (!previo.fecha_orden || e.fecha_orden > previo.fecha_orden))) {
      porId.set(e.id, e);
    }
  }
  const eventos = [...porId.values()];
  console.log(`Encontrados ${eventosConDuplicados.length} eventos (${eventos.length} unicos)`);

  let detalles = [];
  try {
    detalles = await completarDetalles(page, eventos);
  } catch (e) {
    console.log('No se pudieron leer los detalles:', e.message);
  }
  await browser.close();

  if (eventos.length) {
    const { error } = await supabase.from('eventos_pjn').upsert(eventos, { onConflict: 'id' });
    if (error) throw error;
  }
  // el detalle va aparte, para no pisar con null los que no se releyeron
  for (const d of detalles) {
    const { error } = await supabase.from('eventos_pjn').update({ detalle: d.detalle, detalle_fecha: d.detalle_fecha }).eq('id', d.id);
    if (error) console.log('No se pudo guardar un detalle:', error.message);
  }

  console.log('Sync OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
