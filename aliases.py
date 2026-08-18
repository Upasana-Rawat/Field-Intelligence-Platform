"""
aliases.py — merging records that name the same real-world place differently.

Reps wrote what they saw. "Orion Tech Park - Tower A" and "Orion Tech Park" could refer to the same site. Left
unmerged, the system can surface candidate duplicates without silently merging them.

CONFIRMED merges are stated by the team. CANDIDATE merges are ones the data
suggests but nobody has verified — they are listed, not applied, because a
wrong merge silently destroys information and is harder to notice than a
missed one.
"""

# Verified by the team. Left side is absorbed into right side.
CONFIRMED = {}

CANDIDATES = [
    ("Vertex Business Park", "Vertex Business Centre",
     "Synthetic demo candidate for testing duplicate-review workflows."),
    ("UrbanHive Workspace", "UrbanHive Workspace - Tower B",
     "Synthetic demo candidate for testing duplicate-review workflows."),
]


def apply_confirmed(con):
    """Apply only explicitly confirmed demo merges."""
    merged = []
    for src_name, dst_name in CONFIRMED.items():
        src = con.execute("SELECT property_id FROM properties WHERE property_name=?", (src_name,)).fetchone()
        dst = con.execute("SELECT property_id FROM properties WHERE property_name=?", (dst_name,)).fetchone()
        if not src or not dst or src["property_id"] == dst["property_id"]:
            continue
        n = con.execute("SELECT COUNT(*) c FROM visits WHERE property_id=?", (src["property_id"],)).fetchone()["c"]
        con.execute("UPDATE visits SET property_id=? WHERE property_id=?", (dst["property_id"], src["property_id"]))
        con.execute("DELETE FROM properties WHERE property_id=?", (src["property_id"],))
        merged.append({"from": src_name, "into": dst_name, "visits_moved": n})
    con.commit()
    return merged


def pending_candidates(con):
    """Return candidate duplicates only when both demo names exist."""
    out = []
    for a, b, why in CANDIDATES:
        ra = con.execute("SELECT property_id, latitude, longitude FROM properties WHERE property_name=?", (a,)).fetchone()
        rb = con.execute("SELECT property_id, latitude, longitude FROM properties WHERE property_name=?", (b,)).fetchone()
        if ra and rb:
            out.append({"a": a, "b": b, "why": why})
    return out
