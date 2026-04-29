import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const brokerWorkerPath = resolve(root, 'src/port-broker.worker.ts');
const outputPath = resolve(root, 'src/generated/broker-worker-source.ts');

const sourceTs = await readFile(brokerWorkerPath, 'utf8');
const transpiled = ts.transpileModule(sourceTs, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    removeComments: false,
  },
  fileName: brokerWorkerPath,
}).outputText.trim();

const out = `// AUTO-GENERATED FILE. DO NOT EDIT.
// Source: src/port-broker.worker.ts
// Run: npm run generate:broker-source

export const BROKER_WORKER_SOURCE = ${JSON.stringify(transpiled)};
`;

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, out, 'utf8');

