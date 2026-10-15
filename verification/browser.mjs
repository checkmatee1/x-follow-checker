import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';

export function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try { return require('playwright'); } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
  }
  // Optional reuse of Codex's installed library; never reads browser profiles.
  const bundled = path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
  try { return require(bundled); } catch {
    throw new Error('缺少验收依赖。请在工具文件夹内运行 npm install 后再运行 npm test。');
  }
}
