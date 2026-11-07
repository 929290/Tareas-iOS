# Pendientes para iPhone

App de tareas (categorías editables, subtareas, fechas, búsqueda) adaptada al iPhone.
El `.ipa` se compila **en la nube con GitHub Actions** (en un Mac de GitHub) y se instala con **Sideloadly**.

## 1. Subir el proyecto a GitHub (repositorio nuevo)

1. En github.com pulsa **+ → New repository**. Nómbralo, por ejemplo, `Tareas-iOS`, déjalo en **Public** y créalo.
2. Pulsa **uploading an existing file**.
3. Arrastra las carpetas **`www`**, **`scripts`** y **`resources`**, y los archivos `package.json`, `capacitor.config.json`, `.gitignore` y `README.md`. Pulsa **Commit changes**.
4. Crea la receta a mano (la carpeta oculta `.github` no se sube bien arrastrando):
   **Add file → Create new file**, nombre `.github/workflows/build-ipa.yml`, pega el contenido del archivo `.github/workflows/build-ipa.yml` de este proyecto y pulsa **Commit changes**.

## 2. Esperar la compilación

Abre la pestaña **Actions**. "Compilar IPA (iOS)" tarda unos 10-15 minutos. Cuando salga el check verde, entra en **Releases** (panel derecho de la página principal) y descarga **Pendientes.ipa**.

## 3. Instalar con Sideloadly

1. Conecta el iPhone al PC por cable y toca **Confiar** si te lo pide.
2. Abre Sideloadly, arrastra `Pendientes.ipa`, escribe tu Apple ID y pulsa **Start**.
3. En el iPhone: **Ajustes → General → VPN y gestión de dispositivos** → toca tu Apple ID → **Confiar**.
4. En iOS 16 o superior activa también **Ajustes → Privacidad y seguridad → Modo de desarrollador** (pide reiniciar).

Con una cuenta Apple gratuita la app **caduca a los 7 días**: hay que volver a firmarla con Sideloadly.

## Si algo falla

- **No aparece "Compilar IPA" en Actions:** revisa que el archivo esté en `.github/workflows/build-ipa.yml` (con el punto delante de `github`).
- **Sale una ❌ roja:** entra en la ejecución, abre el paso que falló y copia las últimas líneas del error.
- **Compila pero no hay release:** descarga el IPA desde **Artifacts** de la ejecución. Para arreglar la publicación, activa en Settings → Actions → General → Workflow permissions la opción "Read and write permissions".

## Novedades de la versión 1.2

- **Resumen** (icono de gráfica junto al buscador): racha de días, gráfica de completadas por día (toca una barra para ver el detalle), por categoría e historial.
- **Ajustes** (icono junto al de Resumen): tema claro / oscuro / como el teléfono, vista en lista compacta y copia de seguridad.
- **Copia de seguridad:** "Exportar copia…" abre el menú Compartir del iPhone (Guardar en Archivos, WhatsApp, correo...). "Importar copia…" abre Archivos para elegir el `.json`.
- Archivo nuevo que hay que subir: `www/theme.js`. También cambian `www/app.js`, `www/index.html`, `www/styles.css`, `www/mobile.css`, `package.json` y este README.
- Actualiza la app en todos tus dispositivos: las versiones anteriores mostrarían las tareas borradas que se guardan para el historial.

## Notas

- Sin cuenta, las tareas se guardan solo en el propio iPhone. Con cuenta (ver abajo) se sincronizan con tus otros dispositivos.
- Si desinstalas la app o dejas que caduque sin renovarla, pueden perderse los datos que no estén sincronizados. Exporta una copia de vez en cuando.

## Estructura

```
www/                   la app (HTML, CSS, JS)
  mobile.css           adaptación a pantalla táctil
resources/ios/         icono y pantalla de inicio
scripts/prepare-ios.js aplica icono, pantalla de inicio y versión
.github/workflows/     receta que compila el IPA
capacitor.config.json  configuración de la app
```

---

## Cuentas y sincronización (opcional)

1. Crea un proyecto gratis en https://supabase.com
2. En **SQL Editor** pega el contenido de `supabase-setup.sql` y pulsa **Run**.
3. En **Authentication → Providers → Email** desactiva "Confirm email".
4. En **Project Settings → API** copia la *Project URL* y la clave pública (anon / publishable).
5. Pégalas en `www/config.js` y vuelve a compilar (sube los cambios a GitHub).

Nunca pegues la clave `service_role` / secret. Si no rellenas `config.js`, la app funciona solo en local y el botón de cuenta se oculta.
Estructura: `www/sync.js` (sincronización) y `www/config.js` (tus claves).
