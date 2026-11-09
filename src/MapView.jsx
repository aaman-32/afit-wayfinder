import { useEffect, useMemo, useRef, useState } from 'react'
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { api, imgUrl } from './api'
import { bearing, buildGraph, dist, distLL, fmt, mins, pathRoute } from './geo'
import { resizeImage } from './imageUtil'

const CATS = { academic: '🎓', housing: '🛏️', food: '🍽️', community: '🤝', recreation: '⚽', administration: '🏢', market: '🛒', health: '🏥', other: '📌' }
const COLORS = { academic: '#4f7cff', housing: '#f59e0b', food: '#ef4444', community: '#a855f7', recreation: '#22c55e', administration: '#64748b', market: '#ec4899', health: '#14b8a6', other: '#94a3b8' }
const CENTER = [7.448, 10.6135] // [lng, lat]
const STYLE = 'https://tiles.openfreemap.org/styles/liberty' // free vector tiles with 3D buildings
const ROUTER = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/'
const EMPTY = { id: null, name: '', category: 'academic', description: '', height: 10, footprint: [], images: [], newImgs: [], removed: [] }
const EMPTYFC = { type: 'FeatureCollection', features: [] }
const pinEl = (c) => { const d = document.createElement('div'); d.className = 'pin'; d.textContent = CATS[c] || '📌'; return d }

export default function MapView({ user, places, paths, status, onChanged, onLogout, onUsers, onLogin }) {
  const isAdmin = user?.role === 'admin'
  const box = useRef(null), mapRef = useRef(null), meMarker = useRef(null), watchId = useRef(null)
  const [ready, setReady] = useState(false)
  const [mapErr, setMapErr] = useState('')
  const [is3d, setIs3d] = useState(true)
  const [q, setQ] = useState('')
  const [cat, setCat] = useState('all')
  const [me, setMe] = useState(null)
  const [form, setForm] = useState(null)
  const [drawing, setDrawing] = useState(null) // null | 'outline' | 'path'
  const [pathForm, setPathForm] = useState(null) // { name }
  const [pathPts, setPathPts] = useState([])
  const [pick, setPick] = useState(null)
  const [acc, setAcc] = useState(null)
  const [fly, setFly] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [nav, setNav] = useState(null)
  const [gallery, setGallery] = useState(null) // { place, i }

  const graph = useMemo(() => buildGraph(paths || []), [paths])

  // ----- create the 3D map once -----
  useEffect(() => {
    let map
    try {
      map = new maplibregl.Map({ container: box.current, style: STYLE, center: CENTER, zoom: 16.5, pitch: 55, bearing: -15, maxPitch: 75 })
    } catch { setTimeout(() => setMapErr('3D maps need WebGL, which this device or browser does not support.'), 0); return }
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right')
    map.on('load', () => {
      ;['buildings', 'paths', 'route', 'draft'].forEach((id) => map.addSource(id, { type: 'geojson', data: EMPTYFC }))
      map.addLayer({ id: 'buildings-3d', type: 'fill-extrusion', source: 'buildings', paint: { 'fill-extrusion-color': ['get', 'color'], 'fill-extrusion-height': ['get', 'height'], 'fill-extrusion-base': 0, 'fill-extrusion-opacity': 0.9 } })
      map.addLayer({ id: 'paths-line', type: 'line', source: 'paths', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#16a34a', 'line-width': 4, 'line-dasharray': [2, 1] } })
      map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#fff', 'line-width': 9 } })
      map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#0b5fff', 'line-width': 5 } })
      map.addLayer({ id: 'draft-fill', type: 'fill', source: 'draft', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#d93025', 'fill-opacity': 0.3 } })
      map.addLayer({ id: 'draft-line', type: 'line', source: 'draft', filter: ['!=', ['geometry-type'], 'Point'], paint: { 'line-color': '#d93025', 'line-width': 3 } })
      map.addLayer({ id: 'draft-pts', type: 'circle', source: 'draft', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 5, 'circle-color': '#d93025', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } })
      setReady(true)
    })
    mapRef.current = map
    return () => { map.remove(); mapRef.current = null; setReady(false) }
  }, [])

  // ----- data layers: buildings (3D outlines) and campus paths -----
  useEffect(() => {
    if (!ready) return
    const feats = places.filter((p) => p.footprint?.length >= 3).map((p) => ({
      type: 'Feature', properties: { height: p.height || 10, color: COLORS[p.category] || COLORS.other },
      geometry: { type: 'Polygon', coordinates: [[...p.footprint, p.footprint[0]]] },
    }))
    mapRef.current.getSource('buildings').setData({ type: 'FeatureCollection', features: feats })
  }, [places, ready])
  useEffect(() => {
    if (!ready) return
    mapRef.current.getSource('paths').setData({ type: 'FeatureCollection', features: (paths || []).map((p) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: p.coords } })) })
  }, [paths, ready])

  // drawing preview (building outline or new path)
  const fp = form?.footprint
  const draftPts = useMemo(() => (drawing === 'path' ? pathPts : fp || []), [drawing, pathPts, fp])
  useEffect(() => {
    if (!ready) return
    const pts = draftPts, feats = []
    if (pts.length >= 2) {
      const poly = drawing !== 'path' && pts.length >= 3
      feats.push({ type: 'Feature', properties: {}, geometry: poly ? { type: 'Polygon', coordinates: [[...pts, pts[0]]] } : { type: 'LineString', coordinates: pts } })
    }
    pts.forEach((c) => feats.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } }))
    mapRef.current.getSource('draft').setData({ type: 'FeatureCollection', features: feats })
  }, [draftPts, drawing, ready])

  // ----- GPS -----
  const locate = (cb) => {
    if (!navigator.geolocation) return alert('GPS is not supported on this device.')
    navigator.geolocation.getCurrentPosition((p) => {
      const ll = [p.coords.latitude, p.coords.longitude]
      setMe(ll); cb?.(ll, p.coords.accuracy)
    }, (e) => alert('Could not get location: ' + e.message), { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 })
  }
  useEffect(() => { const t = setTimeout(() => locate(), 0); return () => clearTimeout(t) }, [])
  useEffect(() => {
    if (!ready || !me) return
    if (!meMarker.current) {
      const el = document.createElement('div'); el.className = 'me-dot'
      meMarker.current = new maplibregl.Marker({ element: el }).setLngLat([me[1], me[0]]).addTo(mapRef.current)
    } else meMarker.current.setLngLat([me[1], me[0]])
  }, [me, ready])

  const list = useMemo(() => {
    const s = q.toLowerCase()
    return places
      .filter((p) => (cat === 'all' || p.category === cat) &&
        `${p.name} ${p.description} ${p.category} ${(p.keywords || []).join(' ')}`.toLowerCase().includes(s))
      .sort((a, b) => (me ? dist(me, [a.lat, a.lng]) - dist(me, [b.lat, b.lng]) : 0))
  }, [places, q, cat, me])
  const cats = ['all', ...new Set([...Object.keys(CATS), ...places.map((p) => p.category)])]

  // ----- directions: campus paths first, then OpenStreetMap walking routes, then a straight line -----
  const stopWatch = () => { if (watchId.current != null) { navigator.geolocation.clearWatch(watchId.current); watchId.current = null } }
  const routeTo = async (p) => {
    const map = mapRef.current
    let from = me
    if (!from) {
      from = await new Promise((res) => navigator.geolocation?.getCurrentPosition((x) => res([x.coords.latitude, x.coords.longitude]), () => res(null), { enableHighAccuracy: true, timeout: 15000 }))
      if (!from) return alert('Turn on location to get directions.')
      setMe(from)
    }
    const a = [from[1], from[0]], b = [p.lng, p.lat]
    let line = [a, b], d = distLL(a, b), via = 'line'
    const own = pathRoute(graph, a, b)
    if (own) { line = own.coords; d = own.distance; via = 'campus' } else {
      try {
        const r = await (await fetch(`${ROUTER}${a[0]},${a[1]};${b[0]},${b[1]}?overview=full&geometries=geojson`)).json()
        if (r.routes?.[0]) { line = r.routes[0].geometry.coordinates; d = r.routes[0].distance; via = 'osm' }
      } catch { /* straight line */ }
    }
    map.getSource('route').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: line } })
    map.setPaintProperty('route-line', 'line-dasharray', via === 'line' ? [1.5, 1.5] : [1, 0])
    const bb = new maplibregl.LngLatBounds(); line.forEach((c) => bb.extend(c))
    map.fitBounds(bb, { padding: { top: 90, bottom: 200, left: 50, right: 50 }, pitch: 55, bearing: bearing(line[0], line[Math.min(line.length - 1, 3)]), maxZoom: 19, duration: 1200 })
    setNav({ place: p, line, dist: d, via, active: false, arrived: false })
  }
  const clearRoute = () => { stopWatch(); mapRef.current?.getSource('route')?.setData(EMPTYFC); setNav(null) }
  const startNav = () => {
    if (!nav || !navigator.geolocation) return
    setNav((n) => ({ ...n, active: true }))
    watchId.current = navigator.geolocation.watchPosition((p) => {
      const ll = [p.coords.latitude, p.coords.longitude]
      setMe(ll)
      const left = dist(ll, [nav.place.lat, nav.place.lng])
      const ahead = nav.line.find((c) => dist(ll, [c[1], c[0]]) > 25) || nav.line[nav.line.length - 1]
      const hd = p.coords.heading != null && !Number.isNaN(p.coords.heading) && p.coords.speed > 0.5 ? p.coords.heading : bearing([ll[1], ll[0]], ahead)
      mapRef.current?.easeTo({ center: [ll[1], ll[0]], zoom: 19, pitch: 65, bearing: hd, duration: 800 })
      setNav((n) => (n ? { ...n, left, arrived: left < 20 } : n))
    }, () => {}, { enableHighAccuracy: true, maximumAge: 1000 })
  }
  useEffect(() => stopWatch, [])

  // ----- markers with photo popups -----
  const routeRef = useRef(routeTo), galleryRef = useRef(setGallery)
  useEffect(() => { routeRef.current = routeTo })
  useEffect(() => {
    if (!ready) return
    const markers = list.map((p) => {
      const pop = document.createElement('div'); pop.className = 'popbox'
      if (p.images?.length) {
        const im = document.createElement('img'); im.src = imgUrl(p.images[0]); im.className = 'popimg'; im.loading = 'lazy'
        im.onclick = () => galleryRef.current({ place: p, i: 0 })
        pop.append(im)
        if (p.images.length > 1) { const n = document.createElement('small'); n.textContent = `📷 ${p.images.length} photos (tap to view)`; pop.append(n) }
      }
      const t = document.createElement('b'); t.textContent = p.name
      const c = document.createElement('div'); c.textContent = p.category + (p.description ? ' · ' + p.description : '')
      const btn = document.createElement('button'); btn.textContent = '🧭 Directions'; btn.style.marginTop = '6px'
      btn.onclick = () => { routeRef.current(p); markers.forEach((m) => m.getPopup().remove()) }
      pop.append(t, c, btn)
      return new maplibregl.Marker({ element: pinEl(p.category) }).setLngLat([p.lng, p.lat])
        .setPopup(new maplibregl.Popup({ offset: 18, className: 'afit-pop', maxWidth: '260px' }).setDOMContent(pop)).addTo(mapRef.current)
    })
    return () => markers.forEach((m) => m.remove())
  }, [list, ready])

  // ----- admin: tapping the map -----
  const snapRef = useRef(null)
  useEffect(() => { // snap new path points to nearby existing path corners so paths join up
    snapRef.current = (pt) => {
      let best = null, bd = 10
      for (const n of graph.nodes) { const d = distLL(n, pt); if (d < bd) { bd = d; best = n } }
      return best || pt
    }
  }, [graph])
  const tapping = !!form || drawing === 'path'
  useEffect(() => {
    if (!ready || !tapping) return
    const map = mapRef.current
    const click = (e) => {
      const pt = [e.lngLat.lng, e.lngLat.lat]
      if (drawing === 'path') setPathPts((p) => [...p, snapRef.current(pt)])
      else if (drawing === 'outline') setForm((f) => ({ ...f, footprint: [...f.footprint, pt] }))
      else setPick([pt[1], pt[0]])
    }
    map.on('click', click)
    return () => map.off('click', click)
  }, [ready, tapping, drawing])
  useEffect(() => {
    if (!ready || !form || !pick) return
    const m = new maplibregl.Marker({ draggable: true, color: '#d93025' }).setLngLat([pick[1], pick[0]]).addTo(mapRef.current)
    m.on('dragend', () => { const l = m.getLngLat(); setPick([l.lat, l.lng]) })
    return () => m.remove()
  }, [pick, form, ready])

  useEffect(() => {
    if (fly && mapRef.current) mapRef.current.flyTo({ center: [fly.pos[1], fly.pos[0]], zoom: 18.5, pitch: is3d ? 60 : 0, duration: 1200 })
  }, [fly]) // eslint-disable-line react-hooks/exhaustive-deps
  const toggle3d = () => { const n = !is3d; setIs3d(n); mapRef.current?.easeTo({ pitch: n ? 60 : 0, bearing: n ? mapRef.current.getBearing() : 0, duration: 600 }) }

  // ----- admin: places / buildings / photos -----
  const close = () => { setForm(null); setDrawing(null); setPick(null); setAcc(null); setErr('') }
  const edit = (p) => {
    setForm({ id: p.id, name: p.name, category: p.category, description: p.description, height: p.height || 10, footprint: p.footprint || [], images: p.images || [], newImgs: [], removed: [] })
    setPick([p.lat, p.lng]); setFly({ pos: [p.lat, p.lng] })
  }
  const addPhotos = async (files) => {
    setErr('')
    try {
      const out = []
      for (const f of files) out.push(await resizeImage(f))
      setForm((f) => ({ ...f, newImgs: [...f.newImgs, ...out] }))
    } catch (e) { setErr(e.message) }
  }
  const save = async () => {
    setErr('')
    if (!form.name.trim()) return setErr('Enter a name.')
    if (!pick) return setErr('Set the pin location first.')
    if (form.footprint.length && form.footprint.length < 3) return setErr('A building outline needs at least 3 corners (or clear it).')
    setBusy(true)
    try {
      const body = { name: form.name, category: form.category, description: form.description, lat: pick[0], lng: pick[1], footprint: form.footprint.length >= 3 ? form.footprint : null, height: Number(form.height) || 10 }
      const r = await api(form.id ? '/places/' + form.id : '/places', { method: form.id ? 'PUT' : 'POST', body })
      for (const id of form.removed) await api('/images/' + id, { method: 'DELETE' })
      for (const data of form.newImgs) await api(`/places/${r.place.id}/images`, { method: 'POST', body: { data } })
      close(); onChanged()
    } catch (e) { setErr(e.message); onChanged() } finally { setBusy(false) }
  }
  const del = async (p) => {
    if (!confirm(`Delete "${p.name}" and its photos for everyone?`)) return
    try { await api('/places/' + p.id, { method: 'DELETE' }); onChanged() } catch (e) { alert(e.message) }
  }

  // ----- admin: paths -----
  const startPath = () => { setPathForm({ name: '' }); setPathPts([]); setDrawing('path'); setErr('') }
  const closePath = () => { setPathForm(null); setPathPts([]); setDrawing(null); setErr('') }
  const savePath = async () => {
    setErr('')
    if (!pathForm.name.trim()) return setErr('Name the path (e.g. Main gate to Library).')
    if (pathPts.length < 2) return setErr('Tap at least 2 points along the path.')
    setBusy(true)
    try { await api('/paths', { method: 'POST', body: { name: pathForm.name, coords: pathPts } }); closePath(); onChanged() }
    catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  const delPath = async (p) => {
    if (!confirm(`Delete path "${p.name}"?`)) return
    try { await api('/paths/' + p.id, { method: 'DELETE' }); onChanged() } catch (e) { alert(e.message) }
  }

  const gp = gallery?.place
  return (
    <div className="app">
      <div className="bar">
        <h1>📍 AFIT</h1>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search hall, hostel, cafeteria…" />
        {isAdmin && !form && !pathForm && <button onClick={() => setForm({ ...EMPTY })}>+ Place</button>}
        {isAdmin && !form && !pathForm && <button className="sec" onClick={startPath}>+ Path</button>}
      </div>
      <div className="bar sub">
        <small>{user ? `${user.name} · ${user.role}` : 'Guest'}{status === 'offline' ? ' · offline copy' : ''}</small>
        <div className="acts">
          {isAdmin && <button className="sec" onClick={onUsers}>Users</button>}
          {user ? <button className="sec" onClick={onLogout}>Log out</button> : <button className="sec" onClick={onLogin}>Log in</button>}
        </div>
      </div>
      <div className="mapwrap">
        <div ref={box} className="map3d" />
        {mapErr && <div className="maperr">{mapErr}</div>}
        <button className="sec btn3d" onClick={toggle3d}>{is3d ? '3D' : '2D'}</button>
        {nav && (
          <div className="navcard">
            <b>🧭 {nav.place.name}</b>
            <div>{nav.arrived ? "You've arrived 🎉" : `${fmt(nav.left ?? nav.dist)} · about ${mins(nav.left ?? nav.dist)} min walk`}
              {!nav.arrived && nav.via === 'campus' ? ' · via campus paths' : ''}{!nav.arrived && nav.via === 'line' ? ' (straight line: no walking path found)' : ''}</div>
            <div className="row">
              {!nav.active && <button onClick={startNav}>Start</button>}
              <a className="btnlike" target="_blank" rel="noopener noreferrer" href={`https://www.google.com/maps/dir/?api=1&destination=${nav.place.lat},${nav.place.lng}&travelmode=walking`}>Google Maps</a>
              <button className="sec" onClick={clearRoute}>{nav.active ? 'Stop' : 'Close'}</button>
            </div>
          </div>
        )}
      </div>

      {pathForm ? (
        <div className="form">
          <b>Draw a walking path</b>
          <input placeholder="Path name (e.g. Main gate to Library)" value={pathForm.name} onChange={(e) => setPathForm({ name: e.target.value })} />
          <small>Tap along the path in order. Points near an existing path snap to it so routes connect. {pathPts.length} point{pathPts.length === 1 ? '' : 's'}.</small>
          {err && <div className="err">{err}</div>}
          <div className="row">
            <button className="sec" onClick={() => setPathPts((p) => p.slice(0, -1))}>Undo</button>
            <button className="sec" onClick={() => setPathPts([])}>Clear</button>
          </div>
          <div className="row"><button disabled={busy} onClick={savePath}>{busy ? 'Saving…' : 'Save path'}</button><button className="sec" onClick={closePath}>Cancel</button></div>
        </div>
      ) : form ? (
        <div className="form">
          <b>{form.id ? 'Edit place' : 'Add a place or building'}</b>
          <input placeholder="Name (e.g. Block C Lecture Hall)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <div className="row">
            <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              {cats.filter((c) => c !== 'all').map((c) => <option key={c}>{c}</option>)}
            </select>
            <button className="sec" onClick={() => { setDrawing(null); locate((ll, a) => { setPick(ll); setAcc(a); setFly({ pos: ll }) }) }}>Use my exact location</button>
          </div>
          <textarea rows={2} placeholder="How to find it (optional)" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <small>{pick ? `Pin: ${pick[0].toFixed(6)}, ${pick[1].toFixed(6)}${acc ? ` · ±${Math.round(acc)} m` : ''} (drag pin to adjust)` : drawing ? '' : 'Tap the map or use GPS to set the pin.'}</small>

          <div className="box">
            <b>🏢 3D building outline</b>
            <small>{drawing === 'outline' ? 'Tap each corner of the building in order.' : 'Optional: trace the building so it shows in 3D.'} {form.footprint.length} corner{form.footprint.length === 1 ? '' : 's'}.</small>
            <div className="row">
              <button className={drawing === 'outline' ? '' : 'sec'} onClick={() => setDrawing(drawing === 'outline' ? null : 'outline')}>{drawing === 'outline' ? 'Done tracing' : form.footprint.length ? 'Edit outline' : 'Trace outline'}</button>
              <button className="sec" onClick={() => setForm({ ...form, footprint: form.footprint.slice(0, -1) })}>Undo corner</button>
              <button className="sec" onClick={() => setForm({ ...form, footprint: [] })}>Clear</button>
            </div>
            <label className="row" style={{ alignItems: 'center' }}>Height (m)
              <input type="number" min="2" max="200" value={form.height} onChange={(e) => setForm({ ...form, height: e.target.value })} />
            </label>
          </div>

          <div className="box">
            <b>📷 Photos</b>
            <div className="thumbs">
              {form.images.filter((id) => !form.removed.includes(id)).map((id) => (
                <div className="th" key={id}><img src={imgUrl(id)} alt="" /><button onClick={() => setForm({ ...form, removed: [...form.removed, id] })}>✕</button></div>
              ))}
              {form.newImgs.map((d, i) => (
                <div className="th" key={i}><img src={d} alt="" /><button onClick={() => setForm({ ...form, newImgs: form.newImgs.filter((_, j) => j !== i) })}>✕</button></div>
              ))}
            </div>
            <input type="file" accept="image/*" multiple onChange={(e) => { addPhotos([...e.target.files]); e.target.value = '' }} />
          </div>
          {err && <div className="err">{err}</div>}
          <div className="row"><button disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save for everyone'}</button><button className="sec" onClick={close}>Cancel</button></div>
        </div>
      ) : (
        <div className="panel">
          <div className="chips">
            {cats.map((c) => <button key={c} className={`chip ${c === cat ? 'on' : ''}`} onClick={() => setCat(c)}>{CATS[c] || ''} {c}</button>)}
          </div>
          {list.map((p) => (
            <div className="item" key={p.id}>
              <div className="who">
                {p.images?.length > 0 && <img className="thumb" src={imgUrl(p.images[0])} alt="" loading="lazy" onClick={() => setGallery({ place: p, i: 0 })} />}
                <div><b>{CATS[p.category] || '📌'} {p.name}</b><small>{p.category}{p.footprint ? ' · 3D' : ''}{me ? ` · ${fmt(dist(me, [p.lat, p.lng]))}` : ''}</small></div>
              </div>
              <div className="acts">
                <button onClick={() => routeTo(p)}>🧭</button>
                <button className="sec" onClick={() => setFly({ pos: [p.lat, p.lng] })}>Go</button>
                {isAdmin && <button className="sec" onClick={() => edit(p)}>Edit</button>}
                {isAdmin && <button className="sec" onClick={() => del(p)}>✕</button>}
              </div>
            </div>
          ))}
          {isAdmin && (
            <div className="box" style={{ marginTop: 8 }}>
              <b>🛤️ Campus paths ({paths?.length || 0})</b>
              {(paths || []).map((p) => (
                <div className="item" key={p.id}>
                  <div><b>{p.name}</b><small>{p.coords.length} points</small></div>
                  <div className="acts">
                    <button className="sec" onClick={() => setFly({ pos: [p.coords[0][1], p.coords[0][0]] })}>Go</button>
                    <button className="sec" onClick={() => delPath(p)}>✕</button>
                  </div>
                </div>
              ))}
              {!paths?.length && <small>No paths yet. Use “+ Path” to draw one. Drawn paths are used for directions.</small>}
            </div>
          )}
        </div>
      )}

      {gp && (
        <div className="lightbox" onClick={() => setGallery(null)}>
          <img src={imgUrl(gp.images[gallery.i])} alt={gp.name} onClick={(e) => e.stopPropagation()} />
          <div className="cap" onClick={(e) => e.stopPropagation()}>
            <button className="sec" disabled={gallery.i === 0} onClick={() => setGallery({ place: gp, i: gallery.i - 1 })}>‹</button>
            <span>{gp.name} · {gallery.i + 1}/{gp.images.length}</span>
            <button className="sec" disabled={gallery.i >= gp.images.length - 1} onClick={() => setGallery({ place: gp, i: gallery.i + 1 })}>›</button>
            <button onClick={() => setGallery(null)}>Close</button>
          </div>
        </div>
      )}
    </div>
  )
}
