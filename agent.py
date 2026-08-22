"""
agent.py — layer 1: the agentic shell.

This is the only place a model gets to *decide* anything. It receives a
question in ordinary language, a set of tool declarations, and loops:

    model picks a tool -> our code runs it -> result goes back -> repeat

The sequence is chosen at runtime. Asking about a property with no history
takes a different path from one with three visits by two reps, and neither
path is hardcoded.

The model never touches the database. It emits a request to call a function;
this file decides whether to honour it. Every write goes through a human
confirmation in the UI, so the agent can propose a record but never commit one.
"""

import json, os, requests
import tools, llm

MAX_STEPS = 6

DECLARATIONS = [
    {
        "name": "find_property",
        "description": "Match a property name to known properties. Returns candidates with match scores. Several brands can have multiple branches, so if the top candidates score close together, ask the rep which branch they mean instead of guessing.",
        "parameters": {"type": "OBJECT", "properties": {
            "query": {"type": "STRING", "description": "Property name as the rep said it"}},
            "required": ["query"]},
    },
    {
        "name": "get_visit_history",
        "description": "All recorded visits to one property, by any rep, with outcomes, remarks, contacts obtained and any competitor vendor.",
        "parameters": {"type": "OBJECT", "properties": {
            "property_id": {"type": "INTEGER"}}, "required": ["property_id"]},
    },
    {
        "name": "check_rep_overlap",
        "description": "Whether a colleague has already worked this property, or visited anything within 300m. Use before a visit to avoid duplicate calls and to surface what a colleague already learned.",
        "parameters": {"type": "OBJECT", "properties": {
            "property_id": {"type": "INTEGER"},
            "rep": {"type": "STRING", "description": "The rep asking"}},
            "required": ["property_id", "rep"]},
    },
    {
        "name": "find_nearby",
        "description": "Properties within a radius of a point, nearest first. Use to plan what else is worth walking into while the rep is already in an area.",
        "parameters": {"type": "OBJECT", "properties": {
            "lat": {"type": "NUMBER"}, "lon": {"type": "NUMBER"},
            "radius_m": {"type": "INTEGER", "description": "Default 1000"}},
            "required": ["lat", "lon"]},
    },
    {
        "name": "get_open_followups",
        "description": "Visits that left a commitment with no recorded closure: proposals promised, revisits due, callbacks awaited.",
        "parameters": {"type": "OBJECT", "properties": {
            "rep": {"type": "STRING", "description": "Optional. Omit for the whole team."}}},
    },
    {
        "name": "find_cross_rep_gaps",
        "description": "Properties visited by more than one rep. Shows where knowledge existed inside the team but had no channel to reach the person who needed it.",
        "parameters": {"type": "OBJECT", "properties": {}},
    },
]

SYSTEM = """You are a field intelligence assistant for a parking-solutions sales
team in Bengaluru. Four reps work different parts of the city. The application uses four configurable reps: Rep A, Rep B, Rep C and Rep D.

Your job is to tell a rep what the team already knows before they walk into a
building, and to surface things they would otherwise miss.

How to work:
- Call tools to get facts. Never state a visit, contact or requirement that a
  tool did not return.
- Resolve the property first. If two candidates score similarly, ask which
  branch rather than picking one — brands can have several
  sites and getting it wrong sends the rep to the wrong address.
- If a colleague has already visited, lead with that. What they learned, what
  contact they obtained, what the outcome was. That is the single most useful
  thing you can say.
- Watch for connections across records: a site with spare parking near a client
  who needs spaces is a match worth naming, even if nobody wrote it down that way.
- Some properties have uncertain coordinates (location_confidence of
  branch_unknown or suspect_wrong_branch). Say so rather than implying precision
  the data does not have.

Answer within three tool calls. Two is usually enough: resolve the property,
then read its history. When you have enough to be useful, write the answer —
do not keep looking for more. An incomplete answer beats no answer.

Be brief. A rep is reading this on a phone outside a building. Three or four
short lines, the useful facts first. No preamble."""


def _key(api_key=None):
    return llm.api_key(api_key)


def _dispatch(con, name, args):
    """Run a tool the model asked for. This is the safety boundary: the model
    requests, we decide. No write tools are exposed to the agent at all."""
    try:
        if name == "find_property":
            res = tools.find_property(con, args.get("query", ""))
            return {"candidates": res, "count": len(res)}
        if name == "get_visit_history":
            return tools.get_visit_history(con, int(args["property_id"])) or {"error": "not found"}
        if name == "check_rep_overlap":
            return tools.check_rep_overlap(con, int(args["property_id"]), args.get("rep", ""))
        if name == "find_nearby":
            return {"nearby": tools.find_nearby(
                con, float(args["lat"]), float(args["lon"]),
                int(args.get("radius_m", 1000)))}
        if name == "get_open_followups":
            return {"followups": tools.get_open_followups(con, args.get("rep") or None)}
        if name == "find_cross_rep_gaps":
            return {"gaps": tools.find_cross_rep_gaps(con)}
        return {"error": f"unknown tool {name}"}
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}"}


def ask(con, question, rep="Rep A", api_key=None, trace=None,
        progress=None):
    """Run the agent loop. `trace` collects the tool calls so the UI can show
    what the agent actually did — useful for the demo and for debugging."""
    key = _key(api_key)
    if not key:
        raise RuntimeError("No GEMINI_API_KEY. Add it to the hosting platform environment variables.")
    if trace is None:
        trace = []

    contents = [{"role": "user",
                 "parts": [{"text": f"[rep: {rep}]\n{question}"}]}]

    for step in range(MAX_STEPS):
        if progress:
            progress(step, trace, None)
        last = step >= MAX_STEPS - 2
        body = {
            "systemInstruction": {"parts": [{"text": SYSTEM + (
                "\n\nYou are out of tool calls. Answer now from what you "
                "already have." if last else "")}]},
            "contents": contents,
            **({} if last else {"tools": [{"functionDeclarations": DECLARATIONS}]}),
            "generationConfig": {
                "temperature": 0.2,
                # Gemini 3.x reasons before answering by default, which costs
                # several seconds per loop iteration. This task is lookup and
                # summarise, not deep reasoning, so keep it shallow.
                "thinkingConfig": {"thinkingLevel": "minimal"},
            },
        }
        data, model = llm.generate(body, key, 60,
                                   on_event=(lambda m: progress(step, trace, m))
                                   if progress else None)

        cand = data["candidates"][0]
        parts = cand.get("content", {}).get("parts", [])
        calls = [p["functionCall"] for p in parts if "functionCall" in p]

        if not calls:
            text = "".join(p.get("text", "") for p in parts).strip()
            return {"answer": text or "(no answer produced)", "trace": trace}

        contents.append({"role": "model", "parts": parts})

        responses = []
        for c in calls:
            name, args = c["name"], dict(c.get("args") or {})
            result = _dispatch(con, name, args)
            trace.append({"tool": name, "args": args})
            responses.append({"functionResponse": {
                "name": name, "response": {"result": result}}})
        contents.append({"role": "user", "parts": responses})

    found = ", ".join(t["tool"] for t in trace) or "nothing"
    return {"answer": "I looked at " + found + " but could not put an answer "
                      "together. Try naming the property directly, for example "
                      "\u201cwhat do we know about BHIVE\u201d.",
            "trace": trace}
