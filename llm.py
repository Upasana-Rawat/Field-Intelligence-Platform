"""
llm.py — pick a Gemini model this key can use, and call it resiliently.

Two failure modes made this necessary in practice:

  404  the hardcoded model was retired. Fixed by asking the API what exists
       instead of naming a model in the source.
  503  the chosen model was overloaded. Newly released models attract heavy
       traffic and return UNAVAILABLE under load. Fixed by retrying with
       backoff, then falling back to the next model on the list.

Neither is exotic. Any app calling a hosted model will meet both.
"""

import functools
import os
import random
import time

import requests

BASE = "https://generativelanguage.googleapis.com/v1beta"

# Tried in order. Newest Flash first: fast, cheap, supports audio input and
# function calling, and the free tier is workable. Pro models are avoided —
# slower, and their free daily limits are far lower.
PREFERRED = [
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-flash-latest",
]

RETRY_STATUS = {429, 500, 502, 503, 504}
MAX_RETRIES = 3


def api_key(explicit=None):
    if explicit:
        return explicit
    k = os.environ.get("GEMINI_API_KEY", "")
    if not k:
        try:
            import streamlit as st
            k = st.secrets.get("GEMINI_API_KEY", "")
        except Exception:
            pass
    return k


def list_models(key=None):
    """Every model this key can call generateContent on."""
    k = api_key(key)
    if not k:
        raise RuntimeError("No GEMINI_API_KEY set.")
    out, token = [], None
    for _ in range(5):
        params = {"key": k, "pageSize": 200}
        if token:
            params["pageToken"] = token
        r = requests.get(f"{BASE}/models", params=params, timeout=30)
        if r.status_code != 200:
            raise RuntimeError(f"ListModels {r.status_code}: {r.text[:300]}")
        j = r.json()
        for m in j.get("models", []):
            if "generateContent" in m.get("supportedGenerationMethods", []):
                out.append(m["name"].replace("models/", ""))
        token = j.get("nextPageToken")
        if not token:
            break
    return out


@functools.lru_cache(maxsize=4)
def candidates(key=None):
    """Usable models, best first. More than one, so we can fall back."""
    available = set(list_models(key))
    ordered = [m for m in PREFERRED if m in available]
    extras = sorted(
        m for m in available
        if "flash" in m and m not in ordered
        and not any(x in m for x in ("tts", "image", "embedding", "thinking",
                                     "live", "native-audio", "robotics")))
    return ordered + extras[::-1]


def resolve(key=None):
    """The model we would use first. Kept for display purposes."""
    c = candidates(key)
    if not c:
        raise RuntimeError("This API key has access to no usable models.")
    return c[0]


def url(model):
    return f"{BASE}/models/{model}:generateContent"


def generate(body, key=None, timeout=60, on_event=None):
    """POST to generateContent with retry and model fallback.

    Returns (json_response, model_used). Raises only when every model has
    been tried and none succeeded.
    """
    k = api_key(key)
    models = candidates(k)
    if not models:
        raise RuntimeError("No usable Gemini models for this key.")

    last = ""
    for model in models:
        for attempt in range(MAX_RETRIES):
            r = requests.post(url(model), params={"key": k},
                              json=body, timeout=timeout)

            if r.status_code == 200:
                return r.json(), model

            # Older models reject thinkingConfig; drop it and retry once.
            if r.status_code == 400 and "thinking" in r.text.lower():
                if body.get("generationConfig", {}).pop("thinkingConfig", None):
                    continue

            last = f"{r.status_code} on {model}: {r.text[:200]}"

            if r.status_code in RETRY_STATUS and attempt < MAX_RETRIES - 1:
                wait = (2 ** attempt) + random.random()
                if on_event:
                    on_event(f"{model} busy, retrying in {wait:.0f}s…")
                time.sleep(wait)
                continue
            break  # not retryable, or out of attempts: try the next model

        if on_event and model != models[-1]:
            on_event(f"{model} unavailable, switching model…")

    raise RuntimeError(f"All models failed. Last error: {last}")


if __name__ == "__main__":
    print("candidates:", candidates())
    print("first choice:", resolve())
