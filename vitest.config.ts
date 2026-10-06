import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

// sha256("token-ana") y sha256("token-beto"): dos operadores distintos.
const OPERATOR_TOKENS = JSON.stringify({
  ana: "23f74e86019b5625cf4bbe3e1e9ac2d0eeaa057ffa6a72ff988bd04820297856",
  beto: "9447d9c09f31dad984c833671d3444be299ceda314aa64b8f8467cf11c8a0d8d"
});

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.toml", environment: "development" },
    miniflare: {
      bindings: {
        BUSINESS_INDEX_PEPPER: "test-pepper-not-for-production-0123456789",
        OPERATOR_TOKENS,
        TEST_MIGRATIONS: migrations
      }
    }
  })]
});
