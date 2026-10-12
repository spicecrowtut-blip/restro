# Borcelle

Restaurant website with a reservation inbox and an admin panel for menu management. PostgreSQL stores bookings and menu items in production; local development stores them in `data/bookings.json` and `data/menu.json` unless `DATABASE_URL` is set.

## Run locally

Requires Node.js 20 or newer.

```powershell
npm ci
npm run dev
```

Create a local `.env` file with your admin credentials before starting the server. Open http://127.0.0.1:5173. Without `DATABASE_URL`, reservation requests are stored in `data/bookings.json`. Set `DATABASE_URL` to use a PostgreSQL database locally instead.

The public menu and admin changes are stored server-side, so they are shared between visitors and persist across devices. The initial Borcelle menu is added to PostgreSQL on first startup.

## Import the Access menu

The Access file must be at the repository root as `resro.accdb`. The import expects the table `Таблица1` with columns `Код` (unique integer), `Поле1` (dish name), and `Поле2` (price). Names and prices are imported into PostgreSQL; imported dishes are placed in the main-course category with a default image and description.

On Windows, install the Microsoft Access ODBC driver matching your Node.js architecture, configure `DATABASE_URL` with the PostgreSQL connection string, then run this from `borcelle`:

```powershell
npm run import:access
```

Importing the same Access file again updates the name and price for existing `Код` values without creating duplicates. The Access file is only read; it is not uploaded or included in the deployed site.

## Admin access

Set these variables in the local `.env` file:

```env
BORCELLE_ADMIN_LOGIN=Adminchik
BORCELLE_ADMIN_PASSWORD="The chary monster taking a shower"
```

The `.env` file is excluded from Git. Production requires `BORCELLE_ADMIN_LOGIN` and `BORCELLE_ADMIN_PASSWORD` to be configured in the hosting provider.

Login attempts are unlimited in local development. The attempt limit remains enabled in production deployments.

## Deploy to Render

1. Push the repository to GitHub and create a new Blueprint in Render using the repository root. [`../render.yaml`](../render.yaml) provisions the web service and a PostgreSQL database.
2. Choose the free plans when prompted and set `BORCELLE_ADMIN_LOGIN` and `BORCELLE_ADMIN_PASSWORD` in the Render dashboard's environment settings.
3. Deploy. Render injects the database connection as `DATABASE_URL`, generates `BORCELLE_SESSION_SECRET`, and the app creates its tables and initial menu on startup.
4. To copy Access rows, set `DATABASE_URL` locally to the database's external Render connection string and run `npm run import:access` from `borcelle` on the Windows computer that has `resro.accdb` and the Access ODBC driver.

The free PostgreSQL database is for testing: it has a 1 GB limit, expires 30 days after creation, and is deleted after a further 14-day upgrade grace period. Free web services can also spin down after inactivity. Upgrade the database to a paid plan before relying on it for long-term storage. See [Render's free instance limitations](https://render.com/docs/free#free-postgresql).

## Other commands

```powershell
npm run build
npm run lint
npm start
```
