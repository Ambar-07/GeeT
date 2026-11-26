import path from "node:path";
import { createServer } from "vite";

// Own the server directly so cleanup does not depend on Windows shell process trees.
export default async function setup() {
  const server = await createServer({
    root: path.resolve("apps/web"),
    server: { host: "127.0.0.1", port: 5190, strictPort: true, hmr: false },
  });
  await server.listen();
  return async () => { await server.close(); };
}
