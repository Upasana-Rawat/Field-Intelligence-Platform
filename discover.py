"""External place discovery.

Primary provider: Google Places API (New), when GOOGLE_MAPS_API_KEY is set.
Fallback provider: OpenStreetMap/Overpass.

The app normalizes both providers into the same place shape so the frontend
never needs to know which provider answered a request.
"""
import math
import os
import time
from difflib import SequenceMatcher

import pandas as pd
import requests

GOOGLE_KEY = os.environ.get("GOOGLE_MAPS_API_KEY", "").strip()
GOOGLE_NEARBY = "https://places.googleapis.com/v1/places:searchNearby"
GOOGLE_TEXT = "https://places.googleapis.com/v1/places:searchText"
GOOGLE_DETAILS = "https://places.googleapis.com/v1/places/{}"
OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
BBOX = (12.78, 77.40, 13.20, 77.85)
HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "data", "discovered_places.csv")
HEADERS = {"User-Agent": "field-intelligence-v2/1.0"}

GOOGLE_TYPES = [
    "coworking_space",
    "business_center",
    "corporate_office",
    "office_space_rental_agency",
]


def _google_headers(fields):
    return {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_KEY,
        "X-Goog-FieldMask": fields,
    }


def _google_place(p):
    loc = p.get("location") or {}
    display = (p.get("displayName") or {}).get("text") or ""
    return {
        "external_id": p.get("id", ""),
        "name": display,
        "type": _classify_google(p),
        "lat": loc.get("latitude"),
        "lon": loc.get("longitude"),
        "address": p.get("shortFormattedAddress") or p.get("formattedAddress") or "",
        "primary_type": p.get("primaryType", ""),
        "primary_type_display": (p.get("primaryTypeDisplayName") or {}).get("text", ""),
        "rating": p.get("rating"),
        "rating_count": p.get("userRatingCount"),
        "phone": p.get("nationalPhoneNumber") or p.get("internationalPhoneNumber") or "",
        "website": p.get("websiteUri", ""),
        "google_maps_uri": p.get("googleMapsUri", ""),
        "source": "google",
    }


def _classify_google(p):
    types = set(p.get("types") or [])
    primary = p.get("primaryType", "")
    text = ((p.get("displayName") or {}).get("text") or "").lower()
    if "coworking_space" in types or "coworking" in text:
        return "coworking"
    if "business_center" in types or "business park" in text or "tech park" in text:
        return "business_park"
    if "corporate_office" in types or "office_space_rental_agency" in types:
        return "corporate_office"
    if "office" in primary or "office" in types:
        return "office_building"
    return "commercial"


def google_nearby(lat, lon, radius=1500, limit=20, categories=None):
    if not GOOGLE_KEY:
        return []
    types = categories or GOOGLE_TYPES
    out, seen = [], set()
    # Google Nearby Search accepts a list of included types. Keep one request
    # with a compact field mask to control latency and billing.
    body = {
        "includedTypes": types,
        "maxResultCount": min(max(int(limit), 1), 20),
        "rankPreference": "DISTANCE",
        "locationRestriction": {
            "circle": {
                "center": {"latitude": lat, "longitude": lon},
                "radius": float(min(max(radius, 1), 50000)),
            }
        },
    }
    fields = ",".join([
        "places.id", "places.displayName", "places.location",
        "places.shortFormattedAddress", "places.primaryType",
        "places.primaryTypeDisplayName", "places.types", "places.googleMapsUri",
    ])
    try:
        r = requests.post(GOOGLE_NEARBY, json=body,
                          headers=_google_headers(fields), timeout=20)
        if r.status_code != 200:
            return []
        for p in r.json().get("places", []):
            x = _google_place(p)
            if x["name"] and x["lat"] is not None and x["external_id"] not in seen:
                seen.add(x["external_id"])
                out.append(x)
    except Exception:
        return []
    return out


def google_text(query, lat=None, lon=None, limit=8):
    if not GOOGLE_KEY or not query.strip():
        return []
    body = {
        "textQuery": query.strip(),
        "languageCode": "en",
        "regionCode": "IN",
        "maxResultCount": min(max(int(limit), 1), 20),
    }
    if lat is not None and lon is not None:
        body["locationBias"] = {
            "circle": {"center": {"latitude": lat, "longitude": lon}, "radius": 5000}
        }
    fields = ",".join([
        "places.id", "places.displayName", "places.location",
        "places.shortFormattedAddress", "places.primaryType",
        "places.primaryTypeDisplayName", "places.types", "places.googleMapsUri",
    ])
    try:
        r = requests.post(GOOGLE_TEXT, json=body,
                          headers=_google_headers(fields), timeout=20)
        if r.status_code != 200:
            return []
        return [_google_place(p) for p in r.json().get("places", [])]
    except Exception:
        return []


def google_details(place_id):
    if not GOOGLE_KEY or not place_id:
        return None
    fields = ",".join([
        "id", "displayName", "location", "shortFormattedAddress",
        "formattedAddress", "primaryType", "primaryTypeDisplayName", "types",
        "googleMapsUri", "nationalPhoneNumber", "internationalPhoneNumber",
        "websiteUri", "rating", "userRatingCount",
    ])
    try:
        r = requests.get(GOOGLE_DETAILS.format(place_id),
                         headers=_google_headers(fields), timeout=15)
        if r.status_code != 200:
            return None
        return _google_place(r.json())
    except Exception:
        return None


def _bbox_query(bbox):
    b = ",".join(str(x) for x in bbox)
    return f"""
[out:json][timeout:60];
(
 node["office"="coworking"]({b}); way["office"="coworking"]({b});
 node["amenity"="coworking_space"]({b}); way["amenity"="coworking_space"]({b});
 node["office"="it"]({b}); way["office"="it"]({b});
 node["office"="company"]({b}); way["office"="company"]({b});
 way["landuse"="commercial"]["name"]({b});
 way["building"="commercial"]["name"]({b});
 way["building"="office"]["name"]({b});
 node["name"~"[Tt]ech [Pp]ark|[Tt]echpark|[Bb]usiness [Pp]ark|IT [Pp]ark"]({b});
 way["name"~"[Tt]ech [Pp]ark|[Tt]echpark|[Bb]usiness [Pp]ark|IT [Pp]ark"]({b});
); out center tags;
"""


def _osm_classify(tags):
    name = (tags.get("name") or "").lower()
    if tags.get("office") == "coworking" or tags.get("amenity") == "coworking_space":
        return "coworking"
    if any(k in name for k in ("tech park", "techpark", "it park")):
        return "tech_park"
    if "business park" in name or "business centre" in name:
        return "business_park"
    if tags.get("office") in ("it", "company"):
        return "corporate_office"
    if tags.get("building") == "office":
        return "office_building"
    return "commercial"


def osm_fetch(bbox=BBOX, timeout=90):
    q = _bbox_query(bbox)
    for url in OVERPASS:
        try:
            r = requests.post(url, data={"data": q}, headers=HEADERS, timeout=timeout)
            if r.status_code != 200:
                continue
            rows, seen = [], set()
            for el in r.json().get("elements", []):
                tags = el.get("tags") or {}
                name = (tags.get("name") or "").strip()
                if not name:
                    continue
                if el["type"] == "node":
                    lat, lon = el.get("lat"), el.get("lon")
                else:
                    c = el.get("center") or {}
                    lat, lon = c.get("lat"), c.get("lon")
                if lat is None or lon is None:
                    continue
                key = (name.lower(), round(lat, 4), round(lon, 4))
                if key in seen:
                    continue
                seen.add(key)
                rows.append({
                    "external_id": f"osm:{el['type']}/{el['id']}",
                    "name": name,
                    "type": _osm_classify(tags),
                    "lat": float(lat), "lon": float(lon),
                    "address": ", ".join(x for x in [tags.get("addr:housenumber"), tags.get("addr:street"), tags.get("addr:suburb")] if x),
                    "source": "osm",
                    "google_maps_uri": f"https://www.google.com/maps/search/?api=1&query={lat},{lon}",
                })
            return rows
        except Exception:
            time.sleep(1)
    return []


def load_discovered(allow_fetch=True):
    if os.path.exists(CACHE):
        try:
            return pd.read_csv(CACHE)
        except Exception:
            pass
    if not allow_fetch:
        return pd.DataFrame(columns=["external_id", "name", "type", "latitude", "longitude"])
    rows = osm_fetch()
    if rows:
        df = pd.DataFrame([{
            "osm_id": x["external_id"], "name": x["name"], "type": x["type"],
            "latitude": x["lat"], "longitude": x["lon"]} for x in rows])
        os.makedirs(os.path.dirname(CACHE), exist_ok=True)
        df.to_csv(CACHE, index=False)
        return df
    return pd.DataFrame(columns=["osm_id", "name", "type", "latitude", "longitude"])


def search_nearby(lat, lon, radius=1500, limit=50, categories=None):
    """Google first; OSM fallback. Results are normalized."""
    rows = google_nearby(lat, lon, radius, min(limit, 20), categories)
    provider = "google" if rows else "osm"
    if not rows:
        all_rows = osm_fetch((lat - radius / 111000, lon - radius / (111000 * max(math.cos(math.radians(lat)), .1)),
                              lat + radius / 111000, lon + radius / (111000 * max(math.cos(math.radians(lat)), .1))))
        rows = []
        for x in all_rows:
            d = haversine(lat, lon, x["lat"], x["lon"])
            if d <= radius:
                x["distance_m"] = round(d)
                rows.append(x)
        rows.sort(key=lambda x: x.get("distance_m", 10**9))
        rows = rows[:limit]
    else:
        for x in rows:
            x["distance_m"] = round(haversine(lat, lon, x["lat"], x["lon"]))
        rows.sort(key=lambda x: x["distance_m"])
    return rows, provider


def search_text(query, lat=None, lon=None, limit=10):
    rows = google_text(query, lat, lon, limit)
    if rows:
        for x in rows:
            if lat is not None and x.get("lat") is not None:
                x["distance_m"] = round(haversine(lat, lon, x["lat"], x["lon"]))
        return rows, "google"
    # Photon fallback is retained by geo.py; caller may use it separately.
    return [], "none"


def haversine(a, b, c, d):
    r = 6371000
    p1, p2 = math.radians(a), math.radians(c)
    dp, dl = math.radians(c - a), math.radians(d - b)
    x = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(x))
