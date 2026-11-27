# AFIT Wayfinder

Campus map for the Air Force Institute of Technology. One Node server provides the API
(accounts, places) and serves the website; the Android app (Capacitor) talks to the same API,
so places added by the admin appear everywhere.

## Roles
- **Guest**: view the map.
- **Student**: sign up on the login page; view the map.
- **Admin**: add/edit/delete places, trace building outlines (shown in 3D), upload building photos, draw walking paths (used for directions) and manage users. The admin
  account is created from the `ADMIN_EMAIL` / `ADMIN_PASSWORD` environment variables.

## Run locally
```
npm install
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=changeme123 npm run server   # API on :3000 (temporary in-memory DB)
npm run dev                                                            # site on :5173, proxies /api
```

## Deploy (Render)
See `render.yaml`. Set `DATABASE_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`; `JWT_SECRET` is generated.
Places are seeded from `public/campus-data.json` the first time the database is empty.

## Android
Add a repository variable `API_URL` (your Render URL), then run the "Android debug APK" workflow.
Locally: `VITE_API_URL=https://your-app.onrender.com npm run build && npx cap sync android`.
