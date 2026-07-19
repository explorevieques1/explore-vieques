import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { getSession } from '../lib/supabase.js'

// Gate for logged-in-only pages. Entitlement (did they PAY?) is checked
// separately by the backend — this only checks identity.
export default function ProtectedRoute({ children }) {
  const [state, setState] = useState('checking') // checking | in | out

  useEffect(() => {
    getSession().then(({ data }) => setState(data.session ? 'in' : 'out'))
  }, [])

  if (state === 'checking') return <p style={{ padding: 24 }}>Loading…</p>
  if (state === 'out') return <Navigate to="/login" replace />
  return children
}
