import { useSearchParams, Link } from 'react-router-dom'

// Where the map app lives. Set VITE_APP_URL in the landing env
// (e.g. https://app.explorevieques.org). Falls back to local dev.
const APP_URL = import.meta.env.VITE_APP_URL || 'http://localhost:5173'

const PLAN_LABELS = {
  traveler: 'Traveler Plan',
  credits: 'Credit Pack',
  business_basic: 'Basic Business',
  business_featured: 'Featured Business',
}

export default function Success() {
  const [params] = useSearchParams()
  const plan = params.get('plan')
  const sessionId = params.get('session_id')

  return (
    <main style={styles.wrap}>
      <div style={styles.glow} aria-hidden="true" />
      <div style={styles.card}>
        <div style={styles.check}>✓</div>
        <h1 style={styles.h1}>You're all set!</h1>
        <p style={styles.sub}>
          {plan && PLAN_LABELS[plan]
            ? `Your ${PLAN_LABELS[plan]} is active. Your island guide is ready.`
            : 'Payment received. Your island guide is ready.'}
        </p>

        <div style={styles.actions}>
          <a href={APP_URL} style={styles.btnPrimary}>Launch App →</a>
          <Link to="/" style={styles.btnGhost}>Return Home</Link>
        </div>

        {/* sandbox-only note; remove for production */}
        {sessionId && <p style={styles.meta}>Test session: {sessionId.slice(0, 20)}…</p>}
      </div>
    </main>
  )
}

const styles = {
  wrap: { position: 'relative', minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#0f172a', padding: 24, fontFamily: 'Manrope, system-ui, sans-serif', overflow: 'hidden' },
  glow: { position: 'absolute', inset: 0, pointerEvents: 'none', background: 'radial-gradient(700px 400px at 50% -10%, rgba(6,182,212,.16), transparent 60%)' },
  card: { position: 'relative', width: '100%', maxWidth: 440, textAlign: 'center', background: '#111c33', border: '1px solid rgba(148,163,184,.14)', borderRadius: 16, padding: 40, boxShadow: '0 30px 80px rgba(0,0,0,.4)' },
  check: { width: 56, height: 56, borderRadius: '50%', background: 'rgba(6,182,212,.15)', border: '2px solid #06b6d4', color: '#06b6d4', fontSize: 28, display: 'grid', placeItems: 'center', margin: '0 auto 20px' },
  h1: { fontFamily: 'Space Grotesk, sans-serif', color: '#e2e8f0', fontSize: 28, margin: '0 0 10px' },
  sub: { color: '#94a3b8', fontSize: 15, lineHeight: 1.5, margin: '0 0 28px' },
  actions: { display: 'grid', gap: 12 },
  btnPrimary: { padding: '14px 20px', borderRadius: 10, background: '#06b6d4', color: '#0b1120', fontWeight: 700, fontSize: 15, textDecoration: 'none' },
  btnGhost: { padding: '13px 20px', borderRadius: 10, background: 'transparent', color: '#e2e8f0', border: '1px solid rgba(148,163,184,.2)', fontWeight: 600, fontSize: 14, textDecoration: 'none' },
  meta: { marginTop: 20, color: '#64748b', fontSize: 11, fontFamily: 'monospace' },
}