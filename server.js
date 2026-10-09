import 'dotenv/config';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clearAdminLoginAttempts,
  ensureDatabase,
  insertBooking,
  listBookings,
  mapBooking,
  registerAdminLoginAttempt,
  toggleBookingStatus
} from './database.js';

const root = dirname(fileURLToPath(import.meta.url));
const dataDirectory = join(root, 'data');
const bookingsPath = join(dataDirectory, 'bookings.json');
const usesDatabase = Boolean(process.env.DATABASE_URL);
const enforceLoginRateLimit = process.env.NODE_ENV === 'production';
const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 5173);
const adminLogin = process.env.BORCELLE_ADMIN_LOGIN || 'Adminchik';
const adminPassword = process.env.BORCELLE_ADMIN_PASSWORD || '';
const rateLimitSecret = process.env.BORCELLE_SESSION_SECRET || adminPassword;
const sessionLifetime = 8 * 60 * 60 * 1000;
const maxBodyBytes = 16 * 1024;
const sessions = new Map();
const loginAttempts = new Map();
let bookings = [];
let writes = Promise.resolve();

function sendJson(response, status, data, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  response.end(JSON.stringify(data));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > maxBodyBytes) {
        reject(new Error('Request body is too large'));
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    request.on('error', reject);
  });
}

function saveBookings() {
  const snapshot = JSON.stringify(bookings, null, 2);
  writes = writes.then(() => writeFile(bookingsPath, snapshot, 'utf8'));
  return writes;
}

function safeEquals(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function getSession(request) {
  const cookie = request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith('borcelle_admin='));
  const token = cookie?.slice('borcelle_admin='.length);
  const session = token && sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  return token;
}

function readBooking(payload) {
  const name = typeof payload.name === 'string' ? payload.name.trim() : '';
  const phone = typeof payload.phone === 'string' ? payload.phone.trim() : '';
  const guests = typeof payload.guests === 'string' ? payload.guests.trim() : '';
  const date = typeof payload.date === 'string' ? payload.date : '';
  const time = typeof payload.time === 'string' ? payload.time : '';
  const note = typeof payload.note === 'string' ? payload.note.trim() : '';
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`));
  const validTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time);

  if (name.length < 2 || name.length > 70) throw new Error('Укажите имя длиной от 2 до 70 символов.');
  if (phone.length < 7 || phone.length > 30) throw new Error('Укажите корректный номер телефона.');
  if (!['1 гость', '2 гостя', '3 гостя', '4 гостя', '5 гостей', '6 гостей', '7 и более'].includes(guests)) throw new Error('Выберите количество гостей.');
  if (!validDate || !validTime) throw new Error('Укажите корректные дату и время.');
  if (note.length > 500) throw new Error('Пожелание должно быть короче 500 символов.');

  return {
    id: randomUUID(),
    name,
    phone,
    guests,
    date,
    time,
    note,
    status: 'new',
    createdAt: new Date().toISOString()
  };
}

async function handleApi(request, response, url) {
  if (request.method === 'POST' && url.pathname === '/api/bookings') {
    let booking;
    try {
      booking = readBooking(await readJson(request));
    } catch (error) {
      if (!response.destroyed) sendJson(response, error.message === 'Request body is too large' ? 413 : 400, { error: error.message });
      return;
    }

    if (usesDatabase) {
      const savedBooking = await insertBooking(booking);
      sendJson(response, 201, { ok: true, id: savedBooking.id });
    } else {
      bookings.unshift(booking);
      await saveBookings();
      sendJson(response, 201, { ok: true, id: booking.id });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/login') {
    const address = request.headers['x-forwarded-for']?.split(',')[0].trim()
      || request.socket.remoteAddress
      || 'unknown';
    const ipHash = createHmac('sha256', rateLimitSecret).update(address).digest('hex');
    let attempt;
    if (enforceLoginRateLimit) {
      if (usesDatabase) {
        if (await registerAdminLoginAttempt(ipHash) > 5) {
          sendJson(response, 429, { error: 'Слишком много попыток. Попробуйте позже.' });
          return;
        }
      } else {
        attempt = loginAttempts.get(address) || { count: 0, until: 0 };
        if (attempt.until > Date.now() && attempt.count >= 5) {
          sendJson(response, 429, { error: 'Слишком много попыток. Попробуйте позже.' });
          return;
        }
      }
    }

    let payload;
    try {
      payload = await readJson(request);
    } catch (error) {
      sendJson(response, 400, { error: error.message });
      return;
    }

    const loginMatches = safeEquals(String(payload.login || ''), adminLogin);
    const passwordMatches = safeEquals(String(payload.password || ''), adminPassword);
    if (!loginMatches || !passwordMatches) {
      if (enforceLoginRateLimit && !usesDatabase) {
        const nextAttempt = attempt.until > Date.now()
          ? attempt
          : { count: 0, until: Date.now() + 15 * 60 * 1000 };
        nextAttempt.count += 1;
        loginAttempts.set(address, nextAttempt);
      }
      sendJson(response, 401, { error: 'Неверный логин или пароль.' });
      return;
    }

    if (enforceLoginRateLimit && !usesDatabase) loginAttempts.delete(address);
    if (enforceLoginRateLimit && usesDatabase) {
      await clearAdminLoginAttempts(ipHash);
    }
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, { expiresAt: Date.now() + sessionLifetime });
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    sendJson(response, 200, { ok: true }, {
      'Set-Cookie': `borcelle_admin=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionLifetime / 1000}${secure}`
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/logout') {
    const token = getSession(request);
    if (token) sessions.delete(token);
    sendJson(response, 200, { ok: true }, { 'Set-Cookie': 'borcelle_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/admin/session') {
    sendJson(response, 200, { authenticated: Boolean(getSession(request)) });
    return;
  }

  if (url.pathname.startsWith('/api/admin/')) {
    if (!getSession(request)) {
      sendJson(response, 401, { error: 'Необходим вход в админ-панель.' });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/admin/bookings') {
      const allBookings = usesDatabase
        ? (await listBookings()).map(mapBooking)
        : bookings;
      sendJson(response, 200, { bookings: allBookings });
      return;
    }

    const statusMatch = url.pathname.match(/^\/api\/admin\/bookings\/([\w-]+)\/status$/);
    if (request.method === 'PATCH' && statusMatch) {
      if (process.env.NODE_ENV === 'production' && (
        !process.env.BORCELLE_ADMIN_LOGIN
        || !process.env.BORCELLE_ADMIN_PASSWORD
        || !process.env.BORCELLE_SESSION_SECRET
        || process.env.BORCELLE_SESSION_SECRET.length < 32
      )) {
        throw new Error('Set BORCELLE_ADMIN_LOGIN, BORCELLE_ADMIN_PASSWORD, and a BORCELLE_SESSION_SECRET of at least 32 characters in production.');
      }

      if (!adminPassword) {
        throw new Error('Set BORCELLE_ADMIN_PASSWORD in the environment or local .env file.');
      }

      if (usesDatabase) {
        const updated = await toggleBookingStatus(statusMatch[1]);
        if (!updated) {
          sendJson(response, 404, { error: 'Заявка не найдена.' });
          return;
        }
        sendJson(response, 200, { booking: mapBooking(updated) });
        return;
      }
      const booking = bookings.find((item) => item.id === statusMatch[1]);
      if (!booking) {
        sendJson(response, 404, { error: 'Заявка не найдена.' });
        return;
      }
      booking.status = booking.status === 'done' ? 'new' : 'done';
      try {
        await saveBookings();
        sendJson(response, 200, { booking });
      } catch {
        sendJson(response, 500, { error: 'Не удалось сохранить статус заявки.' });
      }
      return;
    }
  }

  sendJson(response, 404, { error: 'Маршрут не найден.' });
}

const server = createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'same-origin');
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  if (url.pathname.startsWith('/api/')) {
    try {
      await handleApi(request, response, url);
    } catch (error) {
      console.error('API request failed:', error);
      if (!response.headersSent) sendJson(response, 503, { error: 'Не удалось выполнить запрос к серверу.' });
      else response.destroy();
    }
    return;
  }

  if (request.method !== 'GET' || (url.pathname !== '/' && url.pathname !== '/index.html')) {
    sendJson(response, 404, { error: 'Страница не найдена.' });
    return;
  }

  const pagePath = process.env.NODE_ENV === 'production' ? join(root, 'dist', 'index.html') : join(root, 'index.html');
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  createReadStream(pagePath).pipe(response);
});

if (usesDatabase) {
  await ensureDatabase();
} else {
  await mkdir(dataDirectory, { recursive: true });
  try {
    bookings = JSON.parse(await readFile(bookingsPath, 'utf8'));
    if (!Array.isArray(bookings)) bookings = [];
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeFile(bookingsPath, '[]\n', 'utf8');
  }
}

server.listen(port, host, () => {
  const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  console.log(`Borcelle is running at http://${displayHost}:${port}`);
});
