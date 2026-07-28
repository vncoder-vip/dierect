# Chuột Chat — Converted to Flask

This repository contains a static frontend and two Python Flask entrypoints:

- `app.py` — full Flask app serving static files and providing `/api/comments` (chooses Postgres if `DATABASE_URL` is set, otherwise Sanity if configured).
- `api/comments.py` — serverless-style Flask handler for Vercel's `/api/comments` function.

Quick start (local):

1. Create and activate a virtual environment (optional but recommended):

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

2. Install dependencies:

```powershell
pip install -r requirements.txt
```

3. Run the app (development):

```powershell
python app.py
```

Environment variables (when using backends):

- `DATABASE_URL` — Postgres connection string (optional). If set, `app.py` and `api/comments.py` will use Postgres.
- `SANITY_PROJECT_ID`, `SANITY_API_TOKEN` — If Postgres is not configured, the Sanity HTTP API is used when these are set.
- `SANITY_DATASET` — optional, defaults to `production`.
- `SANITY_API_VERSION` — optional date string `YYYY-MM-DD`.
- `ADMIN_DELETE_PASSWORD` — optional password to authorize delete operations on Sanity backend.

Deploying to Vercel

1. Ensure you have a Vercel account and the Vercel CLI: `npm i -g vercel`.
2. Set required Environment Variables in your Vercel project (see above).
3. Deploy:

```bash
vercel --prod
```

Notes and considerations

- Static files live at the repository root (e.g., `index.html`, `styles.css`). `app.py` serves them locally.
- `vercel.json` routes `/api/comments` to the serverless function in `api/comments.py` and everything else to `app.py`.
- For production, prefer using a managed Postgres (Render, Supabase, AWS RDS) and set `DATABASE_URL`.

If you want, I can run the local test install and start the dev server for you.
