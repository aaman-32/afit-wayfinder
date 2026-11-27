import { useState } from 'react'
import { api, setToken } from './api'

export default function AuthPage({ onAuth, onGuest }) {
  const [mode, setMode] = useState('login')
  const [f, setF] = useState({ name: '', email: '', password: '' })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault(); setErr(''); setBusy(true)
    try {
      const d = await api(mode === 'login' ? '/auth/login' : '/auth/register', { method: 'POST', body: f })
      setToken(d.token); onAuth(d.user)
    } catch (x) { setErr(x.message) } finally { setBusy(false) }
  }

  return (
    <div className="auth">
      <form className="card" onSubmit={submit}>
        <h1>📍 AFIT Wayfinder</h1>
        <p className="muted">{mode === 'login' ? 'Log in to your account' : 'Create a student account'}</p>
        {mode === 'register' && <input placeholder="Full name" autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}
        <input type="email" placeholder="Email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        <input type="password" placeholder="Password (min 8 characters)" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        {err && <div className="err">{err}</div>}
        <button disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Sign up'}</button>
        <button type="button" className="sec" onClick={() => { setErr(''); setMode(mode === 'login' ? 'register' : 'login') }}>
          {mode === 'login' ? 'New student? Create account' : 'Have an account? Log in'}
        </button>
        <button type="button" className="link" onClick={onGuest}>Continue as guest</button>
      </form>
    </div>
  )
}
