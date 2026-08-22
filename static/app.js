(() => {
  "use strict";
  const state = {
    screen: "home", data: null, rep: localStorage.getItem("fi_rep") || "Rep A",
    coords: null, map: null, markers: [], nearby: [], filter: "all", planFilter: "all", recognition: null
  };

  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const finite = v => Number.isFinite(Number(v));
  const latlng = (lat, lon) => finite(lat) && finite(lon) && Math.abs(Number(lat)) <= 90 && Math.abs(Number(lon)) <= 180 ? [Number(lat), Number(lon)] : null;

  function toast(msg) {
    const el = $("toast"); el.textContent = msg; el.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => el.hidden = true, 2600);
  }
  async function api(path, options={}) {
    const res = await fetch(path, {headers: {"Content-Type":"application/json", ...(options.headers||{})}, ...options});
    const text = await res.text();
    let body = null; try { body = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) throw new Error(body?.detail || body?.error || `Request failed (${res.status})`);
    return body;
  }

  function show(screen) {
    state.screen = screen;
    document.querySelectorAll(".screen").forEach(s => s.classList.toggle("active", s.dataset.screen === screen));
    document.querySelectorAll(".nav").forEach(n => n.classList.toggle("active", n.dataset.go === screen));
    const titles = {home:"Good day", nearby:"Near Me", plan:"Plan", log:"Log a visit", ask:"Ask", team:"Team intelligence", property:"Property"};
    $("pageTitle").textContent = titles[screen] || "Field Intelligence";
    if (screen === "nearby") setTimeout(() => { initMap(); if (state.map) state.map.invalidateSize(); }, 60);
    if (screen === "home") renderHome();
    if (screen === "plan") renderPlan();
    if (screen === "team") renderTeam();
  }

  document.addEventListener("click", e => {
    const go = e.target.closest("[data-go]"); if (go) show(go.dataset.go);
  });

  $("repSelect").value = state.rep;
  $("repSelect").addEventListener("change", e => {
    state.rep = e.target.value; localStorage.setItem("fi_rep", state.rep);
    $("repAvatar").textContent = state.rep.replace("Rep ",""); renderAll();
  });
  $("repAvatar").textContent = state.rep.replace("Rep ","");

  async function bootstrap() {
    try {
      state.data = await api("/api/bootstrap");
      renderAll();
    } catch (err) {
      console.error("bootstrap", err);
      toast("Could not load field data. Check the server logs.");
      state.data = {properties:[], visits:[], reps:[]};
      renderAll();
    }
  }

  function properties() { return state.data?.properties || []; }
  function visits() { return state.data?.visits || []; }

  function statusFor(p) {
    const s = String(p.status || p.engagement_status || p.outcome || "").toLowerCase();
    if (s.includes("opportun") || s.includes("follow")) return "opportunity";
    if (s.includes("requirement") || s.includes("interest")) return "checked";
    return "open";
  }
  function statusLabel(p) {
    const s = statusFor(p); return s === "opportunity" ? "Opportunity" : s === "checked" ? "Checked — no current requirement" : "Open";
  }

  function renderHome() {
    const ps = properties(), vs = visits();
    const opp = ps.filter(p => statusFor(p)==="opportunity").length;
    const overlap = ps.filter(p => String(p.overlap||p.overlap_flag).toLowerCase()==="yes").length;
    $("statNearby").textContent = ps.length || 0;
    $("statFollowups").textContent = vs.filter(v => v.follow_up_required || v.next_action).length;
    $("statOpps").textContent = opp;
    $("statOverlap").textContent = overlap;
    const priorities = [
      ...ps.filter(p=>statusFor(p)==="opportunity").slice(0,3).map(p=>({p,tag:"Opportunity",cls:"opp"})),
      ...ps.filter(p=>String(p.overlap||"").toLowerCase()==="yes").slice(0,2).map(p=>({p,tag:"Overlap alert",cls:"overlap"})),
      ...ps.filter(p=>statusFor(p)==="checked").slice(0,2).map(p=>({p,tag:"Checked — no requirement",cls:"checked"}))
    ];
    $("homePriority").innerHTML = priorities.length ? priorities.map(x=>card(x.p,x.tag,x.cls)).join("") : empty("No priority items yet","Start fieldwork to build your team intelligence.");
  }

  function card(p, tag, cls) {
    return `<div class="list-card clickable" data-property="${esc(p.property_id || p.id || "")}">
      <div class="list-main"><div class="list-title">${esc(p.property_name || p.name || "Unnamed property")}</div>
      <div class="list-sub">${esc(p.area || p.address || "Location unavailable")}</div>
      <div class="list-meta"><span class="tag ${cls}">${esc(tag)}</span>${p.owner_rep ? `<span class="tag">Owner: ${esc(p.owner_rep)}</span>`:""}</div></div>
      <b>→</b></div>`;
  }
  function empty(title, sub) { return `<div class="list-card"><div class="list-main"><div class="list-title">${esc(title)}</div><div class="list-sub">${esc(sub)}</div></div></div>`; }

  document.addEventListener("click", e => {
    const p = e.target.closest("[data-property]"); if (p) openProperty(p.dataset.property);
  });

  function initMap() {
    if (!window.L) return;
    if (!state.map) {
      state.map = L.map("map", {zoomControl:true}).setView(state.coords || [12.9716,77.5946], 12);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {maxZoom:19, attribution:"© OpenStreetMap"}).addTo(state.map);
    }
    renderMarkers();
  }

  function renderMarkers() {
    if (!state.map) return;
    state.markers.forEach(m=>m.remove()); state.markers=[];
    const list = state.nearby.length ? state.nearby : properties();
    const search = $("placeSearch").value.trim().toLowerCase();
    const filtered = list.filter(p => {
      const st = statusFor(p);
      const f = state.filter;
      const matchF = f==="all" || st===f;
      const hay = `${p.property_name||p.name||""} ${p.area||p.address||""}`.toLowerCase();
      return matchF && (!search || hay.includes(search));
    });
    let first = null;
    filtered.forEach(p => {
      const ll = latlng(p.latitude ?? p.lat, p.longitude ?? p.lon);
      if (!ll) return;
      if (!first) first = ll;
      const marker = L.marker(ll).addTo(state.map);
      marker.bindPopup(`<div class="marker-title">${esc(p.property_name||p.name||"Place")}</div><div class="marker-sub">${esc(statusLabel(p))}</div>`);
      marker.on("click",()=>openProperty(p.property_id||p.id));
      state.markers.push(marker);
    });
    if (first && !state.coords) state.map.setView(first,13);
    $("nearbyCount").textContent = `${filtered.length} places`;
  }

  async function loadNearby() {
    try {
      const q = $("placeSearch").value.trim();
      let url = "/api/nearby";
      const params = new URLSearchParams();
      if (state.coords) { params.set("lat",state.coords[0]); params.set("lon",state.coords[1]); }
      if (q) params.set("q",q);
      if (params.toString()) url += "?" + params.toString();
      const data = await api(url);
      state.nearby = data.places || data.properties || [];
      $("nearbySource").textContent = data.source || `${state.nearby.length} discovered`;
      renderMarkers(); renderNearbyList();
    } catch(err) {
      console.error(err); toast("Nearby discovery is unavailable right now."); state.nearby=[]; renderMarkers(); renderNearbyList();
    }
  }
  function renderNearbyList() {
    const search = $("placeSearch").value.trim().toLowerCase();
    const list = (state.nearby.length ? state.nearby : properties()).filter(p => {
      const st=statusFor(p), hay=`${p.property_name||p.name||""} ${p.area||p.address||""}`.toLowerCase();
      return (state.filter==="all"||st===state.filter) && (!search||hay.includes(search));
    });
    $("nearbyList").innerHTML = list.slice(0,30).map(p=>card(p,statusLabel(p),statusFor(p))).join("") || empty("No places found","Try refreshing, changing the filter or moving to a new area.");
  }
  $("refreshNearby").addEventListener("click",loadNearby);
  $("placeSearch").addEventListener("input",()=>{renderMarkers();renderNearbyList()});
  document.querySelectorAll("#statusFilters .filter").forEach(b=>b.addEventListener("click",()=>{document.querySelectorAll("#statusFilters .filter").forEach(x=>x.classList.remove("active"));b.classList.add("active");state.filter=b.dataset.filter;renderMarkers();renderNearbyList()}));
  $("locateBtn").addEventListener("click",()=>navigator.geolocation?.getCurrentPosition(pos=>{
    state.coords=[pos.coords.latitude,pos.coords.longitude]; $("gpsDot").classList.add("on"); $("gpsText").textContent="Location active";
    if(state.map){state.map.setView(state.coords,15);L.circleMarker(state.coords,{radius:8}).addTo(state.map).bindPopup("You are here");}
    loadNearby();
  },()=>toast("Location permission was not granted."),{enableHighAccuracy:true,timeout:10000}));
  if (navigator.geolocation) navigator.geolocation.getCurrentPosition(pos=>{$("gpsDot").classList.add("on");$("gpsText").textContent="Location active";state.coords=[pos.coords.latitude,pos.coords.longitude]},()=>{});

  function renderPlan() {
    const vs=visits().filter(v=>v.next_action || v.follow_up_required);
    $("planCount").textContent=`${vs.length} actions`;
    $("planList").innerHTML=vs.slice(0,40).map(v=>`<div class="list-card"><div class="list-main"><div class="list-title">${esc(v.property_name||v.property||"Property")}</div><div class="list-sub">${esc(v.next_action||"Follow-up required")} ${v.next_action_date?`· ${esc(v.next_action_date)}`:""}</div><div class="list-meta"><span class="tag ${String(v.rep||"")===state.rep?"opp":""}">${esc(v.rep||"Team")}</span></div></div><button class="small-btn" data-property="${esc(v.property_id||"")}">Open</button></div>`).join("") || empty("Nothing planned","Follow-up actions will appear here after visits are logged.");
  }

  function renderTeam() {
    const vs=visits(), ps=properties();
    const opp=ps.filter(p=>statusFor(p)==="opportunity").length;
    const checked=ps.filter(p=>statusFor(p)==="checked").length;
    const overlaps=ps.filter(p=>String(p.overlap||p.overlap_flag).toLowerCase()==="yes").length;
    $("teamStats").innerHTML=[
      ["Active opportunities",opp],["Checked / no requirement",checked],["Overlap alerts",overlaps],["Team visits",vs.length]
    ].map(x=>`<div class="team-card"><strong>${x[1]}</strong><span>${x[0]}</span></div>`).join("");
    const overlapProps=ps.filter(p=>String(p.overlap||p.overlap_flag).toLowerCase()==="yes");
    $("overlapList").innerHTML=overlapProps.slice(0,10).map(p=>card(p,"Potential overlap","overlap")).join("") || empty("No overlap alerts","The team has no recorded duplicate discoveries.");
    $("activityList").innerHTML=vs.slice(-10).reverse().map(v=>`<div class="list-card"><div class="list-main"><div class="list-title">${esc(v.property_name||"Property visit")}</div><div class="list-sub">${esc(v.rep||"Team")} · ${esc(v.outcome||"Visit")} ${v.visit_date?`· ${esc(v.visit_date)}`:""}</div></div></div>`).join("") || empty("No activity yet","Logged visits will appear here.");
  }

  async function openProperty(id) {
    let p=properties().find(x=>String(x.property_id||x.id)===String(id));
    if(!p){p=state.nearby.find(x=>String(x.property_id||x.id)===String(id));}
    if(!p){toast("Property details unavailable.");return;}
    show("property");
    const visitsFor=visits().filter(v=>String(v.property_id)===String(id));
    $("propertyDetail").innerHTML=`<div class="property-hero">
      <span class="tag ${statusFor(p)}">${esc(statusLabel(p))}</span>
      <div class="property-title">${esc(p.property_name||p.name||"Property")}</div>
      <p class="list-sub">${esc(p.full_address||p.address||p.area||"Location unavailable")}</p>
      ${p.owner_rep?`<div class="list-meta"><span class="tag opp">Owner: ${esc(p.owner_rep)}</span></div>`:""}
      </div>
      <div class="property-grid">
        <div class="info-card"><h4>Field intelligence</h4><p class="list-sub">${esc(p.remarks||p.summary||"No summary recorded yet.")}</p>
          <div class="list-meta"><span class="tag">${visitsFor.length} visits</span><span class="tag">${esc(p.exact_location||"Exact location not recorded")}</span></div></div>
        <div class="info-card"><h4>Contacts</h4>${renderContacts(p)}</div>
      </div>
      <div class="section-head"><div><span class="eyebrow">HISTORY</span><h3>Visit history</h3></div><button class="primary" data-go="log">Log visit</button></div>
      <div class="list-stack">${visitsFor.slice().reverse().map(v=>`<div class="list-card"><div class="list-main"><div class="list-title">${esc(v.rep||"Rep")}</div><div class="list-sub">${esc(v.outcome||"Visit")} · ${esc(v.visit_date||"")}</div><div class="list-sub">${esc(v.remarks||"")}</div></div></div>`).join("")||empty("No visit history","This place can be the starting point for a new visit.")}</div>`;
  }
  function renderContacts(p){
    const contacts=p.contacts||[];
    if(!contacts.length && (p.contact_name||p.contact_person)) return `<div class="contact-row"><div><b>${esc(p.contact_name||p.contact_person)}</b><div class="list-sub">${esc(p.designation||"Contact")}</div></div><div class="contact-actions">${p.contact_phone?`<a class="small-btn" href="tel:${esc(p.contact_phone)}">Call</a>`:""}${p.contact_email?`<a class="small-btn" href="mailto:${esc(p.contact_email)}">Email</a>`:""}</div></div>`;
    return contacts.length?contacts.slice(0,5).map(c=>`<div class="contact-row"><div><b>${esc(c.name)}</b><div class="list-sub">${esc(c.designation||"Contact")}</div></div><div class="contact-actions">${c.phone?`<a class="small-btn" href="tel:${esc(c.phone)}">Call</a>`:""}${c.email?`<a class="small-btn" href="mailto:${esc(c.email)}">Email</a>`:""}</div></div>`).join(""):"<div class='list-sub'>No contact captured yet.</div>";
  }

  function parseTranscript(text){
    $("visitNotes").value=text;
    const lower=text.toLowerCase();
    const outcome=lower.includes("no requirement")?"No Requirement":lower.includes("not interested")?"Not Interested":lower.includes("follow-up")?"Follow-up":lower.includes("opportunity")?"Opportunity":"";
    if(outcome) $("logOutcome").value=outcome;
  }
  function setupVoice(button,inputHandler){
    const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!SR){button.title="Speech recognition is not supported in this browser";return;}
    const r=new SR(); r.lang="en-IN"; r.interimResults=true; r.continuous=false;
    r.onstart=()=>{button.classList.add("recording");$("voiceLabel").textContent="Listening…"};
    r.onresult=e=>{const text=Array.from(e.results).map(x=>x[0].transcript).join(" ");inputHandler(text)};
    r.onend=()=>{button.classList.remove("recording");$("voiceLabel").textContent="Tap to speak"};
    button.addEventListener("click",()=>{try{r.start()}catch{}});
    state.recognition=r;
  }
  setupVoice($("voiceBtn"),parseTranscript);
  setupVoice($("askVoice"),text=>{$("askInput").value=text});

  $("saveVisit").addEventListener("click",async()=>{
    const payload={
      property_name:$("logProperty").value.trim(), exact_location:$("logExactLocation").value.trim(),
      contact_name:$("logContact").value.trim(), designation:$("logDesignation").value,
      contact_phone:$("logPhone").value.trim(), contact_email:$("logEmail").value.trim(),
      outcome:$("logOutcome").value, requirement:$("logRequirement").value.trim(),
      next_action_date:$("logFollowup").value, remarks:$("logRemarks").value.trim(),
      notes:$("visitNotes").value.trim(), rep:state.rep,
      latitude:state.coords?.[0] ?? null, longitude:state.coords?.[1] ?? null
    };
    if(!payload.property_name){toast("Add the property name first.");$("logProperty").focus();return;}
    try{
      await api("/api/visits",{method:"POST",body:JSON.stringify(payload)});
      $("logMessage").textContent="Visit saved. Team intelligence updated."; $("logMessage").hidden=false;
      toast("Visit saved"); await bootstrap(); show("home");
    }catch(err){$("logMessage").textContent=err.message;$("logMessage").hidden=false;toast("Could not save the visit.");}
  });
  $("clearLog").addEventListener("click",()=>document.querySelectorAll(".form-grid input,.form-grid textarea").forEach(x=>x.value=""));

  document.querySelectorAll(".suggestions button").forEach(b=>b.addEventListener("click",()=>{$("askInput").value=b.dataset.question}));
  $("askBtn").addEventListener("click",async()=>{
    const q=$("askInput").value.trim(); if(!q)return toast("Type a question first.");
    $("askAnswer").hidden=false;$("askAnswer").textContent="Thinking…";
    try{const r=await api("/api/ask",{method:"POST",body:JSON.stringify({question:q,rep:state.rep})});$("askAnswer").textContent=r.answer||r.response||JSON.stringify(r,null,2)}
    catch(err){$("askAnswer").textContent="I couldn't answer that right now. Check the AI service configuration and server logs."}
  });

  function renderAll(){renderHome();renderPlan();renderTeam();if(state.screen==="nearby"){initMap();renderNearbyList()}}

  bootstrap();
})();
