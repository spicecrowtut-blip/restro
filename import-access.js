import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { ensureDatabase, importAccessDishes } from './database.js';

const inputPath = process.argv[2];
if (!inputPath) {
  throw new Error('Pass the exported Access JSON file path as the first argument.');
}

if (!process.env.DATABASE_URL) {
  throw new Error('Set DATABASE_URL to the PostgreSQL database before importing.');
}

const records = JSON.parse(await readFile(inputPath, 'utf8'));
if (!Array.isArray(records)) {
  throw new Error('The Access export must contain a JSON array.');
}

const importedDishes = records.map((record, index) => {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`Access row ${index + 1} is not a record.`);
  }
  const code = record.accessCode;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  const price = record.price;

  if (!Number.isInteger(code)) throw new Error(`Access row ${index + 1} has an invalid Код value.`);
  if (!name || name.length > 70) throw new Error(`Access row ${index + 1} has an invalid Поле1 value.`);
  if (typeof price !== 'number' || !Number.isFinite(price) || price < 0 || price > 100000000) {
    throw new Error(`Access row ${index + 1} has an invalid Поле2 value.`);
  }

  return { code, name, price };
});

await ensureDatabase();
await importAccessDishes(importedDishes);
console.log(`Imported ${importedDishes.length} Access menu ${importedDishes.length === 1 ? 'item' : 'items'} into PostgreSQL.`);
