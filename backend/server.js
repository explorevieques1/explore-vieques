// Vieques AI — backend API (gatekeeper between frontend and Postgres/Claude)
import express from 'express'
import cors from 'cors'
import pg from 'pg'
import dotenv from 'dotenv'
import Stripe from 'stripe'
import Anthropic from '@anthropic-ai/sdk'
import { TOOLS, runTool } from './aiTools.js'

dotenv.config()

// --- Stripe ---
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '')
const APP_URL = process.env.APP_URL || 'http://localhost:5173'

// --- Claude AI ---
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' })

// Plans defined server-side so the browser can never change the price.
const PLANS = {
  traveler: { name: 'Traveler Plan', amount: 900, mode: 'payment', description: 'Full island access for your trip' },
  credits:  { name: 'Credit Pack',   amount: 300, mode: 'payment', description: 'Pay-as-you-go AI queries' },
  business_basic:    { name: 'Basic Plan', amount: 2900, mode: 'subscription', description: 'Get your business on the map', interval: 'month' },
  business_featured: { name: 'Featured',   amount: 7900, mode: 'subscription', description: 'Priority placement', interval: 'month' },
}


const app = express()
app.use(cors())            // allow the frontend dev server to call this
app.use(express.json())

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'vieques_ai',
  user: process.env.DB_USER || 'vieques_app',
  password: process.env.DB_PASSWORD || '',
})

// Health check
app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1')
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// All active beaches, shaped for the map + popup.
// Optional query filters:
//   ?type=snorkeling,family   (match ANY listed type)
//   ?water=calm               (exact water_conditions)
//   ?refuge=true|false        (in_wildlife_refuge)
//   ?facilities=restroom,parking  (facility text contains ANY keyword)
app.get('/api/beaches', async (req, res) => {
  try {
    const where = ['is_active = true']
    const params = []

    if (req.query.type) {
      const types = String(req.query.type).split(',').map((t) => t.trim()).filter(Boolean)
      if (types.length) {
        params.push(types)
        where.push(`type && $${params.length}`) // array overlap = matches ANY
      }
    }
    if (req.query.water) {
      params.push(String(req.query.water).trim())
      where.push(`water_conditions = $${params.length}`)
    }
    if (req.query.refuge === 'true' || req.query.refuge === 'false') {
      params.push(req.query.refuge === 'true')
      where.push(`in_wildlife_refuge = $${params.length}`)
    }
    if (req.query.facilities) {
      const kws = String(req.query.facilities).split(',').map((k) => k.trim().toLowerCase()).filter(Boolean)
      if (kws.length) {
        // match if ANY facility string contains ANY keyword
        params.push(kws)
        where.push(`EXISTS (
          SELECT 1 FROM unnest(facilities) f
          WHERE f ILIKE ANY (SELECT '%' || kw || '%' FROM unnest($${params.length}::text[]) kw)
        )`)
      }
    }

    const { rows } = await pool.query(
      `SELECT id, name, local_name, latitude, longitude,
              region, type, water_conditions, access, facilities,
              best_for, in_wildlife_refuge, gate_hours, notes
       FROM beaches
       WHERE ${where.join(' AND ')}
       ORDER BY name`,
      params,
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})


// Activity categories for the sidebar
app.get('/api/activity-categories', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT slug, label FROM activity_categories ORDER BY sort_order'
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Listings (pins) for one activity slug
app.get('/api/activities/:slug', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT l.id, l.name, l.description, l.phones, l.website, l.address,
              l.location_area, l.latitude, l.longitude, l.price_info, l.hours
       FROM activity_listings l
       JOIN activity_listing_categories lc ON lc.listing_id = l.id
       JOIN activity_categories c ON c.id = lc.category_id
       WHERE c.slug = $1 AND l.is_active = true
       ORDER BY l.name`,
      [req.params.slug]
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})


// Self-guided snorkeling spots (pins)
app.get('/api/snorkel-spots', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, beach_id, description, difficulty, entry_notes,
              latitude, longitude, offers_tours
       FROM snorkel_spots
       WHERE is_active = true AND latitude IS NOT NULL
       ORDER BY name`
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Zones for one snorkel spot, returned as a GeoJSON FeatureCollection
app.get('/api/snorkel-spots/:id/zones', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, label, zone_type, color, description,
              ST_AsGeoJSON(area::geometry) AS geojson
       FROM snorkel_zones
       WHERE spot_id = $1
       ORDER BY sort_order`,
      [req.params.id]
    )
    const features = rows.map((r) => ({
      type: 'Feature',
      properties: {
        id: r.id,
        label: r.label,
        zone_type: r.zone_type,
        color: r.color,
        description: r.description,
      },
      geometry: JSON.parse(r.geojson),
    }))
    res.json({ type: 'FeatureCollection', features })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})


// Service categories for the sidebar
app.get('/api/service-categories', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT slug, label FROM service_categories ORDER BY sort_order'
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Listings for one service slug. ?located=true returns only mappable ones.
app.get('/api/services/:slug', async (req, res) => {
  try {
    const onlyLocated = req.query.located === 'true'
    const { rows } = await pool.query(
      `SELECT l.id, l.name, l.description, l.phones, l.email, l.website,
              l.address, l.location_area, l.latitude, l.longitude,
              l.has_location, l.hours
       FROM service_listings l
       JOIN service_listing_categories lc ON lc.listing_id = l.id
       JOIN service_categories c ON c.id = lc.category_id
       WHERE c.slug = $1 AND l.is_active = true
       ${onlyLocated ? 'AND l.has_location = true' : ''}
       ORDER BY l.name`,
      [req.params.slug]
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})


// Create a Stripe Checkout session for a plan
app.post('/api/checkout', async (req, res) => {
  try {
    const plan = PLANS[req.body?.plan]
    if (!plan) return res.status(400).json({ error: 'Unknown plan' })

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
      line_items: [{ price_data, quantity: 1 }],
      success_url: `${APP_URL}/?checkout=success`,
      cancel_url: `${APP_URL}/?checkout=cancel`,
    })

    res.json({ url: session.url })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})


// Transportation categories for the sidebar
app.get('/api/transport-categories', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT slug, label, is_physical FROM transport_categories ORDER BY sort_order'
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Listings for one transport slug. Includes taxi metadata and, for car
// rentals, the vehicle fleet (aggregated as JSON).
app.get('/api/transport/:slug', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT l.id, l.name, l.description, l.phones, l.email, l.website,
              l.address, l.location_area, l.latitude, l.longitude,
              l.has_location, l.hours, l.metadata,
              COALESCE(
                (SELECT json_agg(json_build_object(
                   'make', v.make, 'model', v.model,
                   'doors', v.doors, 'passengers', v.passengers
                 ) ORDER BY v.sort_order)
                 FROM transport_vehicles v WHERE v.listing_id = l.id),
                '[]'::json
              ) AS vehicles
       FROM transport_listings l
       JOIN transport_listing_categories lc ON lc.listing_id = l.id
       JOIN transport_categories c ON c.id = lc.category_id
       WHERE c.slug = $1 AND l.is_active = true
       ORDER BY l.name`,
      [req.params.slug]
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})


// Restaurant categories for the sidebar
app.get('/api/restaurant-categories', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT slug, label FROM restaurant_categories ORDER BY sort_order'
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Listings for one restaurant category slug
app.get('/api/restaurants/:slug', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT l.id, l.name, l.description, l.phones, l.cuisine, l.price,
              l.hours, l.email, l.website, l.address, l.location_area,
              l.latitude, l.longitude, l.has_location
       FROM restaurant_listings l
       JOIN restaurant_listing_categories lc ON lc.listing_id = l.id
       JOIN restaurant_categories c ON c.id = lc.category_id
       WHERE c.slug = $1 AND l.is_active = true
       ORDER BY l.name`,
      [req.params.slug]
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})


// AI chat with tool use. Body: { messages: [{role, content}], }
// Returns { reply: string, pins: [...] }
const SYSTEM_PROMPT = `You are the Vieques AI assistant, a friendly local guide for the island of Vieques, Puerto Rico. Help visitors find beaches, restaurants, activities, and transportation.

When a user asks about something, use the provided tools to look up real data from the database, then answer naturally and concisely based ONLY on what the tools return. Never invent places that the tools did not return. If a tool returns nothing, say you do not have that listed yet.

FORMATTING RULES (important — your answer shows in a narrow mobile chat pane):
- Do NOT use Markdown tables. Never use the | character for tables.
- Present lists of places as short bullet points, one per line, like: "- **Name** — 787-555-1234".
- Keep the whole reply brief. A one-sentence intro, then the list, then at most one short tip.
- Use **bold** only for place names. Avoid headings.
- The places you mention also appear as pins on the map, so you don't need to repeat addresses.`

app.post('/api/ai/chat', async (req, res) => {
  try {
    const userMessages = Array.isArray(req.body?.messages) ? req.body.messages : []
    if (!userMessages.length) return res.status(400).json({ error: 'No messages' })

    const messages = [...userMessages]
    const allPins = []
    let finalText = ''

    // tool-use loop (cap iterations to avoid runaway)
    for (let i = 0; i < 5; i++) {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      })

      // collect any text
      const textParts = response.content.filter((c) => c.type === 'text').map((c) => c.text)
      if (textParts.length) finalText = textParts.join('\n')

      const toolUses = response.content.filter((c) => c.type === 'tool_use')
      if (toolUses.length === 0) break // Claude is done

      // run each requested tool, gather results + pins
      messages.push({ role: 'assistant', content: response.content })
      const toolResults = []
      for (const tu of toolUses) {
        const { listings, pins } = await runTool(pool, tu.name, tu.input || {})
        allPins.push(...pins)
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(listings).slice(0, 6000),
        })
      }
      messages.push({ role: 'user', content: toolResults })
    }

    // de-dupe pins by id+kind
    const seen = new Set()
    const pins = allPins.filter((p) => {
      const k = p.kind + ':' + p.id
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })

    res.json({ reply: finalText || 'Sorry, I could not find an answer.', pins })
  } catch (e) {
    console.error('AI chat error:', e)
    res.status(500).json({ error: e.message })
  }
})


// Resolve a typed place name to a listing+coords using fuzzy, accent-insensitive
// matching across all mapped tables. Returns best match or null.
async function resolvePlace(term) {
  const { rows } = await pool.query(
    `WITH q AS (SELECT unaccent(lower($1)) AS t)
     SELECT name, latitude, longitude, kind,
            similarity(unaccent(lower(name)), (SELECT t FROM q)) AS sim
     FROM (
       SELECT name, latitude, longitude, 'beach' AS kind FROM beaches WHERE latitude IS NOT NULL AND is_active = true
       UNION ALL SELECT name, latitude, longitude, 'restaurant' FROM restaurant_listings WHERE latitude IS NOT NULL AND is_active = true
       UNION ALL SELECT name, latitude, longitude, 'transport'  FROM transport_listings  WHERE latitude IS NOT NULL AND is_active = true
       UNION ALL SELECT name, latitude, longitude, 'service'    FROM service_listings    WHERE latitude IS NOT NULL AND is_active = true
       UNION ALL SELECT name, latitude, longitude, 'activity'   FROM activity_listings   WHERE latitude IS NOT NULL AND is_active = true
     ) s
     WHERE similarity(unaccent(lower(name)), (SELECT t FROM q)) > 0.15
     ORDER BY sim DESC LIMIT 1`,
    [term],
  )
  return rows[0] || null
}

// Directions: resolve two place names, fetch a road route from OSRM (free),
// return the route geometry + distance/time + a Google Maps link.
// Body: { from: string, to: string }
app.post('/api/directions', async (req, res) => {
  try {
    const from = String(req.body?.from || '').trim()
    const to = String(req.body?.to || '').trim()
    if (!from || !to) return res.status(400).json({ error: 'Need both from and to.' })

    const a = await resolvePlace(from)
    const b = await resolvePlace(to)
    if (!a) return res.status(404).json({ error: `Couldn't find a place matching "${from}".` })
    if (!b) return res.status(404).json({ error: `Couldn't find a place matching "${to}".` })

    const coords = `${a.longitude},${a.latitude};${b.longitude},${b.latitude}`
    const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`
    const osrm = await fetch(url).then((r) => r.json())
    if (osrm.code !== 'Ok' || !osrm.routes?.length) {
      return res.status(502).json({ error: 'Could not compute a route.' })
    }
    const route = osrm.routes[0]

    res.json({
      from: { name: a.name, kind: a.kind, latitude: a.latitude, longitude: a.longitude },
      to:   { name: b.name, kind: b.kind, latitude: b.latitude, longitude: b.longitude },
      distance_m: route.distance,
      duration_s: route.duration,
      geometry: route.geometry, // GeoJSON LineString
      google_maps_url: `https://www.google.com/maps/dir/?api=1&origin=${a.latitude},${a.longitude}&destination=${b.latitude},${b.longitude}`,
    })
  } catch (e) {
    console.error('Directions error:', e)
    res.status(500).json({ error: e.message })
  }
})


// Essential service categories for the sidebar
app.get('/api/essential-categories', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT slug, label FROM essential_categories ORDER BY sort_order'
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Listings for one essential category slug
app.get('/api/essentials/:slug', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT l.id, l.name, l.description, l.phones, l.email, l.website,
              l.address, l.location_area, l.latitude, l.longitude,
              l.has_location, l.hours
       FROM essential_listings l
       JOIN essential_listing_categories lc ON lc.listing_id = l.id
       JOIN essential_categories c ON c.id = lc.category_id
       WHERE c.slug = $1 AND l.is_active = true
       ORDER BY l.name`,
      [req.params.slug]
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

const PORT = process.env.PORT || 3001
app.listen(PORT, '0.0.0.0', () =>
  console.log(`API listening on http://0.0.0.0:${PORT} (reachable on your network IP too)`),
)