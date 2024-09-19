/**
 * Given an object where the keys are the flattened path to a
 * preference, and the value is the value to set at that path, return
 * an object where the paths are fully expanded.
 */
export default function expandPrefs(prefs) {
  const prefsMap = new Map();
  for (const [key, value] of Object.entries(prefs)) {
    let submap = prefsMap;
    const props = key.split('.');
    const lastProp = props.pop();
    for (const prop of props) {
      if (!submap.has(prop)) {
        submap.set(prop, new Map());
      }
      submap = submap.get(prop);
      if (!(submap instanceof Map)) {
        throw new Error(
          `Cannot set ${key} because a value already exists at ${prop}`,
        );
      }
    }
    submap.set(lastProp, value);
  }
  return mapToObject(prefsMap);
}

function mapToObject(map) {
  return Object.fromEntries(
    Array.from(map, ([k, v]) => [k, v instanceof Map ? mapToObject(v) : v]),
  );
}
