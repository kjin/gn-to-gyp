/**
 * For debugging purposes only. Given an array and a mapping function, map each
 * element in a function to a value, and return an object that contains the
 * frequency of each mapped value.
 * @param arr The array over which to map.
 * @param fn A mapping function.
 */
export function reportListStatistics<S>(arr: S[], fn: (arg: S) => any): { [k: string]: number } {
  const result: { [k: string]: number } = {};
  for (const arg of arr) {
    const key = `${fn(arg)}`;
    result[key] = (result[key] || 0) + 1;
  }
  return result;
}

/**
 * Array#reduce function that flattens an array of arrays.
 * @param acc The accumulator.
 * @param e An array whose elements should be added to the accumulator.
 */
export function flatten<T>(acc: T[], e: T[]) {
  acc.push(...e);
  return acc;
}

/**
 * Array#reduce function that removes duplicates in an array/
 * @param acc The accumulator.
 * @param e An element that should be added to the accumulator if it's not there
 *          already.
 */
export function removeDuplicates<T>(arr: T[], e: T) {
  if (arr.indexOf(e) === -1) {
    arr.push(e);
  }
  return arr;
}

/**
 * Returns whether two arrays are equal.
 * @param a The first array.
 * @param b The second array.
 */
export function arrayEquals<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Given an array of objects and a mapping function, and under the assumption
 * that every object yields the same value when the mapping function is applied,
 * return that value. If there is no such value, an error will be thrown.
 * @param arr The array over which to map.
 * @param fn The mapping function.
 */
export function getOnlyMappedValue<S, T>(arr: Array<S>, fn: (s: S) => T): T {
  const results: T[] = arr.map(x => fn(x)).reduce(removeDuplicates, [] as T[]);
  if (results.length !== 1) {
    throw new Error(`Array passed to getOnlyMappedValue has ${results.length} mapped values`);
  }
  return results[0];
}

/**
 * Convert a Map to a string.
 * @param map The map to convert.
 * @param serializeKey How to convert keys to strings.
 * @param serializeValue How to convert values to strings.
 */
export function serializeMap<S, T>(
  map: Map<S, T>,
  serializeKey: (k: S) => string,
  serializeValue: (v: T) => string
): string {
  const result: any = {};
  for (const key of Array.from(map.keys())) {
    result[serializeKey(key)] = JSON.parse(serializeValue(map.get(key)!));
  }
  return JSON.stringify(result, null, 2);
}

/**
 * Convert a string previously returned by serializeMap into a Map.
 * @param json The string to convert.
 * @param deserializeKey How to re-hydrate keys.
 * @param deserializeValue How to re-hydrate values.
 */
export function deserializeMap<S, T>(
  json: string,
  deserializeKey: (k: string) => S,
  deserializeValue: (v: string) => T
): Map<S, T> {
  const result = new Map<S, T>();
  const obj = JSON.parse(json);
  for (const key of Object.keys(obj)) {
    result.set(deserializeKey(key), deserializeValue(JSON.stringify(obj[key])));
  }
  return result;
}
