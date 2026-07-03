import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

// The server runs with cwd = packages/server (npm workspace), so a bare
// `dotenv/config` would look for packages/server/.env and miss the repo-root
// .env. Resolve the root relative to this file instead so it works no matter
// where the process is started from. (packages/server/{src,dist}/env → 3 up.)
const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "../../../.env") });
