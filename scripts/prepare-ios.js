// Se ejecuta en GitHub Actions justo después de `npx cap add ios`.
// Personaliza el proyecto iOS generado: icono, pantalla de inicio y versión.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const assets = path.join(root, 'ios', 'App', 'App', 'Assets.xcassets');
const pbx = path.join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
const icon = path.join(root, 'resources', 'ios', 'icon-1024.png');
const splash = path.join(root, 'resources', 'ios', 'splash-2732.png');

if (!fs.existsSync(assets)) {
  console.error('No se encontró', assets, '- ¿se ejecutó "npx cap add ios" antes?');
  process.exit(1);
}

// Sustituye todas las imágenes PNG de una carpeta del catálogo por la nuestra
function overwritePngs(dir, src, label) {
  if (!fs.existsSync(dir)) {
    console.warn(`Aviso: no existe ${dir}, se omite ${label}`);
    return;
  }
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    if (f.toLowerCase().endsWith('.png')) {
      fs.copyFileSync(src, path.join(dir, f));
      n++;
    }
  }
  console.log(`${label}: ${n} imagen(es) reemplazada(s)`);
}

overwritePngs(path.join(assets, 'AppIcon.appiconset'), icon, 'Icono');
overwritePngs(path.join(assets, 'Splash.imageset'), splash, 'Pantalla de inicio');

// Versión: cada compilación sube el número
const run = parseInt(process.env.RUN_NUMBER || '1', 10) || 1;
if (fs.existsSync(pbx)) {
  let p = fs.readFileSync(pbx, 'utf8');
  p = p.replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${run};`);
  p = p.replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = 1.${run};`);
  fs.writeFileSync(pbx, p);
  console.log(`Versión 1.${run} (build ${run})`);
}
