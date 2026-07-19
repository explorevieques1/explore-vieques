// Loads .env before anything else imports it.
// Imported first in server.js so process.env is populated before
// payments.js (or any other module) reads it at import time.
import dotenv from 'dotenv'
dotenv.config()