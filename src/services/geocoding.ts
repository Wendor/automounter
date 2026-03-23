import { NOMINATIM_URL, NOMINATIM_USER_AGENT, NOMINATIM_RATE_LIMIT_MS } from "../constants";

export interface GeocodedLocation {
  name: string;
  lat: number;
  lon: number;
}

// Внутренний кэш адресов для reverseGeocode
const addressCache = new Map<string, string>();

/**
 * Прямой геокодинг топонимов через Nominatim (OpenStreetMap).
 * Rate limit применяется только при реальном HTTP-запросе.
 * Перенесено из director.ts.
 */
export async function geocodeLocationNames(names: string[]): Promise<GeocodedLocation[]> {
  const results: GeocodedLocation[] = [];
  for (const name of names) {
    try {
      const url = `${NOMINATIM_URL}/search?q=${encodeURIComponent(name)}&format=json&limit=1&accept-language=ru,en`;
      const res = await fetch(url, {
        headers: { "User-Agent": NOMINATIM_USER_AGENT },
      });
      if (res.ok) {
        const data: any[] = await res.json();
        if (data[0]) {
          results.push({
            name,
            lat: parseFloat(data[0].lat),
            lon: parseFloat(data[0].lon),
          });
        }
      }
    } catch {}
    // Nominatim policy: не более 1 запроса в секунду
    if (names.length > 1) await new Promise((r) => setTimeout(r, NOMINATIM_RATE_LIMIT_MS));
  }
  return results;
}

/**
 * Обратный геокодинг координат через Nominatim.
 * Rate limit применяется только при реальном HTTP-запросе (не при попадании в кэш).
 * Перенесено из indexer.ts (fetchAddress + кэш).
 */
export async function reverseGeocode(lat: number, lon: number): Promise<string | null> {
  const cacheKey = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const cached = addressCache.get(cacheKey);
  if (cached !== undefined) return cached;

  // Rate limit только при реальном запросе
  await new Promise((r) => setTimeout(r, NOMINATIM_RATE_LIMIT_MS));

  try {
    const url = `${NOMINATIM_URL}/reverse?format=json&lat=${lat}&lon=${lon}&zoom=10&addressdetails=1`;
    const res = await fetch(url, {
      headers: { "User-Agent": NOMINATIM_USER_AGENT },
    });
    if (res.ok) {
      const data: any = await res.json();
      const a = data.address;
      const city = a.city || a.town || a.village || a.suburb || a.county || "";
      const country = a.country || "";
      const address = city && country
        ? `${city}, ${country}`
        : country || city || "";
      const result = address || null;
      if (result) addressCache.set(cacheKey, result);
      return result;
    }
  } catch {}
  return null;
}
