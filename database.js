import { Pool } from 'pg';

const schema = `
  CREATE TABLE IF NOT EXISTS borcelle_bookings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    phone text NOT NULL,
    guests text NOT NULL,
    date date NOT NULL,
    time time NOT NULL,
    note text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'done')),
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS borcelle_admin_login_attempts (
    ip_hash text PRIMARY KEY,
    attempt_count integer NOT NULL DEFAULT 0,
    window_started_at timestamptz NOT NULL DEFAULT now()
  );
`;

let pool;
let schemaPromise;

function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not configured.');
  }

  pool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
  });
  return pool;
}

export async function ensureDatabase() {
  if (!schemaPromise) {
    schemaPromise = getPool().query(schema).catch((error) => {
      schemaPromise = undefined;
      throw error;
    });
  }
  await schemaPromise;
}

async function query(text, values) {
  await ensureDatabase();
  return getPool().query(text, values);
}

export async function insertBooking(booking) {
  const { rows } = await query(
    `INSERT INTO borcelle_bookings (name, phone, guests, date, time, note)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [booking.name, booking.phone, booking.guests, booking.date, booking.time, booking.note]
  );
  return rows[0];
}

export async function listBookings() {
  const { rows } = await query('SELECT * FROM borcelle_bookings ORDER BY created_at DESC');
  return rows;
}

export async function toggleBookingStatus(id) {
  const { rows } = await query(
    `UPDATE borcelle_bookings
     SET status = CASE WHEN status = 'done' THEN 'new' ELSE 'done' END
     WHERE id = $1
     RETURNING *`,
    [id]
  );
  return rows[0] || null;
}

export async function registerAdminLoginAttempt(ipHash) {
  const { rows } = await query(
    `INSERT INTO borcelle_admin_login_attempts (ip_hash, attempt_count)
     VALUES ($1, 1)
     ON CONFLICT (ip_hash) DO UPDATE
     SET attempt_count = CASE
           WHEN borcelle_admin_login_attempts.window_started_at <= now() - interval '15 minutes' THEN 1
           ELSE borcelle_admin_login_attempts.attempt_count + 1
         END,
         window_started_at = CASE
           WHEN borcelle_admin_login_attempts.window_started_at <= now() - interval '15 minutes' THEN now()
           ELSE borcelle_admin_login_attempts.window_started_at
         END
     RETURNING attempt_count`,
    [ipHash]
  );
  return rows[0].attempt_count;
}

export async function clearAdminLoginAttempts(ipHash) {
  await query('DELETE FROM borcelle_admin_login_attempts WHERE ip_hash = $1', [ipHash]);
}

export function mapBooking(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    guests: row.guests,
    date: row.date,
    time: row.time.slice(0, 5),
    note: row.note,
    status: row.status,
    createdAt: row.created_at
  };
}
