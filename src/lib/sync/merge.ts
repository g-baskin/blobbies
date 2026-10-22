/** Deterministic 3-way JSON merge for synced slices. */

type Obj = Record<string, unknown>;
type Keyed = Obj & { id: string };

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Stable JSON with sorted keys; equality and hashing go through this. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObj(v)) {
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

const eq = (a: unknown, b: unknown) => canonical(a) === canonical(b);

const isKeyedList = (v: unknown): v is Keyed[] =>
  Array.isArray(v) && v.every((x) => isObj(x) && typeof x.id === "string");

export function merge3(
  base: unknown,
  local: unknown,
  remote: unknown,
  preferLocal: boolean,
): unknown {
  if (eq(local, remote)) return local;
  const firstSync = base === null || base === undefined;
  if (!firstSync && eq(base, local)) return remote;
  if (!firstSync && eq(base, remote)) return local;
  // Changed on both sides (or first sync with differing values).
  if (isKeyedList(local) && isKeyedList(remote) && (firstSync || isKeyedList(base))) {
    return mergeKeyed(firstSync ? null : (base as Keyed[]), local, remote, preferLocal);
  }
  if (isObj(local) && isObj(remote) && (firstSync || isObj(base))) {
    const b = firstSync ? null : (base as Obj);
    const out: Obj = {};
    const keys = new Set([...Object.keys(remote), ...Object.keys(local)]);
    for (const k of [...keys].sort()) {
      const inL = k in local;
      const inR = k in remote;
      const bv = b && k in b ? b[k] : undefined;
      if (inL && inR) out[k] = merge3(b ? (bv ?? null) : null, local[k], remote[k], preferLocal);
      else if (inL) {
        // Remote removed it: keep only if local changed it (or first sync).
        if (!b || !(k in b) || !eq(bv, local[k])) out[k] = local[k];
      } else if (!b || !(k in b) || !eq(bv, remote[k])) out[k] = remote[k];
    }
    return out;
  }
  return preferLocal ? local : remote;
}

function mergeKeyed(
  base: Keyed[] | null,
  local: Keyed[],
  remote: Keyed[],
  preferLocal: boolean,
): Keyed[] {
  const B = new Map((base ?? []).map((x) => [x.id, x]));
  const L = new Map(local.map((x) => [x.id, x]));
  const R = new Map(remote.map((x) => [x.id, x]));
  const order = [...remote.map((x) => x.id), ...local.map((x) => x.id).filter((id) => !R.has(id))];
  const out: Keyed[] = [];
  for (const id of order) {
    const b = B.get(id);
    const l = L.get(id);
    const r = R.get(id);
    if (l && r) {
      out.push(merge3(b ?? null, l, r, preferLocal) as Keyed);
    } else if (l) {
      // Missing remotely: new locally, or deleted remotely (drop unless local edited it).
      if (!b || !eq(b, l)) out.push(l);
    } else if (r) {
      if (!b || !eq(b, r)) out.push(r);
    }
  }
  if (out.every((x) => typeof x.createdAt === "number")) {
    out.sort(
      (a, b) =>
        (a.createdAt as number) - (b.createdAt as number) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }
  return out;
}
