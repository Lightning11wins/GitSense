// Runs `tauri dev` on a free port with state kept in this checkout's .dev dir,
// so several worktrees can run the app at once.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const devDir = join(appDir, "..", ".dev");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const port = await freePort();
const env = {
  ...process.env,
  GITSENSE_HOME: process.env.GITSENSE_HOME ?? join(devDir, "gitsense"),
  GITSENSE_CONFIG_DIR: process.env.GITSENSE_CONFIG_DIR ?? join(devDir, "config"),
};
mkdirSync(env.GITSENSE_CONFIG_DIR, { recursive: true });
const config = {
  build: {
    devUrl: `http://127.0.0.1:${port}`,
    beforeDevCommand: `pnpm vite --port ${port} --strictPort`,
  },
};
const child = spawn("pnpm", ["tauri", "dev", "--config", JSON.stringify(config), ...process.argv.slice(2)], {
  cwd: appDir,
  env,
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 1));
