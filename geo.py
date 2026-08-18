"""
geo.py — search for a place by name and get coordinates back.

Uses Photon, which serves OpenStreetMap data. Free, no API key, and unlike
Nominatim it does not block requests from cloud hosts — which matters
because this runs on Streamlit Cloud.

Results are biased toward Bengaluru and filtered to a bounding box, so
searching a common place name returns Bengaluru buildings rather than an unrelated place in
another state.
"""

import requests

PHOTON = "https://photon.komoot.io/api/"
CENTRE = (12.9716, 77.5946)
LAT_MIN, LAT_MAX = 12.70, 13.30
LON_MIN, LON_MAX = 77.35, 77.95

HEADERS = {"User-Agent": "field-intel/1.0"}


def in_box(lat, lon):
    return LAT_MIN <= lat <= LAT_MAX and LON_MIN <= lon <= LON_MAX


def label(props):
    """Readable one-line name from Photon's property bag."""
    bits = [props.get("name")]
    for k in ("street", "district", "suburb", "city"):
        v = props.get(k)
        if v and v not in bits:
            bits.append(v)
        if len(bits) >= 3:
            break
    return ", ".join(b for b in bits if b)


def search(query, limit=6, timeout=15):
    """Place name -> list of {label, lat, lon}. Empty list on any failure:
    search is a convenience, and it should never take the app down."""
    if not query or len(query.strip()) < 3:
        return []
    try:
        r = requests.get(PHOTON, headers=HEADERS, timeout=timeout, params={
            "q": f"{query} Bangalore", "limit": limit * 3,
            "lat": CENTRE[0], "lon": CENTRE[1]})
        if r.status_code != 200:
            return []
        out, seen = [], set()
        for f in r.json().get("features", []):
            lon, lat = f["geometry"]["coordinates"]
            if not in_box(lat, lon):
                continue
            name = label(f.get("properties", {}))
            if not name or name in seen:
                continue
            seen.add(name)
            out.append({"label": name, "lat": lat, "lon": lon})
            if len(out) >= limit:
                break
        return out
    except Exception:
        return []
