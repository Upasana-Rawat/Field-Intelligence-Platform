"""
extract.py — layer 2: the fixed workflow.

Audio or text goes in, a structured visit record comes out. The path never
varies, so this is a workflow, not an agent — there are no decisions for a
model to make about the sequence.

The schema is enforced by the API (responseSchema), so the model cannot
return a malformed record. That constraint is where most of the reliability
in this system comes from.
"""

import base64, json, os, requests
import llm

# The five field categories, defined from what actually turned up on the
# ground during the internship rather than from a generic sales taxonomy.
OUTCOMES = [
    "SPACE_SHORTAGE",            # genuinely not enough parking capacity
    "DEMAND_CAPACITY_MISMATCH",  # capacity exists but not when/where needed
    "OPERATIONAL_INEFFICIENCY",  # parking exists, managed badly
    "COMPETITOR_LOCKED",         # another vendor already in place
    "NO_REQUIREMENT",            # satisfied, nothing to sell
    "FUTURE_OPPORTUNITY",        # nothing now, something later
    "FOLLOW_UP_PENDING",         # nobody available, no outcome yet
    "UNQUALIFIED",               # could not assess, usually access blocked
    "DECLINED",                  # they said no to a specific ask
    "ACTIVE_CLIENT",             # existing account, service review
    "ACCOUNT_AT_RISK",           # existing account showing warning signs
]

FOLLOW_UPS = [
    "none", "contact_shared", "contact_obtained", "revisit_needed",
    "proposal_requested", "quote_requested", "awaiting_callback",
    "email_follow_up", "appointment_needed", "revisit_head_office",
    "coordination_pending", "monitor",
]

SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "property_name":      {"type": "STRING",  "description": "Building, park or company visited, as spoken"},
        "outcome_category":   {"type": "STRING",  "enum": OUTCOMES},
        "access_blocked":     {"type": "BOOLEAN", "description": "True if security or a gatekeeper prevented reaching a decision-maker"},
        "requirement_detail": {"type": "STRING",  "description": "Concrete requirement with numbers if stated, else empty"},
        "competitor_vendor":  {"type": "STRING",  "description": "Incumbent parking or valet vendor if named, else empty"},
        "pricing_note":       {"type": "STRING",  "description": "Any price or fee mentioned, else empty"},
        "contact_role":       {"type": "STRING",  "description": "ROLE ONLY, never a person's name. e.g. Facility Manager"},
        "follow_up_state":    {"type": "STRING",  "enum": FOLLOW_UPS},
        "remarks":            {"type": "STRING",  "description": "One or two clean sentences summarising what happened"},
        "confidence":         {"type": "STRING",  "enum": ["high", "medium", "low"]},
    },
    "required": ["property_name", "outcome_category", "remarks", "confidence"],
}

SYSTEM = """You convert a field sales rep's spoken note into one structured visit record.

You are working for a parking-solutions company in Bengaluru. Reps visit tech
parks, co-working spaces, hospitals and corporate offices to find parking
problems worth solving.

Rules:
- Record only what the rep said. Never invent a requirement, vendor or number.
- Put the ROLE of any person mentioned, never their name. "Met Mr Sharma the
  facility manager" becomes contact_role "Facility Manager".
- Distinguish the outcome categories carefully. A site with plenty of parking
  that is chaotically run is OPERATIONAL_INEFFICIENCY, not NO_REQUIREMENT. A
  site whose parking is fine at 10am and overflowing at 6pm is
  DEMAND_CAPACITY_MISMATCH, not SPACE_SHORTAGE.
- If security stopped the rep reaching anyone, access_blocked is true and the
  outcome is UNQUALIFIED — you cannot know whether a requirement exists.
- Set confidence low if the note is vague or the property name is unclear."""


def _key():
    return llm.api_key()


def _call(parts, api_key=None, timeout=60):
    key = api_key or _key()
    if not key:
        raise RuntimeError("No GEMINI_API_KEY. Add it to the hosting platform environment variables.")
    body = {
        "systemInstruction": {"parts": [{"text": SYSTEM}]},
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": SCHEMA,
            "temperature": 0.1,
            "thinkingConfig": {"thinkingLevel": "minimal"},
        },
    }
    data, model = llm.generate(body, key, timeout)
    txt = data["candidates"][0]["content"]["parts"][0]["text"]
    return json.loads(txt)


def from_text(note, api_key=None):
    """Typed note -> structured record."""
    return _call([{"text": f"Field note:\n{note}"}], api_key)


def from_audio(audio_bytes, mime="audio/wav", api_key=None):
    """Voice note -> structured record. Gemini handles audio natively, so
    there is no separate transcription step to go wrong."""
    return _call([
        {"text": "Convert this spoken field note into a visit record."},
        {"inlineData": {"mimeType": mime,
                        "data": base64.b64encode(audio_bytes).decode()}},
    ], api_key)
