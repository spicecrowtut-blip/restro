import { Pool } from 'pg';
import { defaultDishes } from './menu.js';

const schema = `
  CREATE TABLE IF NOT EXISTS borcelle_menu (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    access_code integer UNIQUE,
    name text NOT NULL,
    category text NOT NULL CHECK (category IN ('starter', 'main', 'dessert', 'drink')),
    price numeric(10, 2) NOT NULL CHECK (price >= 0),
    description text NOT NULL DEFAULT '',
    image text NOT NULL,
    available boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
  );

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

  CREATE TABLE IF NOT EXISTS borcelle_app_settings (
    setting_key text PRIMARY KEY,
    setting_value text NOT NULL
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
    schemaPromise = initializeDatabase().catch((error) => {
      schemaPromise = undefined;
      throw error;
    });
  }
  await schemaPromise;
}

async function initializeDatabase() {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(schema);
    const { rows } = await client.query(
      `INSERT INTO borcelle_app_settings (setting_key, setting_value)
       VALUES ('menu_seeded', 'true')
       ON CONFLICT (setting_key) DO NOTHING
       RETURNING setting_key`
    );
    if (rows.length > 0) {
      for (const dish of defaultDishes) {
        await client.query(
          `INSERT INTO borcelle_menu (name, category, price, description, image)
           VALUES ($1, $2, $3, $4, $5)`,
          [dish.name, dish.category, dish.price, dish.description, dish.image]
        );
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function query(text, values) {
  await ensureDatabase();
  return getPool().query(text, values);
}

export async function listMenu({ includeUnavailable = false } = {}) {
  const { rows } = await query(
    `SELECT * FROM borcelle_menu
     ${includeUnavailable ? '' : 'WHERE available = true'}
     ORDER BY created_at, name`
  );
  return rows.map(mapDish);
}

export async function insertDish(dish) {
  const { rows } = await query(
    `INSERT INTO borcelle_menu (name, category, price, description, image)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [dish.name, dish.category, dish.price, dish.description, dish.image]
  );
  return mapDish(rows[0]);
}

export async function updateDish(id, dish) {
  const { rows } = await query(
    `UPDATE borcelle_menu
     SET name = $2, category = $3, price = $4, description = $5, image = $6
     WHERE id = $1
     RETURNING *`,
    [id, dish.name, dish.category, dish.price, dish.description, dish.image]
  );
  return rows[0] ? mapDish(rows[0]) : null;
}

export async function setDishAvailability(id, available) {
  const { rows } = await query(
    `UPDATE borcelle_menu SET available = $2 WHERE id = $1 RETURNING *`,
    [id, available]
  );
  return rows[0] ? mapDish(rows[0]) : null;
}

export async function deleteDish(id) {
  const { rowCount } = await query('DELETE FROM borcelle_menu WHERE id = $1', [id]);
  return rowCount > 0;
}

export async function importAccessDishes(dishes) {
  await ensureDatabase();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    for (const dish of dishes) {
      await client.query(
        `INSERT INTO borcelle_menu (access_code, name, category, price, description, image)
         VALUES ($1, $2, 'main', $3, 'Блюдо из меню ресторана.', $4)
         ON CONFLICT (access_code) DO UPDATE
         SET name = EXCLUDED.name, price = EXCLUDED.price`,
        [
          dish.code,
          dish.name,
          dish.price,
          'https://images.unsplash.com/photo-1544025162-d76694265947?auto=format&fit=crop&w=900&q=80'
        ]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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

export function mapDish(row) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    price: Number(row.price),
    description: row.description,
    image: row.image,
    available: row.available
  };
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
