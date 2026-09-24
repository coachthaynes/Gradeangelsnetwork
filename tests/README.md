# Tests

`api.test.mjs` runs the real Netlify functions (bundled by `build.mjs`, with
file storage replaced by an in memory stand in) against a throwaway Postgres
database, and walks through the whole site: sign up, Grade Angel setup, staff
approval, posting and accepting work, chat, payouts, reviews, the admin
dashboard, and the marketing emails (with Resend replaced by a recorder).

```
# 1. A throwaway database with every migration applied
createdb ga_test
for m in netlify/database/migrations/*/migration.sql; do psql -d ga_test -f "$m"; done

# 2. Build and run (the database is wiped at the start of each run)
node tests/build.mjs
TEST_DB_URL=postgres://localhost/ga_test node tests/api.test.mjs
```
