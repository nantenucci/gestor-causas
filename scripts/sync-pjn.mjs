import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';

const { PJN_USER, PJN_PASS, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

if (!PJN_USER || !PJN_PASS || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error('Faltan variables de entorno: PJN_USER, PJN_PASS, SUPABASE_URL, SUPABASE_SERVICE_KEY');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const HORA = /^\d{1,2}:\d{2}$/;
const DIA_MES = /^\d{1,2}\s+[a-záéíóúñ]{3,4}\.?$/i;

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

    const m = (ariaLabel || '').match(/Tipo de evento:\s*([^.]+)\.\s*Expediente\s+(\S+)\s*-\s*(.+)/s);
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

  const rows = await grid.getByRole('row').all();
  const rowsData = [];
  for (const row of rows) {
    const ariaLabel = await row.getAttribute('aria-label');
    const texto = await row.innerText();
    const linkEl = row.locator('a[href*="consultaNovedad"]').first();
    const href = (await linkEl.count()) ? await linkEl.getAttribute('href') : null;
    rowsData.push({ ariaLabel, texto, href });
  }

  await browser.close();

  const eventos = parseEventos(rowsData);
  console.log(`Encontrados ${eventos.length} eventos`);

  if (eventos.length) {
    const { error } = await supabase.from('eventos_pjn').upsert(eventos, { onConflict: 'id' });
    if (error) throw error;
  }

  console.log('Sync OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
