// Payment engine for Vieques AI.
// All Stripe secret-key work + webhook fulfillment lives here.
// The browser never sees the secret key and can never grant itself access:
// entitlements are written only by the webhook, over the direct pg connection
// (which bypasses RLS because it connects as the DB user, not the anon key).

import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '')
const APP_URL = process.env.APP_URL || 'http://localhost:5173'

// Supabase client used ONLY to verify a user's JWT (getUser).
// Uses the anon key — verifying a token needs no elevated rights.
const supabaseAuth = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_ANON_KEY || ''
)

// Plans defined server-side so the browser can never change the price.
export const PLANS = {
  traveler:          { name: 'Traveler Plan', amount: 900,  mode: 'payment',      description: 'Full island access for your trip', grants: { type: 'access', days: 30 } },
  credits:           { name: 'Credit Pack',   amount: 300,  mode: 'payment',      description: 'Pay-as-you-go AI queries',         grants: { type: 'credits', amount: 20 } },
  business_basic:    { name: 'Basic Plan',    amount: 2900, mode: 'subscription', description: 'Get your business on the map', interval: 'month', grants: { type: 'access' } },
  business_featured: { name: 'Featured',      amount: 7900, mode: 'subscription', description: 'Priority placement',           interval: 'month', grants: { type: 'access' } },
}

// --- Verify the Supabase JWT the frontend sends in the Authorization header ---
// Returns { id, email } or null. Never trust userId/email from the body alone;
// this is what ties a payment to a real, authenticated account.
export async function getUserFromAuthHeader(req) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return null
  const { data, error } = await supabaseAuth.auth.getUser(token)
  if (error || !data?.user) return null
  return { id: data.user.id, email: data.user.email }
}

// --- Get or create the Stripe customer for a user, persisted in customers table ---
async function resolveStripeCustomer(pool, user) {
  const { rows } = await pool.query(
    'SELECT stripe_customer_id FROM public.customers WHERE user_id = $1',
    [user.id]
  )
  if (rows[0]?.stripe_customer_id) return rows[0].stripe_customer_id

  const customer = await stripe.customers.create({
    email: user.email,
    metadata: { supabase_user_id: user.id },
  })

  await pool.query(
    `INSERT INTO public.customers (user_id, stripe_customer_id, email)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id`,
    [user.id, customer.id, user.email]
  )
  return customer.id
}

// --- Create a Checkout session (called by POST /api/checkout) ---
export async function createCheckoutSession(pool, req, res) {
  try {
    const plan = PLANS[req.body?.plan]
    if (!plan) return res.status(400).json({ error: 'Unknown plan' })

    // Must be a logged-in user — otherwise we can't grant access after payment.
    const user = await getUserFromAuthHeader(req)
    if (!user) return res.status(401).json({ error: 'Please sign in before checking out.' })

    const customerId = await resolveStripeCustomer(pool, user)

    const price_data = {
      currency: 'usd',
      product_data: { name: plan.name, description: plan.description },
      unit_amount: plan.amount,
    }
    if (plan.mode === 'subscription') {
      price_data.recurring = { interval: plan.interval || 'month' }
    }

    const session = await stripe.checkout.sessions.create({
      mode: plan.mode,
      customer: customerId,
      line_items: [{ price_data, quantity: 1 }],
      // metadata travels to the webhook so we know who + what to grant.
      metadata: { supabase_user_id: user.id, plan: req.body.plan },
      success_url: `${APP_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/pricing?checkout=cancel`,
    })

    res.json({ url: session.url })
  } catch (e) {
    console.error('checkout error:', e.message)
    res.status(500).json({ error: e.message })
  }
}

// --- Webhook: the ONLY place access/credits get granted ---
// Mounted with express.raw() so Stripe's signature can be verified.
export async function handleWebhook(pool, req, res) {
  let event
  try {
    event = stripe.webhooks.constructEvent(
      req.body, // raw Buffer, thanks to express.raw()
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    )
  } catch (err) {
    console.error('webhook signature failed:', err.message)
    return res.status(400).send(`Webhook Error: ${err.message}`)
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object
      const userId = session.metadata?.supabase_user_id
      const planKey = session.metadata?.plan
      const plan = PLANS[planKey]
      if (userId && plan) {
        await fulfill(pool, { userId, planKey, plan, session })
      }
    }

    // Keep subscription status in sync (cancels, failed renewals, etc.)
    if (event.type === 'customer.subscription.deleted' ||
        event.type === 'customer.subscription.updated') {
      const sub = event.data.object
      const status = sub.status === 'active' || sub.status === 'trialing' ? 'active'
                   : sub.status === 'past_due' ? 'past_due' : 'canceled'
      await pool.query(
        `UPDATE public.subscriptions SET status = $1 WHERE stripe_subscription_id = $2`,
        [status, sub.id]
      )
    }

    res.json({ received: true })
  } catch (e) {
    console.error('webhook handling error:', e.message)
    res.status(500).json({ error: e.message })
  }
}

// Grant whatever the plan promised. Idempotent on stripe_session_id so
// Stripe's automatic retries can't double-grant.
async function fulfill(pool, { userId, planKey, plan, session }) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // guard against duplicate delivery
    const dup = await client.query(
      'SELECT 1 FROM public.subscriptions WHERE stripe_session_id = $1',
      [session.id]
    )
    if (dup.rowCount > 0) { await client.query('COMMIT'); return }

    const expiresAt =
      plan.grants?.type === 'access' && plan.grants?.days
        ? new Date(Date.now() + plan.grants.days * 86400_000)
        : null

    await client.query(
      `INSERT INTO public.subscriptions
         (user_id, plan, status, expires_at,
          stripe_customer_id, stripe_subscription_id, stripe_session_id)
       VALUES ($1, $2, 'active', $3, $4, $5, $6)`,
      [userId, planKey, expiresAt, session.customer, session.subscription || null, session.id]
    )

    if (plan.grants?.type === 'credits') {
      await client.query(
        `INSERT INTO public.credit_transactions (user_id, amount, reason, ref)
         VALUES ($1, $2, 'purchase', $3)`,
        [userId, plan.grants.amount, session.id]
      )
    }

    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

// --- Entitlement check (called by GET /api/entitlement) ---
// The app calls this to decide whether to let the user in.
export async function getEntitlement(pool, req, res) {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user) return res.status(401).json({ error: 'Not signed in' })

    const { rows } = await pool.query(
      `SELECT plan, status, expires_at FROM public.subscriptions
       WHERE user_id = $1 AND status = 'active'
         AND (expires_at IS NULL OR expires_at > now())
       ORDER BY created_at DESC`,
      [user.id]
    )
    const { rows: bal } = await pool.query(
      'SELECT balance FROM public.credit_balances WHERE user_id = $1',
      [user.id]
    )

    res.json({
      hasAccess: rows.length > 0,
      plans: rows,
      credits: bal[0]?.balance ?? 0,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
}