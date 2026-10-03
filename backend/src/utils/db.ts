import { Pool } from 'pg';
import config from '../config';

export const pool = new Pool({
  host: config.dbHost,
  port: config.dbPort,
  user: config.dbUser,
  password: config.dbPassword,
  database: config.dbName,
  ssl: config.dbSsl ? { rejectUnauthorized: false } : false, // TLS required for AWS RDS, off for local PostgreSQL
  max: 20,                // max connections in pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});
