import pgPromise from "pg-promise";
import { createSingleton } from "./create-singleton";

const pgp = pgPromise();

interface IDatabaseScope {
  db: pgPromise.IDatabase<any>;
  pgp: pgPromise.IMain;
}

const NON_PRODUCTION_ENVS = ["local"];
const NON_PRODUCTION_POOL_SIZE = 20;
const PRODUCTION_POOL_SIZE = 80;

export function getDB(): IDatabaseScope {
  const connectionOptions = {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    poolSize: NON_PRODUCTION_ENVS.includes(process.env.APP_ENV || "local")
      ? NON_PRODUCTION_POOL_SIZE
      : PRODUCTION_POOL_SIZE,
    ssl: true,
  };

  return createSingleton<IDatabaseScope>("my-app-db-space", () => {
    return {
      db: pgp(connectionOptions),
      pgp,
    };
  });
}
