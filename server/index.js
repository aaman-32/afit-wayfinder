import express from 'express'
import cors from 'cors'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const prod = process.env.NODE_ENV === 'production'
const SECRET = process.env.JWT_SECRET || (prod ? null : 'dev-secret-change-me')
if (!SECRET) throw new Error('JWT_SECRET is required in production')

// ---------- database ----------
let pool
if (process.env.DATABASE_URL) {
  const url = process.env.DATABASE_URL
  pool = new pg.Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } })
} else {
  if (prod) throw new Error('DATABASE_URL is required in production')
  const { newDb } = await import('pg-mem')
  pool = new (newDb().adapters.createPg().Pool)()
  console.warn('No DATABASE_URL: using a temporary in-memory database (data is lost on restart).')
}
const q = (text, params) => pool.query(text, params)

await q(`CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE, pass text NOT NULL,
  role text NOT NULL DEFAULT 'student', created_at timestamptz DEFAULT now(), last_login timestamptz)`)
await q(`CREATE TABLE IF NOT EXISTS places (
  id text PRIMARY KEY, name text NOT NULL, category text NOT NULL, description text NOT NULL DEFAULT '',
  keywords text NOT NULL DEFAULT '[]', lat double precision NOT NULL, lng double precision NOT NULL,
  footprint text, height double precision, created_by text, updated_at timestamptz DEFAULT now())`)
await q(`CREATE TABLE IF NOT EXISTS paths (
  id text PRIMARY KEY, name text NOT NULL, coords text NOT NULL, created_by text, updated_at timestamptz DEFAULT now())`)
await q(`CREATE TABLE IF NOT EXISTS images (
  id text PRIMARY KEY, place_id text NOT NULL, mime text NOT NULL, data text NOT NULL, created_at timestamptz DEFAULT now())`)
// upgrade databases created before buildings existed
for (const sql of ['ALTER TABLE places ADD COLUMN IF NOT EXISTS footprint text', 'ALTER TABLE places ADD COLUMN IF NOT EXISTS height double precision']) {
  try { await q(sql) } catch { /* column already exists */ }
}

// admin account comes from environment variables and is re-applied on each start
const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env
if (ADMIN_EMAIL && ADMIN_PASSWORD) {
  const email = ADMIN_EMAIL.trim().toLowerCase()
  const hash = await bcrypt.hash(ADMIN_PASSWORD, 10)
  const ex = await q('SELECT id FROM users WHERE email=$1', [email])
  if (ex.rows.length) await q("UPDATE users SET pass=$1, role='admin' WHERE email=$2", [hash, email])
  else await q("INSERT INTO users (id,name,email,pass,role) VALUES ($1,'Admin',$2,$3,'admin')", [randomUUID(), email, hash])
} else console.warn('ADMIN_EMAIL / ADMIN_PASSWORD not set: no admin account exists.')

// seed places from the bundled campus data on first run only
const count = (await q('SELECT COUNT(*)::int AS n FROM places')).rows[0].n
const seedFile = path.join(here, '../public/campus-data.json')
if (count === 0 && existsSync(seedFile)) {
  for (const f of JSON.parse(readFileSync(seedFile, 'utf8')).features) {
    const p = f.properties
    await q('INSERT INTO places (id,name,category,description,keywords,lat,lng) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [p.id, p.name, p.category, p.description || '', JSON.stringify(p.search_keywords || []), f.geometry.coordinates[1], f.geometry.coordinates[0]])
  }
  console.log('Seeded places from campus-data.json')
}

// ---------- helpers ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status } }
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
const pubUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, created_at: u.created_at, last_login: u.last_login })
const sign = (u) => jwt.sign({ sub: u.id }, SECRET, { expiresIn: '14d' })
const placeOut = (r) => ({ id: r.id, name: r.name, category: r.category, description: r.description, keywords: JSON.parse(r.keywords || '[]'), lat: r.lat, lng: r.lng, footprint: r.footprint ? JSON.parse(r.footprint) : null, height: r.height })

function cleanPlace(b) {
  const name = String(b.name || '').trim().slice(0, 120)
  const category = String(b.category || 'other').trim().toLowerCase().slice(0, 40) || 'other'
  const description = String(b.description || '').trim().slice(0, 1000)
  const lat = Number(b.lat), lng = Number(b.lng)
  if (!name) throw new HttpError(400, 'Name is required')
  if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) || b.lat === '' || b.lng === '') throw new HttpError(400, 'Valid location is required')
  const keywords = Array.isArray(b.keywords) ? b.keywords.map((k) => String(k).slice(0, 40)).slice(0, 20) : []
  let footprint = null, height = null
  if (Array.isArray(b.footprint) && b.footprint.length) {
    if (b.footprint.length < 3 || b.footprint.length > 200) throw new HttpError(400, 'A building outline needs 3 to 200 corners')
    footprint = b.footprint.map((c) => {
      const lo = Number(c?.[0]), la = Number(c?.[1])
      if (!(la >= -90 && la <= 90 && lo >= -180 && lo <= 180)) throw new HttpError(400, 'Invalid outline point')
      return [lo, la]
    })
    height = Math.min(200, Math.max(2, Number(b.height) || 10))
  }
  return { name, category, description, keywords, lat, lng, footprint, height }
}

function cleanPath(b) {
  const name = String(b.name || '').trim().slice(0, 80)
  if (!name) throw new HttpError(400, 'Give the path a name')
  if (!Array.isArray(b.coords) || b.coords.length < 2 || b.coords.length > 1000) throw new HttpError(400, 'A path needs 2 to 1000 points')
  const coords = b.coords.map((c) => {
    const lo = Number(c?.[0]), la = Number(c?.[1])
    if (!(la >= -90 && la <= 90 && lo >= -180 && lo <= 180)) throw new HttpError(400, 'Invalid path point')
    return [lo, la]
  })
  return { name, coords }
}

const hits = new Map()
function limit(req, res, next) {
  const k = req.ip, now = Date.now()
  const arr = (hits.get(k) || []).filter((t) => now - t < 15 * 60 * 1000)
  if (arr.length >= 20) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' })
  arr.push(now); hits.set(k, arr); next()
}

const needUser = wrap(async (req, res, next) => {
  const h = req.headers.authorization || ''
  if (!h.startsWith('Bearer ')) throw new HttpError(401, 'Login required')
  let id
  try { id = jwt.verify(h.slice(7), SECRET).sub } catch { throw new HttpError(401, 'Session expired, please log in again') }
  const r = await q('SELECT * FROM users WHERE id=$1', [id])
  if (!r.rows.length) throw new HttpError(401, 'Account no longer exists')
  req.user = r.rows[0]; next()
})
const needAdmin = [needUser, (req, res, next) => (req.user.role === 'admin' ? next() : next(new HttpError(403, 'Admins only')))]

// ---------- app ----------
const app = express()
app.set('trust proxy', 1)
app.use(cors())
app.use('/api/places/:id/images', express.json({ limit: '3mb' }))
app.use(express.json({ limit: '50kb' }))
app.get('/api/health', (req, res) => res.json({ ok: true }))

app.post('/api/auth/register', limit, wrap(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80)
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 200)
  const password = String(req.body.password || '')
  if (!name) throw new HttpError(400, 'Name is required')
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Enter a valid email')
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters')
  if ((await q('SELECT 1 FROM users WHERE email=$1', [email])).rows.length) throw new HttpError(409, 'An account with this email already exists')
  const id = randomUUID()
  await q("INSERT INTO users (id,name,email,pass,role,last_login) VALUES ($1,$2,$3,$4,'student',now())", [id, name, email, await bcrypt.hash(password, 10)])
  const u = (await q('SELECT * FROM users WHERE id=$1', [id])).rows[0]
  res.status(201).json({ token: sign(u), user: pubUser(u) })
}))

app.post('/api/auth/login', limit, wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase()
  const r = await q('SELECT * FROM users WHERE email=$1', [email])
  const u = r.rows[0]
  if (!u || !(await bcrypt.compare(String(req.body.password || ''), u.pass))) throw new HttpError(401, 'Wrong email or password')
  await q('UPDATE users SET last_login=now() WHERE id=$1', [u.id])
  res.json({ token: sign(u), user: pubUser(u) })
}))

app.get('/api/me', needUser, (req, res) => res.json({ user: pubUser(req.user) }))

app.get('/api/places', wrap(async (req, res) => {
  const [pl, im] = await Promise.all([q('SELECT * FROM places ORDER BY name'), q('SELECT id, place_id FROM images ORDER BY created_at')])
  const by = {}
  im.rows.forEach((i) => (by[i.place_id] ||= []).push(i.id))
  res.set('Cache-Control', 'no-store').json({ places: pl.rows.map((r) => ({ ...placeOut(r), images: by[r.id] || [] })) })
}))
app.post('/api/places', needAdmin, wrap(async (req, res) => {
  const p = cleanPlace(req.body), id = randomUUID()
  await q('INSERT INTO places (id,name,category,description,keywords,lat,lng,footprint,height,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [id, p.name, p.category, p.description, JSON.stringify(p.keywords), p.lat, p.lng, p.footprint ? JSON.stringify(p.footprint) : null, p.height, req.user.id])
  res.status(201).json({ place: { id, ...p } })
}))
app.put('/api/places/:id', needAdmin, wrap(async (req, res) => {
  const p = cleanPlace(req.body)
  const r = await q('UPDATE places SET name=$1,category=$2,description=$3,keywords=$4,lat=$5,lng=$6,footprint=$7,height=$8,updated_at=now() WHERE id=$9 RETURNING id',
    [p.name, p.category, p.description, JSON.stringify(p.keywords), p.lat, p.lng, p.footprint ? JSON.stringify(p.footprint) : null, p.height, req.params.id])
  if (!r.rows.length) throw new HttpError(404, 'Place not found')
  res.json({ place: { id: req.params.id, ...p } })
}))
app.delete('/api/places/:id', needAdmin, wrap(async (req, res) => {
  await q('DELETE FROM images WHERE place_id=$1', [req.params.id])
  await q('DELETE FROM places WHERE id=$1', [req.params.id]); res.json({ ok: true })
}))

app.post('/api/places/:id/images', needAdmin, wrap(async (req, res) => {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body.data || ''))
  if (!m) throw new HttpError(400, 'Unsupported image (use JPEG, PNG or WebP)')
  if (m[2].length > 1800000) throw new HttpError(413, 'Image is too large')
  if (!(await q('SELECT 1 FROM places WHERE id=$1', [req.params.id])).rows.length) throw new HttpError(404, 'Place not found')
  const n = (await q('SELECT COUNT(*)::int AS n FROM images WHERE place_id=$1', [req.params.id])).rows[0].n
  if (n >= 12) throw new HttpError(400, 'Maximum 12 photos per place')
  const id = randomUUID()
  await q('INSERT INTO images (id,place_id,mime,data) VALUES ($1,$2,$3,$4)', [id, req.params.id, m[1], m[2]])
  res.status(201).json({ image: { id } })
}))
app.get('/api/images/:id', wrap(async (req, res) => {
  const r = await q('SELECT mime, data FROM images WHERE id=$1', [req.params.id])
  if (!r.rows.length) throw new HttpError(404, 'Not found')
  res.set({ 'Content-Type': r.rows[0].mime, 'Cache-Control': 'public, max-age=31536000, immutable' }).send(Buffer.from(r.rows[0].data, 'base64'))
}))
app.delete('/api/images/:id', needAdmin, wrap(async (req, res) => {
  await q('DELETE FROM images WHERE id=$1', [req.params.id]); res.json({ ok: true })
}))

app.get('/api/paths', wrap(async (req, res) => {
  const r = await q('SELECT * FROM paths ORDER BY name')
  res.set('Cache-Control', 'no-store').json({ paths: r.rows.map((x) => ({ id: x.id, name: x.name, coords: JSON.parse(x.coords) })) })
}))
app.post('/api/paths', needAdmin, wrap(async (req, res) => {
  const p = cleanPath(req.body), id = randomUUID()
  await q('INSERT INTO paths (id,name,coords,created_by) VALUES ($1,$2,$3,$4)', [id, p.name, JSON.stringify(p.coords), req.user.id])
  res.status(201).json({ path: { id, ...p } })
}))
app.put('/api/paths/:id', needAdmin, wrap(async (req, res) => {
  const p = cleanPath(req.body)
  const r = await q('UPDATE paths SET name=$1,coords=$2,updated_at=now() WHERE id=$3 RETURNING id', [p.name, JSON.stringify(p.coords), req.params.id])
  if (!r.rows.length) throw new HttpError(404, 'Path not found')
  res.json({ path: { id: req.params.id, ...p } })
}))
app.delete('/api/paths/:id', needAdmin, wrap(async (req, res) => {
  await q('DELETE FROM paths WHERE id=$1', [req.params.id]); res.json({ ok: true })
}))

app.get('/api/admin/users', needAdmin, wrap(async (req, res) => {
  const r = await q('SELECT * FROM users ORDER BY created_at DESC')
  res.json({ users: r.rows.map(pubUser) })
}))
app.patch('/api/admin/users/:id', needAdmin, wrap(async (req, res) => {
  const role = req.body.role
  if (!['admin', 'student'].includes(role)) throw new HttpError(400, 'Invalid role')
  if (req.params.id === req.user.id) throw new HttpError(400, "You can't change your own role")
  await q('UPDATE users SET role=$1 WHERE id=$2', [role, req.params.id]); res.json({ ok: true })
}))
app.delete('/api/admin/users/:id', needAdmin, wrap(async (req, res) => {
  if (req.params.id === req.user.id) throw new HttpError(400, "You can't delete your own account")
  await q('DELETE FROM users WHERE id=$1', [req.params.id]); res.json({ ok: true })
}))

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }))

const dist = path.join(here, '../dist')
if (existsSync(dist)) {
  app.use(express.static(dist))
  app.use((req, res) => res.sendFile(path.join(dist, 'index.html')))
}
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.status) return res.status(err.status).json({ error: err.message })
  console.error(err); res.status(500).json({ error: 'Server error' })
})

const port = process.env.PORT || 3000
app.listen(port, () => console.log('AFIT Wayfinder server on :' + port))
