// Project helpers shared by the command line tools detect.mjs and target.mjs (the web studio keeps the same layout):
// a game folder, its adapter, its targets.json and the run history in <game>/.balance-sim/runs/<id>/.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } };
export const writeJson = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n');

export function openProject(argv) {
  const arg = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
  const projectDir = path.resolve(arg('dir', process.cwd()));
  // a relative path may be relative to where you typed it or to the game folder: use whichever exists
  const where = (v) => { const a = path.resolve(process.cwd(), v), b = path.resolve(projectDir, v); return path.isAbsolute(v) || fs.existsSync(a) ? a : b; };
  const adapterPath = where(arg('adapter', 'tools/balance/adapter.mjs'));
  const targetsPath = where(arg('targets', 'tools/balance/targets.json'));
  const stateDir = path.join(projectDir, '.balance-sim'), runsDir = path.join(stateDir, 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  if (!fs.existsSync(path.join(stateDir, '.gitignore'))) fs.writeFileSync(path.join(stateDir, '.gitignore'), 'runs/\n');
  return {
    projectDir, adapterPath, targetsPath, stateDir, runsDir, arg, has: (n) => argv.includes('--' + n),
    async adapter() {
      if (!fs.existsSync(adapterPath)) throw new Error(`No adapter at ${adapterPath}. Write one first (SKILL.md, step 2) or pass --adapter.`);
      return (await import(pathToFileURL(adapterPath).href)).default;
    },
    targets: () => readJson(targetsPath, null),
    runDir: (id) => path.join(runsDir, id),
    newRunId: (kind) => kind + '-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + Math.random().toString(36).slice(2, 5),
    runs: () => fs.readdirSync(runsDir).filter((d) => fs.existsSync(path.join(runsDir, d, 'meta.json'))).map((d) => readJson(path.join(runsDir, d, 'meta.json'), null)).filter(Boolean).sort((a, b) => (b.startedAt > a.startedAt ? 1 : -1)),
    latest(kind) { return this.runs().find((r) => r.kind === kind && r.status === 'done') || null; },
  };
}
