/**
 * Code taken from https://stackoverflow.com/questions/34382796/where-should-i-initialize-pg-promise
 * This could be used for any typed singleton, not just a database connection.
 **/
export function createSingleton<T>(name: string, create: () => T): T {
  const s = Symbol.for(name);
  let scope = (global as any)[s];
  if (!scope) {
    scope = { ...create() };
    (global as any)[s] = scope;
  }
  return scope;
}
