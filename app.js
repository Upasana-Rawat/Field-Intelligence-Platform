(() => {
"use strict";
const state={screen:"home",data:null,rep:localStorage.getItem("fi_rep")||"Rep A",coords:null,map:null,markers:[],nearby:[],filter:"all",planMode:"recommended",planStops:[],recording:null,mediaRecorder:null,recordChunks:[],recordStarted:0};
const $=id=>document.getElementById(id);
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmtDist=m=>m==null?"":m<1000?`${Math.round(m)} m`:`${(m/1000).toFixed(1)} km`;
const today=()=>new Date().toISOString().slice(0,10);
function toast(msg){const e=$("toast");e.textContent=msg;e.hidden=false;clearTimeout(toast.t);toast.t=setTimeout(()=>e.hidden=true,2800)}
async function api(path,opts={}){const headers={...(opts.headers||{})};if(!(opts.body instanceof FormData)&&opts.body!==undefined&&!headers["Content-Type"])headers["Content-Type"]="application/json";const r=await fetch(path,{...opts,headers});const t=await r.text();let b=null;try{b=t?JSON.parse(t):null}catch{}if(!r.ok)throw new Error(b?.detail||b?.error||`Server error ${r.status}`);return b}
function show(screen){state.screen=screen;document.querySelectorAll(".screen").forEach(s=>s.classList.toggle("active",s.dataset.screen===screen));document.querySelectorAll(".nav").forEach(n=>n.classList.toggle("active",n.dataset.go===screen));$("pageTitle").textContent={home:"Good day",nearby:"Near Me",plan:"Today's plan",log:"Log a visit",ask:"Field copilot",team:"Team intelligence",property:"Property"}[screen]||"Field Intelligence";if(screen==="nearby")setTimeout(()=>{initMap();state.map?.invalidateSize();loadNearby()},60);if(screen==="plan")renderPlan();if(screen==="team")renderTeam();if(screen==="home")renderHome()}
document.addEventListener("click",e=>{const go=e.target.closest("[data-go]");if(go)show(go.dataset.go)});
$("repSelect").value=state.rep;$("repAvatar").textContent=state.rep.replace("Rep ","");$("repSelect").onchange=e=>{state.rep=e.target.value;localStorage.setItem("fi_rep",state.rep);$("repAvatar").textContent=state.rep.replace("Rep ","");renderAll()};
function properties(){return state.data?.properties||[]}
function followups(){return state.data?.followups||[]}
function overlaps(){return state.data?.overlaps||[]}
function status(p){const s=String(p.status||p.current_status||"Open").toLowerCase();if(s.includes("opportun")||s.includes("follow")||s.includes("live")||s.includes("client"))return"opportunity";if(s.includes("no requirement")||s.includes("checked")||s.includes("competitor")||s.includes("blocked"))return"checked";return"open"}
function statusLabel(p){const s=status(p);return s==="opportunity"?"Opportunity":s==="checked"?"Checked / no current requirement":"Unvisited"}
function tag(p){const s=status(p);return `<span class="tag ${s}">${esc(statusLabel(p))}</span>`}
function card(p,extra=""){const id=p.property_id??p.id;return `<div class="list-card clickable" data-property="${esc(id)}"><div><div class="list-title">${esc(p.property_name||p.name||"Unnamed property")}</div><div class="list-sub">${esc(p.area||p.address||"Location unavailable")}${p.distance_m!=null?` · ${esc(fmtDist(p.distance_m))}`:""}</div><div class="list-meta">${tag(p)}${p.owner_rep?`<span class="tag opportunity">Owner: ${esc(p.owner_rep)}</span>`:""}${extra}</div></div><b>→</b></div>`}
function renderHome(){const s=state.data?.stats||{};$("statProperties").textContent=s.properties??properties().length;$("statFollowups").textContent=s.followups??followups().length;$("statOpportunities").textContent=s.live??properties().filter(p=>status(p)==="opportunity").length;$("statOverlaps").textContent=s.overlaps??overlaps().length;const pri=[...properties().filter(p=>status(p)==="opportunity").slice(0,3),...properties().filter(p=>status(p)==="checked").slice(0,2)];$("homePriority").innerHTML=pri.length?pri.map(p=>card(p)).join(""):`<div class="list-card"><div><div class="list-title">No priority items</div><div class="list-sub">Enable location or open Plan to start working the territory.</div></div></div>`}
document.addEventListener("click",e=>{const p=e.target.closest("[data-property]");if(p)openProperty(p.dataset.property)});

async function requestLocation(){if(!navigator.geolocation){setGps("Browser has no location support","error");return}setGps("Requesting location…","");navigator.geolocation.getCurrentPosition(pos=>{state.coords=[pos.coords.latitude,pos.coords.longitude];localStorage.setItem("fi_coords",JSON.stringify(state.coords));setGps("Location active","on");if(state.map){state.map.setView(state.coords,15);drawUser();}loadNearby();renderPlan()},err=>{const msg=err.code===1?"Location permission blocked. Click the lock icon in Chrome → Location → Allow, then reload.":err.code===2?"Location unavailable on this device.":"Location timed out. Try again.";setGps(msg,"error");toast(msg)},{enableHighAccuracy:true,maximumAge:30000,timeout:15000})}
function setGps(text,kind){$("gpsText").textContent=text;$("locationBtn").className="location-status "+kind;$("gpsDot").className=kind==="on"?"on":""}
$("locationBtn").onclick=requestLocation;$("centerMapBtn").onclick=requestLocation;
try{const c=JSON.parse(localStorage.getItem("fi_coords")||"null");if(Array.isArray(c))state.coords=c}catch{}
function initMap(){if(!window.L)return;if(!state.map){state.map=L.map("map").setView(state.coords||[12.9716,77.5946],12);L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:"© OpenStreetMap"}).addTo(state.map)}drawUser()}
function drawUser(){if(!state.map||!state.coords)return;if(state.userMarker)state.userMarker.remove();state.userMarker=L.circleMarker(state.coords,{radius:9,weight:3,fillOpacity:.9}).addTo(state.map).bindPopup("You are here")}
async function loadNearby(){if(!state.coords){renderNearby();return}try{const r=await api(`/api/nearby?lat=${encodeURIComponent(state.coords[0])}&lon=${encodeURIComponent(state.coords[1])}&radius=5000&limit=60`);const internal=(r.internal||[]).map(x=>({...x,property_id:x.property_id,property_name:x.property_name,latitude:x.latitude,longitude:x.longitude,source_type:"team"}));const external=(r.external||[]).map(x=>({...x,property_id:x.match?.property_id||null,source_type:"external"}));state.nearby=[...internal,...external];$("nearbyProvider").textContent=`${r.provider||"discovery"} · ${state.nearby.length} places`;renderMapAndList()}catch(e){$("nearbyProvider").textContent="Nearby service unavailable";toast("Could not load nearby places. Check the server logs.");renderNearby()}}
function renderNearby(){const list=state.nearby.length?state.nearby:properties();const q=$("placeSearch").value.trim().toLowerCase();const f=state.filter;const out=list.filter(p=>{const st=status(p);const unv=!p.property_id;const ok=f==="all"||(f==="open"&&unv)||(f==="overlap"&&String(p.overlap_flag||"").toLowerCase()==="yes")||(f===st);const hay=`${p.property_name||p.name||""} ${p.area||p.address||""}`.toLowerCase();return ok&&(!q||hay.includes(q))});$("nearbyCount").textContent=`${out.length} places`;$("nearbyList").innerHTML=out.slice(0,40).map(p=>{if(!p.property_id)return `<div class="list-card"><div><div class="list-title">${esc(p.name||"External place")}</div><div class="list-sub">${esc(p.address||"New discovery")}</div><div class="list-meta"><span class="tag open">Unvisited</span><span class="tag">External</span></div></div><button class="small-btn add-external" data-name="${esc(p.name||"")}" data-lat="${esc(p.lat)}" data-lon="${esc(p.lon)}">Log</button></div>`;return card(p,p.distance_m!=null?`<span class="tag">${esc(fmtDist(p.distance_m))}</span>`:"")}).join("")||`<div class="list-card"><div><div class="list-title">No matching places</div><div class="list-sub">Try another filter or search.</div></div></div>`}
function renderMapAndList(){if(!state.map)initMap();state.markers.forEach(m=>m.remove());state.markers=[];const q=$("placeSearch").value.trim().toLowerCase();const out=state.nearby.filter(p=>{const st=status(p),unv=!p.property_id;const f=state.filter;const ok=f==="all"||(f==="open"&&unv)||(f==="overlap"&&String(p.overlap_flag||"").toLowerCase()==="yes")||(f===st);const hay=`${p.property_name||p.name||""} ${p.area||p.address||""}`.toLowerCase();return ok&&(!q||hay.includes(q))});out.forEach(p=>{const lat=p.latitude??p.lat,lon=p.longitude??p.lon;if(!Number.isFinite(Number(lat))||!Number.isFinite(Number(lon)))return;const m=L.marker([Number(lat),Number(lon)]).addTo(state.map);m.bindPopup(`<b>${esc(p.property_name||p.name||"Place")}</b><br><small>${esc(statusLabel(p))}</small>`);if(p.property_id)m.on("click",()=>openProperty(p.property_id));state.markers.push(m)});$("nearbyCount").textContent=`${out.length} places`;renderNearby()}
$("searchBtn").onclick=async()=>{const q=$("placeSearch").value.trim();if(!q)return loadNearby();try{const r=await api(`/api/place-search?q=${encodeURIComponent(q)}${state.coords?`&lat=${state.coords[0]}&lon=${state.coords[1]}`:""}`);state.nearby=[...(r.internal||[]).map(x=>({...x,property_id:x.property_id??x.id,property_name:x.property_name??x.name})),...(r.external||[])];$("nearbyProvider").textContent=`${r.provider||"search"} · ${state.nearby.length} results`;renderMapAndList()}catch(e){toast("Search failed.")}};
$("placeSearch").onkeydown=e=>{if(e.key==="Enter")$("searchBtn").click()};document.querySelectorAll(".filter").forEach(b=>b.onclick=()=>{document.querySelectorAll(".filter").forEach(x=>x.classList.remove("active"));b.classList.add("active");state.filter=b.dataset.filter;renderMapAndList()});

async function openProperty(id){try{show("property");const r=await api(`/api/property/${encodeURIComponent(id)}`);const p=r.property,vs=r.visits||[],cs=r.contacts||[];const ov=r.overlap||{};$("propertyDetail").innerHTML=`<div class="property-hero">${tag(p)}<div class="property-title">${esc(p.property_name)}</div><div class="list-sub">${esc(p.parent_site||"")}${p.area?` · ${esc(p.area)}`:""}${p.exact_location?` · ${esc(p.exact_location)}`:""}</div><div class="list-meta">${p.owner_rep?`<span class="tag opportunity">Owner: ${esc(p.owner_rep)}</span>`:""}${ov.duplicate_risk?`<span class="tag overlap">⚠ Visited by colleague</span>`:""}</div></div><div class="property-grid"><div class="info-card"><h4>Team intelligence</h4><div class="list-sub">${esc(vs.length?vs[vs.length-1].remarks||"Latest visit recorded.":"No visit history yet.")}</div><div class="list-meta"><span class="tag">${vs.length} visit${vs.length===1?"":"s"}</span>${p.latitude!=null?`<span class="tag">${esc(p.latitude.toFixed(5))}, ${esc(p.longitude.toFixed(5))}</span>`:""}</div></div><div class="info-card"><h4>Contacts</h4>${cs.length?cs.map(c=>`<div class="contact-row"><div><b>${esc(c.name||"Unnamed")}</b><div class="list-sub">${esc(c.designation||c.contact_type||"Contact")}</div></div><div class="contact-actions">${c.phone?`<a class="small-btn" href="tel:${esc(c.phone)}">Call</a>`:""}${c.email?`<a class="small-btn" href="mailto:${esc(c.email)}">Email</a>`:""}</div></div>`).join(""):"<div class='list-sub'>No contact captured yet.</div>"}</div></div><div class="section-head"><div><span class="eyebrow">VISIT HISTORY</span><h3>What the team knows</h3></div><button class="primary" id="logThisProperty">Log visit</button></div><div class="list-stack">${vs.slice().reverse().map(v=>`<div class="list-card"><div><div class="list-title">${esc(v.rep)} · ${esc(v.outcome_category)}</div><div class="list-sub">${esc(v.visit_date||"")} ${v.contact_name?`· ${esc(v.contact_name)} (${esc(v.contact_designation||v.contact_role||"")})`:""}</div><div class="list-sub">${esc(v.remarks||"")}</div></div></div>`).join("")||`<div class="list-card"><div><div class="list-title">No visits yet</div><div class="list-sub">This is an unvisited place.</div></div></div>`}</div>`;$("logThisProperty").onclick=()=>prefillProperty(p)}catch(e){toast("Could not load property details.")}}
function prefillProperty(p){$("logProperty").value=p.property_name||"";$("logPropertyId").value=p.property_id||"";$("logExactLocation").value=p.exact_location||"";show("log")}
document.querySelectorAll(".suggestions button").forEach(b=>b.onclick=()=>{$("askInput").value=b.dataset.question});
$("askBtn").onclick=async()=>{const q=$("askInput").value.trim();if(!q)return toast("Ask a question first.");$("askAnswer").hidden=false;$("askAnswer").textContent="Checking team intelligence…";try{const r=await api("/api/ask",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({question:q,rep:state.rep})});$("askAnswer").textContent=r.answer||"No answer returned."}catch(e){$("askAnswer").textContent=e.message.includes("GEMINI")?"AI is not configured on Render. Add GEMINI_API_KEY in the service environment variables.":`Ask failed: ${e.message}`}}
$("askVoice").onclick=()=>startBrowserSpeech(text=>{$("askInput").value=text});
function startBrowserSpeech(done){const SR=window.SpeechRecognition||window.webkitSpeechRecognition;if(!SR){toast("Voice input is not supported by this browser.");return}const r=new SR();r.lang="en-IN";r.interimResults=false;r.maxAlternatives=1;r.onstart=()=>toast("Listening… speak now");r.onerror=e=>toast(`Voice input failed: ${e.error}`);r.onresult=e=>done(e.results[0][0].transcript);r.start()}

function renderPlan(){
  const f=followups();
  const opp=properties().filter(p=>status(p)==="opportunity");
  let list=[];
  if(state.planMode==="followups"){
    list=f.map(v=>({type:"followup",property_id:v.property_id,property_name:v.property_name,area:v.area,lat:v.latitude,lon:v.longitude,rep:v.rep,action:v.follow_up_state}));
  }else if(state.planMode==="added"){
    list=state.planStops;
  }else{
    const seen=new Set();
    f.forEach(v=>{
      if(!seen.has(v.property_id)){
        seen.add(v.property_id);
        list.push({type:"followup",property_id:v.property_id,property_name:v.property_name,area:v.area,lat:v.latitude,lon:v.longitude,rep:v.rep,action:v.follow_up_state});
      }
    });
    opp.forEach(p=>{
      const pid=p.id ?? p.property_id;
      if(!seen.has(pid)){
        seen.add(pid);
        list.push({type:"opportunity",property_id:pid,property_name:p.name ?? p.property_name,area:p.area,lat:p.lat ?? p.latitude,lon:p.lon ?? p.longitude,rep:Array.isArray(p.reps)?p.reps.join(", "):p.owner_rep,action:"Opportunity"});
      }
    });
    if(state.coords){
      const nearby=properties()
        .filter(p=>status(p)==="open"&&(p.lat!=null||p.latitude!=null))
        .map(p=>({...p,distance_m:dist(state.coords[0],state.coords[1],p.lat ?? p.latitude,p.lon ?? p.longitude)}))
        .sort((a,b)=>a.distance_m-b.distance_m).slice(0,6);
      nearby.forEach(p=>{
        const pid=p.id ?? p.property_id;
        if(!seen.has(pid)) list.push({type:"recommended",property_id:pid,property_name:p.name ?? p.property_name,area:p.area,lat:p.lat ?? p.latitude,lon:p.lon ?? p.longitude,action:`${fmtDist(p.distance_m)} away`});
      });
    }
  }
  $("planSummary").innerHTML=`<div class="summary-box"><b>${list.length}</b><span>suggested stops</span></div><div class="summary-box"><b>${f.length}</b><span>open follow-ups</span></div><div class="summary-box"><b>${opp.length}</b><span>opportunities</span></div>`;
  $("planList").innerHTML=list.slice(0,20).map(x=>`<div class="list-card"><div><div class="list-title">${esc(x.property_name||"Property")}</div><div class="list-sub">${esc(x.area||"")}${x.action?` · ${esc(x.action)}`:""}${x.rep?` · ${esc(x.rep)}`:""}</div><div class="list-meta"><span class="tag ${x.type==="opportunity"?"opportunity":x.type==="followup"?"follow":"open"}">${esc(x.type)}</span></div></div><div><button class="small-btn plan-open" data-property="${esc(x.property_id)}">Open</button>${state.planMode==="added"?`<button class="small-btn remove-stop" data-id="${esc(x.property_id)}">Remove</button>`:`<button class="small-btn add-stop" data-item='${esc(JSON.stringify(x))}'>Add</button>`}</div></div>`).join("")||`<div class="list-card"><div><div class="list-title">No plan yet</div><div class="list-sub">Enable location or log follow-ups to generate your next stops.</div></div></div>`;
}
function dist(a,b,c,d){const R=6371000,p=Math.PI/180,dp=(c-a)*p,dl=(d-b)*p,x=Math.sin(dp/2)**2+Math.cos(a*p)*Math.cos(c*p)*Math.sin(dl/2)**2;return 2*R*Math.asin(Math.sqrt(x))}
document.querySelectorAll("[data-plan]").forEach(b=>b.onclick=()=>{document.querySelectorAll("[data-plan]").forEach(x=>x.classList.remove("active"));b.classList.add("active");state.planMode=b.dataset.plan;renderPlan()});
document.addEventListener("click",e=>{const a=e.target.closest(".add-stop");if(a){const x=JSON.parse(a.dataset.item);if(!state.planStops.some(y=>y.property_id===x.property_id))state.planStops.push(x);state.planMode="added";document.querySelectorAll("[data-plan]").forEach(b=>b.classList.toggle("active",b.dataset.plan==="added"));renderPlan();toast("Added to today's plan")}const r=e.target.closest(".remove-stop");if(r){state.planStops=state.planStops.filter(x=>String(x.property_id)!==String(r.dataset.id));renderPlan()}});
$("refreshPlan").onclick=renderPlan;
$("routeBtn").onclick=async()=>{if(!state.coords||!state.planStops.length)return toast("Enable location and add stops first.");try{const points=JSON.stringify(state.planStops.filter(x=>x.lat!=null).map(x=>({lat:x.lat,lon:x.lon})));const r=await api(`/api/route?origin_lat=${state.coords[0]}&origin_lon=${state.coords[1]}&points=${encodeURIComponent(points)}&mode=WALK`);$("routeText").textContent=`${fmtDist(r.distance_m)} · ${Math.round((r.duration_s||0)/60)} min · ${r.provider}`;$("routeCard").hidden=false}catch(e){toast("Could not build route.")}};
function renderTeam(){const s=state.data?.stats||{};$("teamStats").innerHTML=[["Opportunities",s.live??0],["No requirement",properties().filter(p=>String(p.status||"").toLowerCase().includes("no requirement")).length],["Overlap alerts",s.overlaps??0],["Visits",s.visits??0]].map(x=>`<div class="team-card"><strong>${x[1]}</strong><span>${x[0]}</span></div>`).join("");$("overlapList").innerHTML=overlaps().length?overlaps().slice(0,12).map(o=>`<div class="list-card clickable" data-property="${esc(o.property_id||"")}"><div><div class="list-title">${esc(o.property_name)}</div><div class="list-sub">${esc((o.reps||[]).join(" · "))}</div><div class="list-meta"><span class="tag overlap">Overlap</span></div></div><b>→</b></div>`).join(""):`<div class="list-card"><div><div class="list-title">No overlap alerts</div><div class="list-sub">When multiple reps visit a property, it appears here.</div></div></div>`;$("activityList").innerHTML=followups().slice(0,8).map(v=>`<div class="list-card"><div><div class="list-title">${esc(v.property_name)}</div><div class="list-sub">${esc(v.rep)} · ${esc(v.follow_up_state)}</div></div></div>`).join("")||`<div class="list-card"><div><div class="list-title">No open actions</div></div></div>`}
$("refreshTeam").onclick=async()=>{await bootstrap();show("team")};

$("findPropertyBtn").onclick=async()=>{const q=$("logProperty").value.trim();if(!q)return toast("Enter a property name.");try{const r=await api(`/api/search?q=${encodeURIComponent(q)}&limit=6`);$("propertyMatches").innerHTML=(r.results||[]).map(p=>`<button class="match" data-match-id="${p.property_id}" data-match-name="${esc(p.property_name)}">${esc(p.property_name)} · ${esc(p.area||"")}</button>`).join("")||"<div class='list-sub'>No exact team property. You can log a new discovery using its name and current location.</div>"}catch(e){toast("Property search failed.")}};
document.addEventListener("click",e=>{const m=e.target.closest("[data-match-id]");if(m){$("logPropertyId").value=m.dataset.matchId;$("logProperty").value=m.dataset.matchName;$("propertyMatches").innerHTML=""}});

async function saveVisit(){const pid=$("logPropertyId").value;const name=$("logProperty").value.trim();if(!name)return toast("Enter or select a property.");const payload={rep:state.rep,property_id:pid?Number(pid):null,new_property:!pid,property_name:name,latitude:state.coords?.[0]??null,longitude:state.coords?.[1]??null,outcome_category:$("logOutcome").value,remarks:$("logRemarks").value.trim()||$("visitNotes").value.trim(),visit_date:today(),requirement_detail:$("logRequirement").value.trim(),contact_role:$("logDesignation").value,contact_name:$("logContact").value.trim(),contact_email:$("logEmail").value.trim(),contact_phone:$("logPhone").value.trim(),contact_designation:$("logDesignation").value,exact_location:$("logExactLocation").value.trim(),follow_up_state:$("logFollowup").value,access_blocked:$("logOutcome").value==="UNQUALIFIED"};if(payload.new_property&&(!payload.latitude||!payload.longitude))return toast("Enable location before logging a new property.");try{const endpoint=payload.new_property?"/api/field-entry":"/api/visit";const body=payload.new_property?payload:{property_id:payload.property_id,rep:payload.rep,outcome_category:payload.outcome_category,remarks:payload.remarks,visit_date:payload.visit_date,requirement_detail:payload.requirement_detail,contact_role:payload.contact_role,follow_up_state:payload.follow_up_state,access_blocked:payload.access_blocked,contact_name:payload.contact_name,contact_email:payload.contact_email,contact_phone:payload.contact_phone,contact_designation:payload.contact_designation,exact_location:payload.exact_location,logged_lat:payload.latitude,logged_lon:payload.longitude};await api(endpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});$("logMessage").textContent="Saved. The team can now see this visit and contact intelligence.";$("logMessage").hidden=false;toast("Visit saved");clearLog();await bootstrap();show("home")}catch(e){toast(`Could not save: ${e.message}`)}}
$("saveVisit").onclick=saveVisit;
function clearLog(){$("logProperty").value="";$("logPropertyId").value="";$("logExactLocation").value="";$("logContact").value="";$("logPhone").value="";$("logEmail").value="";$("logRequirement").value="";$("logRemarks").value="";$("visitNotes").value="";$("propertyMatches").innerHTML="";$("logMessage").hidden=true}
$("clearLog").onclick=clearLog;

async function extractNote(){const text=$("visitNotes").value.trim();if(!text)return toast("Type or record a field note first.");try{const r=await api("/api/extract",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({text})});if(r.property_name&&!$("logProperty").value)$("logProperty").value=r.property_name;if(r.outcome_category)$("logOutcome").value=r.outcome_category;if(r.requirement_detail)$("logRequirement").value=r.requirement_detail;if(r.contact_role)$("logDesignation").value=r.contact_role;if(r.remarks)$("logRemarks").value=r.remarks;if(r.follow_up_state)$("logFollowup").value=r.follow_up_state;toast("Note structured. Review before saving.")}catch(e){toast(e.message.includes("GEMINI")?"AI extraction needs GEMINI_API_KEY on Render.":`AI extraction failed: ${e.message}`)}}
$("extractBtn").onclick=extractNote;

async function startRecording(){
  if(!navigator.mediaDevices?.getUserMedia){
    toast("This browser does not support microphone access.");
    return;
  }
  if(state.recording || state.mediaRecorder?.state==="recording") return;
  try{
    const stream=await navigator.mediaDevices.getUserMedia({audio:true});
    state.recordChunks=[];
    let options={};
    if(MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) options={mimeType:"audio/webm;codecs=opus"};
    else if(MediaRecorder.isTypeSupported("audio/webm")) options={mimeType:"audio/webm"};
    state.mediaRecorder=new MediaRecorder(stream,options);
    state.recording=true;
    state.recordStarted=Date.now();

    $("recordBtn").classList.add("recording");
    $("recordLabel").textContent="Recording… tap to stop";
    $("recordHint").textContent="Speak naturally about the visit";
    $("recordTimer").hidden=false;
    $("recordTimer").textContent="00:00";

    const timer=setInterval(()=>{
      if(!state.recording){clearInterval(timer);return}
      const sec=Math.floor((Date.now()-state.recordStarted)/1000);
      $("recordTimer").textContent=`${String(Math.floor(sec/60)).padStart(2,"0")}:${String(sec%60).padStart(2,"0")}`;
    },250);

    state.mediaRecorder.ondataavailable=e=>{
      if(e.data&&e.data.size) state.recordChunks.push(e.data);
    };

    state.mediaRecorder.onstop=async()=>{
      state.recording=false;
      $("recordBtn").classList.remove("recording");
      $("recordLabel").textContent="Processing recording…";
      $("recordHint").textContent="Uploading your field note";
      $("recordTimer").hidden=true;

      stream.getTracks().forEach(t=>t.stop());

      const mime=state.recordChunks[0]?.type || "audio/webm";
      const blob=new Blob(state.recordChunks,{type:mime});
      state.recordChunks=[];

      if(!blob.size){
        $("recordLabel").textContent="Tap to record";
        $("recordHint").textContent="No audio was captured. Try again.";
        toast("No audio was captured.");
        return;
      }

      const fd=new FormData();
      fd.append("audio",blob,"field-note.webm");

      try{
        const r=await api("/api/extract",{method:"POST",body:fd});
        if(r.property_name&&!$("logProperty").value) $("logProperty").value=r.property_name;
        if(r.outcome_category) $("logOutcome").value=r.outcome_category;
        if(r.requirement_detail) $("logRequirement").value=r.requirement_detail;
        if(r.contact_role) $("logDesignation").value=r.contact_role;
        if(r.contact_name) $("logContact").value=r.contact_name;
        if(r.contact_email) $("logEmail").value=r.contact_email;
        if(r.contact_phone) $("logPhone").value=r.contact_phone;
        if(r.exact_location) $("logExactLocation").value=r.exact_location;
        if(r.remarks) $("logRemarks").value=r.remarks;
        if(r.follow_up_state) $("logFollowup").value=r.follow_up_state;
        toast("Voice note structured. Review before saving.");
      }catch(e){
        // Keep the recording workflow usable even if AI extraction is unavailable.
        $("visitNotes").value=$("visitNotes").value || "Voice recording captured. AI extraction unavailable.";
        toast(e.message.includes("GEMINI") ? "Recording stopped. Add GEMINI_API_KEY for AI extraction." : `Recording stopped. ${e.message}`);
      }finally{
        $("recordLabel").textContent="Tap to record";
        $("recordHint").textContent="Use your voice to capture the field note";
      }
    };

    state.mediaRecorder.start();
  }catch(e){
    state.recording=false;
    state.mediaRecorder=null;
    $("recordBtn").classList.remove("recording");
    $("recordLabel").textContent="Tap to record";
    $("recordHint").textContent="Use your voice to capture the field note";
    toast("Microphone permission was blocked. Click the lock icon in Chrome → Microphone → Allow.");
  }
}

$("recordBtn").onclick=()=>{
  if(state.mediaRecorder && state.mediaRecorder.state==="recording"){
    // Explicit stop: this is the only path used to end a recording.
    state.mediaRecorder.stop();
    return;
  }
  startRecording();
};

async function bootstrap(){try{state.data=await api("/api/bootstrap");renderAll()}catch(e){console.error(e);toast("Could not load field data.");state.data={properties:[],stats:{},followups:[],overlaps:[]};renderAll()}}
function renderAll(){renderHome();renderTeam();if(state.screen==="plan")renderPlan();if(state.screen==="nearby")renderMapAndList()}
bootstrap();
})();