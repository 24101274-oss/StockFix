import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { SyntheticOptions } from '../../shared/demo-dataset.js';
import { loadSyntheticDemo } from './store.js';

export function parseDemoSeedArgs(args: string[]): { dataDir: string; options: SyntheticOptions } {
  const flags = new Map<string, string>();
  const allowed = new Set(['--as-of', '--seed', '--months', '--data-dir']);
  for (let index = 0; index < args.length; index++) {
    const equals = args[index].indexOf('=');
    const flag = equals < 0 ? args[index] : args[index].slice(0, equals);
    if (!allowed.has(flag)) throw new Error(`Opción desconocida: ${flag}`);
    if (flags.has(flag)) throw new Error(`Opción repetida: ${flag}`);
    const value = equals < 0 ? args[++index] : args[index].slice(equals + 1);
    if (!value || value.startsWith('--')) throw new Error(`Falta el valor de ${flag}`);
    flags.set(flag, value);
  }
  const asOfDate = flags.get('--as-of');
  if (!asOfDate) throw new Error('Indica --as-of YYYY-MM-DD para fijar el corte de la demostración.');
  return {
    dataDir: flags.get('--data-dir') ?? fileURLToPath(new URL('../../data/forecast-demo', import.meta.url)),
    options: { seed: flags.get('--seed') ?? 'stockfix-2026', asOfDate, months: Number(flags.get('--months') ?? 36) },
  };
}

async function main() {
  if (process.argv.slice(2).includes('--help')) {
    console.log('npm run demo:seed -- --as-of YYYY-MM-DD [--seed stockfix-2026] [--months 36] [--data-dir carpeta-nueva]');
    console.log('Carga una demo sintética aislada. Cierra cualquier proceso que utilice ese destino antes de cargar o verificar.');
    return;
  }
  const parsed = parseDemoSeedArgs(process.argv.slice(2));
  // The generator used by loadSyntheticDemo validates real calendar dates,
  // bounds and seed before any destination marker or database is created.
  const result = await loadSyntheticDemo(parsed.dataDir, parsed.options);
  console.log(result.manifest.label);
  console.log(`Acción: ${result.action === 'created' ? 'conjunto creado' : 'sin reimportar; se conserva el estado actual'}`);
  console.log(`Origen: ${result.manifest.kind}; semilla: ${result.manifest.seed}; corte Lima: ${result.manifest.asOfDate}`);
  console.log(`Histórico: ${result.manifest.historyStart} a ${result.manifest.lastCompleteMonth}; ${result.manifest.completeMonths} meses completos`);
  console.log(`Conteos de la importación original: ${JSON.stringify(result.manifest.counts)}`);
  console.log(`SHA-256 original: ${result.manifest.dataSha256}`);
  console.log(`Base aislada: ${result.dataDir}`);
  console.log(`Manifiesto: ${result.manifestPath}`);
  console.log('Para abrir esta demo en PowerShell, desde la carpeta del proyecto:');
  console.log(`$env:DATA_DIR = '${result.dataDir.replace(/'/g, "''")}'`);
  console.log('npm.cmd start');
  console.log('La configuración .env y la base data/demo-db permanecen intactas.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(`No se cargó la demo: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
