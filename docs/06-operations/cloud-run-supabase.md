# Cloud Run + Supabase staging

This is the concrete staging deployment for Ekon.

## Runtime shape

- Google Cloud Run runs one Ekon container.
- The container serves both the React frontend and Fastify API.
- Supabase provides PostgreSQL.
- Use the Supabase **Session Pooler** connection string (port 5432) as `DATABASE_URL`.
- Keep Supabase Auth/Storage/etc. out of this deployment; Ekon uses Supabase only as PostgreSQL.

## Container

Build from the repository root:

```bash
docker build -t ekon-inventory .
```

The image uses Node 22, runs the repository's normal `npm run build`, and starts `backend/dist/main.js` from `/app/backend`. Cloud Run supplies `PORT`; the image defaults it to `8080` for local/container compatibility.

The image deliberately retains the migration files and admin CLI so the exact deployed revision can also run migrations and the one-time owner bootstrap.

## Required Cloud Run configuration

Runtime environment:

```text
NODE_ENV=production
DATABASE_SSL=true
DATABASE_POOL_MAX=5
EXPECTED_SCHEMA_VERSION=0008
APP_VERSION=<deployed git sha>
DISPLAY_TIMEZONE=America/Port-au-Prince
```

Do not set `PORT`; Cloud Run owns it.

Store `DATABASE_URL` in Google Secret Manager and expose that secret to the Cloud Run service as the `DATABASE_URL` environment variable. Do not commit the Supabase password or connection string.

`EXPECTED_SCHEMA_VERSION` must match the highest migration bundled in the deployed revision. Do not copy `0008` forward blindly when a later migration is added.

## Database connection

In Supabase, copy the Session Pooler connection string and store the complete value as the `DATABASE_URL` secret. Ekon uses its existing `pg.Pool`; no Supabase SDK is required.

The initial staging configuration uses `DATABASE_POOL_MAX=5` to keep the application's possible database connection count small.

## Release order

For the first staging deployment:

1. Create the Supabase staging project.
2. Create the `DATABASE_URL` secret in Google Secret Manager.
3. Build/push the Ekon container.
4. Run `npm run migrate` from this image with the staging environment before the web service accepts business traffic.
5. Deploy the same image to Cloud Run.
6. Verify `GET /api/health` reports `status: ok`, `database: up`, schema `0008`, and the deployed commit SHA.
7. Run `npm run identity:create-owner` once using the same image/environment and the documented `EKON_OWNER_*` variables.
8. Sign in through the Cloud Run HTTPS URL and run the browser acceptance workflow in `deployment.md`.

For later releases, migrations still run before the new revision receives traffic. The application's schema pin is the second guard: if release ordering is wrong, the new instance refuses to start.

## Staging acceptance checks

Before treating the hosting setup as usable:

- `/api/health` is healthy over HTTPS;
- login sets `ekon_session` with `Secure` and `HttpOnly`;
- owner can create an employee;
- owner can create a product;
- employee can receive stock into Main Store;
- current stock shows the new quantity and location;
- employee can remove stock and see the reduced balance;
- logout invalidates the session;
- restarting/scaling the Cloud Run service does not lose data because all persistent state is in Supabase.

Do not enter real production inventory during this staging exercise.
