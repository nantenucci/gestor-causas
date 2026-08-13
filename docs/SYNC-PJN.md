# Sync PJN — Novedades del Portal PJN dentro de Gestor de Causas

Sincronización automática de "mis eventos" del Portal PJN (Poder Judicial de la Nación)
hacia Gestor de Causas, sin depender de ningún tercero (JurisprudenciaARG y similares).

## Qué hace

Un workflow programado de GitHub Actions entra al Portal PJN con las credenciales del
estudio, lee el listado "Mis Eventos" (despachos y notificaciones de todos los
expedientes), y guarda cada evento nuevo en Supabase. La app (`index.html`) muestra
esos eventos en un botón **"🏛️ PJN"** en la barra superior, con contador de no leídos,
igual en estilo al panel de Alertas existente.

## Arquitectura

```
GitHub Actions (cron, 4x/día L-V)
  └─ scripts/sync-pjn.mjs (Playwright headless)
       1. Login en sso.pjn.gov.ar (Keycloak/OAuth2) con PJN_USER / PJN_PASS
       2. Lee el grid "Listado de eventos" en portalpjn.pjn.gov.ar/inicio
       3. Deduplica por eid (el mismo evento puede listarse más de una vez)
       4. Upsert a Supabase → tabla eventos_pjn (bypass RLS con SUPABASE_SERVICE_KEY)

index.html (frontend)
  └─ Botón "🏛️ PJN" → lee eventos_pjn con la key publishable (RLS: solo autenticados)
     → marca leído por evento (persiste entre dispositivos)
```

## Archivos

| Archivo | Rol |
|---|---|
| `.github/workflows/sync-pjn.yml` | Cron (`0 12,15,18,21 * * 1-5` UTC = 9/12/15/18 ART) + disparo manual |
| `scripts/sync-pjn.mjs` | Script Playwright: login, scraping, parseo, upsert |
| `scripts/package.json` | Dependencias: `playwright`, `@supabase/supabase-js` |
| `index.html` | Botón "PJN" en topbar + modal `pjn-overlay` + funciones `cargarEventosPjn` / `mostrarEventosPjn` / `marcarLeidoPjn` |

## Supabase

Tabla `eventos_pjn` (proyecto `dzbbswphrqgmdndtvxzx`), RLS activo, política
`authenticated full access` (mismo patrón que `causas`/`audiencias`).

```sql
id            text primary key   -- eid del portal PJN
expediente    text
caratula      text
tipo_evento   text               -- 'Despacho' | 'Notificación'
fecha_label   text               -- texto tal cual lo muestra el portal ("11 ago", "13:36")
scraped_at    timestamptz
link_causa    text               -- link a scw.pjn.gov.ar
causa_id      text               -- FK a causas.id, sin auto-match todavía (pendiente)
leido         boolean default false
created_at    timestamptz
```

## Secretos necesarios (GitHub → repo `nantenucci/gestor-causas`)

Cargados vía `gh secret set <NOMBRE> --repo nantenucci/gestor-causas` (nunca en texto
plano ni en el código):

- `PJN_USER` — CUIT/CUIL de acceso al Portal PJN
- `PJN_PASS` — contraseña del Portal PJN
- `SUPABASE_SERVICE_KEY` — **secret key** de Supabase (Settings → API Keys → Secret keys), no la publishable

## Operarlo a mano

```bash
# Disparar una sincronización ahora mismo
gh workflow run "Sync PJN" --repo nantenucci/gestor-causas

# Ver el último run (esperar a que termine, refresca cada 3s)
gh run list --repo nantenucci/gestor-causas --limit 1
gh run watch <ID> --repo nantenucci/gestor-causas

# Ver el log si falló
gh run view <ID> --repo nantenucci/gestor-causas --log-failed

# Ver secretos cargados (no muestra los valores)
gh secret list --repo nantenucci/gestor-causas
```

Si falla justo después del login, el script guarda una captura (`debug.png`) como
artefacto del run — bajala desde la página del run en github.com para ver qué pantalla
tenía el portal en ese momento.

## Problemas ya resueltos (por si vuelven a aparecer)

1. **`Node.js 20 detected without native WebSocket support`** — el cliente de Supabase
   necesita WebSocket nativo. Fix: `node-version: 22` en el workflow.
2. **`CUIT/CUIL o contraseña incorrectos`** — secreto `PJN_USER`/`PJN_PASS` mal cargado
   (typo o espacio de más al pegar). Fix: recargar el secreto escribiendo a mano.
3. **`ON CONFLICT DO UPDATE command cannot affect row a second time`** — el portal lista
   el mismo evento (mismo `eid`) más de una vez cuando tiene varios documentos
   asociados. Fix: deduplicar por `id` antes del upsert.
4. **Todo aparecía como "(sin expediente)" / "Evento"** — el regex de parseo no
   contemplaba que el número de expediente tiene espacios adentro (ej. `FRO 8501/2014`).
   Fix: capturar de forma no-codiciosa hasta el primer `" - "` literal.

## Pendiente / ideas a futuro

- Sincronizar también MEV Santa Fe (quedó fuera del alcance inicial, que fue solo PJN federal).
- Vincular automáticamente `eventos_pjn.causa_id` con la causa correspondiente en
  `causas` (matching por `cuij`/`codigo`), hoy queda sin vincular.
- Si en algún momento se piensa en venderlo a otros abogados: repensar el guardado de
  credenciales (hoy son las del propio estudio, vía GitHub Secrets — no escala a
  multi-tenant sin una capa de seguridad dedicada).
