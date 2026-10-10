declare namespace Cloudflare {
  interface Env {
    ACCESS_TEAM_DOMAIN: string;
    ACCESS_AUD: string;
    TEST_MIGRATIONS: Array<{
      name: string;
      queries: string[];
    }>;
  }
}
