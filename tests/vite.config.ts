import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const fakeDatabaseModule = path.resolve(testsDirectory, "fake-db.server.ts");

// Fail closed if the test double is ever misconfigured: a test must never
// connect to the application's configured MongoDB database.
process.env.DATABASE_URL =
  "mongodb://127.0.0.1:1/lystr-billing-tests?serverSelectionTimeoutMS=50";

export default defineConfig({
  plugins: [
    {
      enforce: "pre",
      name: "mock-billing-attempt-database",
      resolveId(source, importer) {
        if (
          source === "./db.server" &&
          importer?.endsWith("/app/shopify-billing-attempt.server.ts")
        ) {
          return fakeDatabaseModule;
        }

        return null;
      },
    },
  ],
});
