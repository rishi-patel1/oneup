import { readFile, writeFile, mkdir } from 'node:fs/promises';

const source = new URL('../src/game/', import.meta.url);
const target = new URL('../supabase/functions/_shared/', import.meta.url);
await mkdir(target, { recursive: true });
for (const file of ['engine.ts', 'solver.ts', 'generator.ts']) {
  const text = await readFile(new URL(file, source), 'utf8');
  const compatible = text.replace(/from '(\.\/(?:engine|solver))'/g, "from '$1.ts'");
  await writeFile(new URL(file, target), `// Generated from src/game/${file} by npm run supabase:sync.\n// Edit the source file, then run the sync command.\n${compatible}`);
}
console.log('Synced the shared, versioned puzzle generator for Supabase.');
