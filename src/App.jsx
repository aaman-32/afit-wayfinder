import { useCallback, useEffect, useState } from 'react'
import { api, getToken, setToken, store } from './api'
import AuthPage from './AuthPage'
import AdminUsers from './AdminUsers'
import MapView from './MapView'
import './App.css'

const CACHE = 'afit_places_cache'
const PCACHE = 'afit_paths_cache'
const readCache = (k = CACHE) => { try { return JSON.parse(store.get(k) || 'null') } catch { return null } }

export default function App() {
  const [user, setUser] = useState(null)
  const [ready, setReady] = useState(!getToken())
  const [guest, setGuest] = useState(store.get('afit_guest') === '1')
  const [view, setView] = useState('map')
  const [places, setPlaces] = useState(() => readCache() || [])
  const [paths, setPaths] = useState(() => readCache(PCACHE) || [])
  const [status, setStatus] = useState('ok')

  useEffect(() => {
    if (!getToken()) return
    api('/me').then((d) => setUser(d.user))
      .catch((e) => { if (e.status === 401) setToken(null) })
      .finally(() => setReady(true))
  }, [])

  const loadPlaces = useCallback(async () => {
    try {
      const d = await api('/places')
      setPlaces(d.places); store.set(CACHE, JSON.stringify(d.places)); setStatus('ok')
      try { const pd = await api('/paths'); setPaths(pd.paths); store.set(PCACHE, JSON.stringify(pd.paths)) } catch { /* keep cached paths */ }
    } catch {
      setStatus('offline')
      if (!readCache()) {
        try {
          const j = await (await fetch('/campus-data.json')).json()
          setPlaces(j.features.map((f) => ({ id: f.properties.id, name: f.properties.name, category: f.properties.category, description: f.properties.description, keywords: f.properties.search_keywords || [], lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] })))
        } catch { /* nothing to show */ }
      }
    }
  }, [])

  // keep every device in sync: refresh now, every minute, and when the app regains focus
  useEffect(() => {
    const t0 = setTimeout(loadPlaces, 0)
    const t = setInterval(loadPlaces, 60000)
    const onVis = () => document.visibilityState === 'visible' && loadPlaces()
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('focus', loadPlaces)
    return () => { clearTimeout(t0); clearInterval(t); document.removeEventListener('visibilitychange', onVis); window.removeEventListener('focus', loadPlaces) }
  }, [loadPlaces])

  const logout = () => { setToken(null); store.del('afit_guest'); setGuest(false); setUser(null); setView('map') }
  const goGuest = () => { store.set('afit_guest', '1'); setGuest(true) }

  if (!ready) return <div className="auth"><p>Loading…</p></div>
  if (!user && !guest) return <AuthPage onAuth={(u) => { setUser(u); setView('map') }} onGuest={goGuest} />
  if (view === 'users' && user?.role === 'admin') return <AdminUsers me={user} onBack={() => setView('map')} />
  return <MapView user={user} places={places} paths={paths} status={status} onChanged={loadPlaces} onLogout={logout} onUsers={() => setView('users')} onLogin={() => { store.del('afit_guest'); setGuest(false) }} />
}
