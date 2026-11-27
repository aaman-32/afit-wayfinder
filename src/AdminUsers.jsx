import { useEffect, useState } from 'react'
import { api } from './api'

const when = (d) => (d ? new Date(d).toLocaleString() : '—')

export default function AdminUsers({ me, onBack }) {
  const [users, setUsers] = useState(null)
  const [err, setErr] = useState('')
  const load = () => api('/admin/users').then((d) => setUsers(d.users)).catch((e) => setErr(e.message))
  useEffect(() => { load() }, [])

  const act = async (fn) => { setErr(''); try { await fn(); await load() } catch (e) { setErr(e.message) } }
  const setRole = (u, role) => act(() => api('/admin/users/' + u.id, { method: 'PATCH', body: { role } }))
  const remove = (u) => confirm(`Delete ${u.name} (${u.email})?`) && act(() => api('/admin/users/' + u.id, { method: 'DELETE' }))

  return (
    <div className="page">
      <div className="bar"><button className="sec" onClick={onBack}>← Map</button><h1>Users {users ? `(${users.length})` : ''}</h1></div>
      <div className="users">
        {err && <div className="err">{err}</div>}
        {!users && !err && <p>Loading…</p>}
        {users?.map((u) => (
          <div className="ucard" key={u.id}>
            <div><b>{u.name}</b> <span className={`badge ${u.role}`}>{u.role}</span>
              <small>{u.email}</small>
              <small>Joined {when(u.created_at)} · Last login {when(u.last_login)}</small></div>
            {u.id !== me.id && (
              <div className="acts">
                <button className="sec" onClick={() => setRole(u, u.role === 'admin' ? 'student' : 'admin')}>{u.role === 'admin' ? 'Make student' : 'Make admin'}</button>
                <button className="sec" onClick={() => remove(u)}>Delete</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
