import { useEffect, useState } from 'react';

// Valeur retardée : n'évolue qu'après `ms` sans changement (frappe).
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
