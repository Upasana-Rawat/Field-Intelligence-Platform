/* Field Intelligence V2 frontend.
 * Single-page application: every primary tab is a full workspace in the same
 * document. The backend remains the source of truth for data and writes.
 */
const S = {
  screen: "home", previous: [], rep: "Rep A", reps: [], props: [], byId: {},
  stats: {}, followups: [], overlaps: [], activity: [], team: null, me: null,
  external: [], externalProvider: "", selectedProperty: null, plan: [],
  radius: 1500, map: null, planMap: null, cluster: null, extLayer: null,
  planLayer: null, meMarker: null, meCircle: null, routeLayer: null,
  searchTimer: null, draft: null, recording: false, recorder: null, audioChunks: [],
  filters: { visited: true, unvisited: true, opportunity: true, followup: true },
};

const STATUS = {
  live: ["Opportunity", "live"], client: ["Client", "client"], pending: ["Follow-up", "pending"],
  locked: ["Competitor", "locked"], blocked: ["Access blocked", "blocked"], dead: ["No requirement", "dead"]
};
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
const fmtD = m => m < 1000 ? `${Math.round(m)} m` : `${(m/1000).toFixed(1)} km`;
const fmtDate = d => d ? new Date(d).toLocaleDateString(undefined,{day:"2-digit",month:"short",year:"numeric"}) : "—";
const today = () => new Date().toISOString().slice(0,10);
const validCoord = (lat, lon) => {
  const a = Number(lat), b = Number(lon);
  return Number.isFinite(a) && Number.isFinite(b) && a >= -90 && a <= 90 && b >= -180 && b <= 180;
};
function toast(msg, ms=2600){const t=$("#toast");t.textContent=msg;t.classList.add("toast-show");clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove("toast-show"),ms)}
async function api(url, options={}){const r=await fetch(url,options);let j=null;try{j=await r.json()}catch{}if(!r.ok)throw new Error(j?.detail||j?.message||`Request failed (${r.status})`);return j}
function statusPill(status){const [label,cls]=STATUS[status]||[status||"Unknown","dead"];return `<span class="pill ${cls}">${esc(label)}</span>`}
function empty(text){return `<div class="empty">${esc(text)}</div>`}
function setScreen(screen, push=true){
  if(S.screen===screen&&!push){return}
  if(push&&S.screen!==screen)S.previous.push(S.screen);
  S.screen=screen;
  document.querySelectorAll(".screen").forEach(x=>x.classList.remove("active"));
  const el=$("#screen-"+screen);if(el)el.classList.add("active");
  document.querySelectorAll(".bottom-nav button").forEach(b=>b.classList.toggle("active",b.dataset.screen===screen));
  const subtitles={home:"Command centre",near:"Discover and understand nearby places",plan:"Build today’s field route",log:"Capture field intelligence",ask:"AI field copilot",team:"Shared team intelligence",property:"Property intelligence"};
  $("#screenSubtitle").textContent=subtitles[screen]||"Field Intelligence";
  if(screen==="home")renderHome();
  if(screen==="near")renderNear();
  if(screen==="plan")renderPlan();
  if(screen==="log")renderLog();
  if(screen==="ask")renderAsk();
  if(screen==="team")renderTeam();
  if(screen==="property")renderProperty(S.selectedProperty);
  setTimeout(()=>{if(S.map)S.map.invalidateSize();if(S.planMap)S.planMap.invalidateSize()},60);
}
function goBack(){const prev=S.previous.pop();if(prev)setScreen(prev,false);else setScreen("home",false)}

async function boot(){
  try{
    const d=await api("/api/bootstrap");
    S.reps=d.reps||[];S.props=d.properties||[];S.stats=d.stats||{};S.followups=d.followups||[];S.overlaps=d.overlaps||[];
    S.byId={};S.props.forEach(p=>S.byId[p.id]=p);
    $("#repSelect").innerHTML=S.reps.map(r=>`<option>${esc(r)}</option>`).join("");
    $("#repSelect").value=S.rep;
    renderHome();setScreen("home",false);locate(false);
  }catch(e){
    console.error("Bootstrap failed",e);
    $("#screen-home").innerHTML=`<div class="screen-inner"><div class="alert bad"><b>Unable to load field data.</b><div style="margin-top:6px">${esc(e.message)}</div><button class="btn blue" style="margin-top:12px" onclick="location.reload()">Retry</button></div></div>`;
  }
}

$("#repSelect").addEventListener("change",e=>{S.rep=e.target.value;localStorage.setItem("fi_rep",S.rep);renderHome();if(S.screen==="near")renderNear();if(S.screen==="team")renderTeam()});
const savedRep=localStorage.getItem("fi_rep");if(savedRep)S.rep=savedRep;
$("#refreshBtn").onclick=async()=>{await reloadData();toast("Updated")};
async function reloadData(){const d=await api("/api/bootstrap");S.reps=d.reps||S.reps;S.props=d.properties||[];S.byId={};S.props.forEach(p=>S.byId[p.id]=p);S.stats=d.stats||{};S.followups=d.followups||[];S.overlaps=d.overlaps||[];if(S.screen==="home")renderHome();if(S.screen==="near")renderNear();if(S.screen==="team")renderTeam()}

document.querySelectorAll(".bottom-nav button").forEach(b=>b.onclick=()=>setScreen(b.dataset.screen));

/* ------------------------------ GPS */
function updateGpsBadge(){const b=$("#gpsBadge");if(S.me){b.textContent="GPS active";b.className="status-badge"}else{b.textContent="GPS off";b.className="status-badge muted"}}
function locate(fly=true){
  if(!navigator.geolocation){toast("This browser does not support GPS");return}
  if(!window.isSecureContext&&location.hostname!=="localhost"){toast("GPS requires HTTPS. Open the HTTPS address.",5000);return}
  navigator.geolocation.getCurrentPosition(pos=>{setMe(pos.coords.latitude,pos.coords.longitude,"My location",fly);},err=>{
    const msg={1:"Location permission denied. Allow location in browser settings.",2:"Your position is unavailable. Turn on device location and try again.",3:"GPS timed out. Try again outdoors."}[err.code]||"GPS unavailable";toast(msg,5000);updateGpsBadge();
  },{enableHighAccuracy:true,timeout:15000,maximumAge:30000});
}
function setMe(lat,lon,label="My location",fly=true){
  if(!validCoord(lat,lon)){ toast("GPS returned an invalid location. Try again.",5000); updateGpsBadge(); return; }
  lat=Number(lat); lon=Number(lon);
  S.me={lat,lon,label};updateGpsBadge();
  [S.meMarker,S.meCircle].forEach(x=>{if(x&&S.map)S.map.removeLayer(x)});
  if(S.map){S.meMarker=L.marker([lat,lon],{icon:L.divIcon({className:"",html:'<div class="me-marker"></div>',iconSize:[18,18],iconAnchor:[9,9]})}).addTo(S.map).bindTooltip(label);S.meCircle=L.circle([lat,lon],{radius:S.radius,color:"#2563eb",weight:1,fillOpacity:.03}).addTo(S.map);if(fly)S.map.flyTo([lat,lon],16,{duration:.6})}
  if(S.screen==="near")loadNearby();
}

/* ------------------------------ maps */
const street=L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:20,attribution:"© OpenStreetMap"});
const sat=L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",{maxZoom:19,attribution:"Esri"});
function initNearMap(){
  if(S.map)return;
  S.map=L.map("nearMap",{zoomControl:false}).setView([12.9856,77.7367],13);street.addTo(S.map);L.control.zoom({position:"bottomright"}).addTo(S.map);
  S.cluster=L.markerClusterGroup({maxClusterRadius:42,showCoverageOnHover:false}).addTo(S.map);S.extLayer=L.layerGroup().addTo(S.map);
  S.map.on("click",e=>{S.me={lat:e.latlng.lat,lon:e.latlng.lng,label:"Dropped pin"};updateGpsBadge();loadNearby()});
  if(S.me)setMe(S.me.lat,S.me.lon,S.me.label,false);drawInternal();drawExternal();
}
function initPlanMap(){
  if(S.planMap)return;
  S.planMap=L.map("planMap",{zoomControl:false}).setView([12.9856,77.7367],13);street.addTo(S.planMap);L.control.zoom({position:"bottomright"}).addTo(S.planMap);S.planLayer=L.layerGroup().addTo(S.planMap);S.routeLayer=L.layerGroup().addTo(S.planMap);drawPlanMap();
}
function drawInternal(){
  if(!S.cluster)return;S.cluster.clearLayers();
  S.props.forEach(p=>{
    if(!validCoord(p.lat,p.lon)||!shouldShowInternal(p))return;
    const [label,cls]=STATUS[p.status]||["Unknown","dead"];const colour={live:"#16a34a",client:"#0891b2",pending:"#ca8a04",locked:"#7c3aed",blocked:"#525252",dead:"#94a3b8"}[p.status]||"#94a3b8";
    const m=L.circleMarker([p.lat,p.lon],{radius:p.status==="live"?9:7,color:colour,fillColor:colour,fillOpacity:.85,weight:2}).bindTooltip(`${esc(p.name)} · ${label}`);m.on("click",()=>openProperty(p.id));S.cluster.addLayer(m);
  });
}
function shouldShowInternal(p){
  if(!S.filters.visited&&p.visits>0)return false;if(!S.filters.opportunity&&["live","client"].includes(p.status))return false;if(!S.filters.followup&&p.status==="pending")return false;return true;
}
function drawExternal(){
  if(!S.extLayer)return;S.extLayer.clearLayers();if(!S.filters.unvisited)return;
  S.external.forEach(p=>{if(!validCoord(p.lat,p.lon))return;const m=L.circleMarker([p.lat,p.lon],{radius:5,color:"#2563eb",fillColor:"#dbeafe",fillOpacity:.9,weight:2}).bindTooltip(`${esc(p.name)} · Not in team database`);m.on("click",()=>openExternal(p));S.extLayer.addLayer(m)});
}
function decodePolyline(str){
  let i=0,lat=0,lng=0,out=[];while(i<str.length){let b,shift=0,res=0;do{b=str.charCodeAt(i++)-63;res|=(b&31)<<shift;shift+=5}while(b>=32);lat+=res&1?~(res>>1):res>>1;shift=0;res=0;do{b=str.charCodeAt(i++)-63;res|=(b&31)<<shift;shift+=5}while(b>=32);lng+=res&1?~(res>>1):res>>1;out.push([lat/1e5,lng/1e5])}return out;
}
function drawPlanMap(){
  if(!S.planMap||!S.planLayer)return;S.planLayer.clearLayers();S.routeLayer?.clearLayers();
  const pts=[];if(S.me)pts.push([S.me.lat,S.me.lon]);
  S.plan.forEach((p,i)=>{if(validCoord(p.lat,p.lon)){pts.push([Number(p.lat),Number(p.lon)]);L.marker([p.lat,p.lon]).bindTooltip(`${i+1}. ${esc(p.name)}`).addTo(S.planLayer)}});
  if(S.me&&validCoord(S.me.lat,S.me.lon))L.marker([S.me.lat,S.me.lon],{icon:L.divIcon({className:"",html:'<div class="me-marker"></div>',iconSize:[18,18],iconAnchor:[9,9]})}).addTo(S.planLayer);
  if(pts.length>1)S.planMap.fitBounds(pts,{padding:[30,30]});
}

async function loadNearby(){
  if(!S.me)return;try{const d=await api(`/api/nearby?lat=${S.me.lat}&lon=${S.me.lon}&radius=${S.radius}&limit=60`);S.external=d.external||[];S.externalProvider=d.provider||"";S.internalNearby=d.internal||[];drawInternal();drawExternal();if(S.screen==="near")renderNearList()}catch(e){toast(e.message)}}

/* ------------------------------ Near Me */
function renderNear(){
  $("#screen-near").innerHTML=`<div class="near-layout">
    <div class="map-pane"><div id="nearMap" class="map"></div>
      <div class="map-tools"><div class="search-wrap"><input id="placeSearch" class="search-input" placeholder="Search a tech park, coworking space or place…"><button id="clearSearch" class="search-clear">×</button><div id="searchResults" class="search-results hidden"></div></div><button id="locateBtn" class="map-tool-btn">◎</button><button id="satBtn" class="map-tool-btn">Layers</button></div>
      <div class="map-legend"><div class="legend-item"><i class="legend-dot" style="background:#16a34a"></i>Team opportunity</div><div class="legend-item"><i class="legend-dot" style="background:#2563eb"></i>External / unvisited</div></div>
    </div>
    <aside class="near-side"><div class="side-head"><h2>Near Me</h2><p id="nearSummary">Discovering places around you…</p><div class="filter-row"><button class="filter-chip on" data-filter="visited">Team</button><button class="filter-chip on" data-filter="unvisited">Unvisited</button><button class="filter-chip on" data-filter="opportunity">Opportunity</button><button class="filter-chip on" data-filter="followup">Follow-ups</button><select id="radiusSelect" class="filter-chip"><option value="500">500m</option><option value="1000">1 km</option><option value="1500" selected>1.5 km</option><option value="3000">3 km</option></select></div></div><div id="nearList" class="side-list"></div></aside>
  </div>`;
  initNearMap();
  $("#locateBtn").onclick=()=>locate(true);$("#satBtn").onclick=()=>{if(S.map.hasLayer(street)){S.map.removeLayer(street);sat.addTo(S.map)}else{S.map.removeLayer(sat);street.addTo(S.map)}};
  $("#radiusSelect").value=String(S.radius);$("#radiusSelect").onchange=e=>{S.radius=+e.target.value;if(S.me){if(S.meCircle){S.meCircle.setRadius(S.radius)}loadNearby()}};
  document.querySelectorAll("[data-filter]").forEach(b=>b.onclick=()=>{const k=b.dataset.filter;S.filters[k]=!S.filters[k];b.classList.toggle("on",S.filters[k]);drawInternal();drawExternal();renderNearList()});
  const input=$("#placeSearch");input.oninput=e=>{clearTimeout(S.searchTimer);const q=e.target.value.trim();if(q.length<2){$("#searchResults").classList.add("hidden");return}S.searchTimer=setTimeout(()=>searchPlaces(q),280)};$("#clearSearch").onclick=()=>{input.value="";$("#searchResults").classList.add("hidden")};
  renderNearList();if(S.me)loadNearby();
}
function renderNearList(){
  const el=$("#nearList");if(!el)return;const internal=(S.internalNearby||S.props.filter(p=>validCoord(p.lat,p.lon)&&S.me).sort((a,b)=>a.distance_m-b.distance_m)).filter(p=>validCoord(p.lat,p.lon)).filter(shouldShowInternal);const ext=S.filters.unvisited?S.external:[];
  $("#nearSummary").textContent=S.me?`${internal.length} team properties · ${ext.length} external places · ${S.externalProvider||""}`:"Enable GPS or tap the map to discover nearby places";
  const rows=[];internal.slice(0,30).forEach(p=>{const d=S.me?toolsDist(S.me.lat,S.me.lon,p.lat,p.lon):null;rows.push(`<div class="place-card" data-pid="${p.property_id}"><div class="place-head"><b>${esc(p.property_name)}</b>${statusPill(p.status||"dead")}</div><div class="distance">${d!=null?fmtD(d):""} · ${p.area||""} · ${p.property_type||""}</div>${p.requirement_detail?`<div class="meta" style="margin-top:5px">${esc(p.requirement_detail)}</div>`:""}<div class="place-actions"><button class="btn secondary small" data-open="${p.property_id}">Intelligence</button><button class="btn small" data-add="${p.property_id}">+ Plan</button></div></div>`)})
  ext.slice(0,30).forEach((p,i)=>{rows.push(`<div class="place-card" data-ext="${i}"><div class="place-head"><b>${esc(p.name)}</b><span class="pill external">${esc(p.type||"place")}</span></div><div class="distance">${p.distance_m!=null?fmtD(p.distance_m):""} · ${esc(p.address||"Not in team database")}</div><div class="place-actions"><button class="btn secondary small" data-external="${i}">Details</button><button class="btn small" data-extplan="${i}">+ Plan</button></div></div>`)})
  el.innerHTML=rows.join("")||empty(S.me?"No relevant places found in this radius.":"Tap ◎ to use GPS, or search for a place above.");
  el.querySelectorAll("[data-open]").forEach(b=>b.onclick=()=>openProperty(+b.dataset.open));el.querySelectorAll("[data-add]").forEach(b=>addToPlan(S.byId[+b.dataset.add]));el.querySelectorAll("[data-external]").forEach(b=>openExternal(S.external[+b.dataset.external]));el.querySelectorAll("[data-extplan]").forEach(b=>addExternalToPlan(S.external[+b.dataset.extplan]));
}
function toolsDist(a,b,c,d){const R=6371000,p1=a*Math.PI/180,p2=c*Math.PI/180,dp=(c-a)*Math.PI/180,dl=(d-b)*Math.PI/180,x=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;return 2*R*Math.asin(Math.sqrt(x))}
async function searchPlaces(q){
  const box=$("#searchResults");box.classList.remove("hidden");box.innerHTML=`<div class="search-item">Searching…</div>`;
  try{const d=await api(`/api/place-search?q=${encodeURIComponent(q)}${S.me?`&lat=${S.me.lat}&lon=${S.me.lon}`:""}`);const rows=[];(d.internal||[]).forEach(p=>rows.push(`<div class="search-item" data-pid="${p.property_id}"><b>${esc(p.property_name)}</b><div class="meta">Your team · ${esc(p.area||"")} · ${p.match_score?Math.round(p.match_score*100)+"% match":""}</div></div>`));(d.external||[]).forEach((p,i)=>{S._searchExternal=S._searchExternal||[];S._searchExternal[i]=p;rows.push(`<div class="search-item" data-sidx="${i}"><b>${esc(p.name)}</b><div class="meta">${esc(p.type||"Place")} · ${esc(p.address||"")}</div></div>`)});box.innerHTML=rows.join("")||`<div class="search-item">Nothing found.</div>`;box.querySelectorAll("[data-pid]").forEach(x=>x.onclick=()=>{box.classList.add("hidden");openProperty(+x.dataset.pid)});box.querySelectorAll("[data-sidx]").forEach(x=>x.onclick=()=>{box.classList.add("hidden");openExternal(S._searchExternal[+x.dataset.sidx])})}catch(e){box.innerHTML=`<div class="search-item">${esc(e.message)}</div>`}
}

/* ------------------------------ property */
async function openProperty(id){S.selectedProperty=id;S.previous.push(S.screen);setScreen("property",false);$("#screen-property").innerHTML=`<div class="screen-inner"><div class="loading">Loading property intelligence…</div></div>`;try{S.propertyDetail=await api(`/api/property/${id}`);renderProperty(id)}catch(e){$("#screen-property").innerHTML=`<div class="screen-inner"><div class="alert bad">${esc(e.message)}</div><button class="back" onclick="goBack()">← Back</button></div>`}}
function renderProperty(id){
  const d=S.propertyDetail;if(!d||!d.property)return;const p=d.property;const visits=d.visits||[];const last=visits[visits.length-1];
  $("#screen-property").innerHTML=`<div class="screen-inner"><div class="back-row"><button class="back" id="propertyBack">← Back</button><span class="muted">Property intelligence</span></div>
    <div class="property-hero"><div class="property-title"><h1>${esc(p.property_name)}</h1><p>${esc(p.area||"")} · ${esc(p.property_type||"commercial")} ${p.branch?`· ${esc(p.branch)}`:""}</p>${statusPill(statusOfProperty(visits))}</div><div class="property-actions"><button class="btn secondary" id="propertyPlan">+ Add to plan</button><button class="btn blue" id="propertyLog">Log visit</button>${p.latitude!=null?`<button class="btn secondary" id="propertyLocate">Show on map</button>`:""}</div></div>
    <div class="two-col"><div class="grid"><div class="card"><h3>Current intelligence</h3><div class="grid grid-2"><div><span class="meta">Latest requirement</span><b>${esc(last?.requirement_detail||"Not recorded")}</b></div><div><span class="meta">Contact</span><b>${esc(last?.contact_role||"Not recorded")}</b></div><div><span class="meta">Competitor</span><b>${esc(last?.competitor_vendor||"None recorded")}</b></div><div><span class="meta">Follow-up</span><b>${esc(last?.follow_up_state||"None")}</b></div></div></div><div class="card"><h3>Visit history · ${visits.length}</h3><div class="timeline">${visits.slice().reverse().map(v=>`<div class="visit-item"><b>${esc(v.rep)}</b> · ${esc(v.outcome_category)}</div><div class="visit-item" style="margin-top:-8px"><span class="date">${esc(v.visit_date||v.visit_month||"Unknown date")}</span><div>${esc(v.remarks||"")}</div>${v.requirement_detail?`<div class="meta">Requirement: ${esc(v.requirement_detail)}</div>`:""}${v.follow_up_state&&v.follow_up_state!=="none"?`<div class="meta">Follow-up: ${esc(v.follow_up_state)}</div>`:""}</div>`).join("")||empty("No visits yet.")}</div></div></div><div class="grid"><div class="card"><h3>Team</h3><p>${d.reps?.length?`${d.reps.length} rep${d.reps.length>1?"s":""} have worked this property.`:"No team visits yet."}</p>${(d.reps||[]).map(r=>`<span class="pill ${r===S.rep?"live":"external"}" style="margin:3px">${esc(r)}</span>`).join("")}</div><div class="card"><h3>Overlap / nearby intelligence</h3>${d.overlap?.already_visited_by_others?.length?`<div class="alert warn">Another rep has already worked this property. Review the history before a new visit.</div>${d.overlap.already_visited_by_others.map(x=>`<div class="list-row"><div><b>${esc(x.rep)}</b><div class="meta">${esc(x.date)} · ${esc(x.outcome)}</div></div></div>`).join("")}`:`<div class="alert good">No exact-property overlap recorded for this team.</div>`}</div><div class="card"><h3>Nearby internal properties</h3>${(d.nearby||[]).slice(0,6).map(n=>`<div class="list-row clickable" data-nearid="${n.property_id}"><div><b>${esc(n.property_name)}</b><div class="meta">${fmtD(n.distance_m)} · ${esc(n.area||"")}</div></div>${statusPill(statusOfProperty(n.visits||[]))}</div>`).join("")||empty("No nearby properties.")}</div></div></div></div>`;
  $("#propertyBack").onclick=goBack;$("#propertyPlan").onclick=()=>{addToPlan(p);setScreen("plan")};$("#propertyLog").onclick=()=>{S.prefillProperty=p;setScreen("log")};if($("#propertyLocate"))$("#propertyLocate").onclick=()=>{setScreen("near");setTimeout(()=>{initNearMap();if(p.latitude!=null){S.map.flyTo([p.latitude,p.longitude],17)}} ,80)};document.querySelectorAll("[data-nearid]").forEach(x=>x.onclick=()=>openProperty(+x.dataset.nearid));
}
function statusOfProperty(visits){const outs=new Set((visits||[]).map(v=>v.outcome_category));if(outs.has("ACTIVE_CLIENT")||outs.has("ACCOUNT_AT_RISK"))return"client";if([...outs].some(x=>["SPACE_SHORTAGE","DEMAND_CAPACITY_MISMATCH","OPERATIONAL_INEFFICIENCY","FUTURE_OPPORTUNITY","SITE_AVAILABLE"].includes(x)))return"live";if((visits||[]).some(v=>v.follow_up_state&&v.follow_up_state!=="none"&&v.follow_up_state!=="contact_shared"))return"pending";if(outs.has("COMPETITOR_LOCKED"))return"locked";if((visits||[]).some(v=>v.access_blocked))return"blocked";return"dead"}

/* ------------------------------ external */
function openExternal(p){
  S.externalSelected=p;showModal(`<div class="modal-head"><h2>${esc(p.name)}</h2><button class="close" id="closeModal">×</button></div><div class="external-info">${esc(p.type||"Place")} · ${esc(p.address||"")} · ${esc(p.source||"")}</div><div class="section-title">Status</div><div class="alert info">This place is outside the team property database. Add it only if it is relevant to your field work.</div><div class="actions"><button class="btn blue" id="addExternal">Add as property</button><button class="btn secondary" id="externalPlan">Add to plan</button>${p.google_maps_uri?`<a class="btn secondary" href="${esc(p.google_maps_uri)}" target="_blank" rel="noopener">Open Maps</a>`:""}</div>`);
  $("#closeModal").onclick=closeModal;$("#addExternal").onclick=()=>openAddProperty(p);$("#externalPlan").onclick=()=>{addExternalToPlan(p);closeModal()};
}
function addExternalToPlan(p){const x={name:p.name,lat:p.lat,lon:p.lon,external_id:p.external_id,type:p.type,source:p.source};if(!S.plan.some(q=>q.external_id&&q.external_id===x.external_id))S.plan.push(x);toast("Added to today’s plan");if(S.screen==="plan")renderPlan()}
function addToPlan(p){if(!p)return;const x={id:p.id||p.property_id,name:p.name||p.property_name,lat:p.lat??p.latitude,lon:p.lon??p.longitude,status:p.status,type:p.type||p.property_type};if(!x.lat){toast("This property has no coordinates");return}if(!S.plan.some(q=>q.id&&q.id===x.id))S.plan.push(x);toast("Added to today’s plan");if(S.screen==="plan")renderPlan()}
function openAddProperty(p){
  const lat=validCoord(p.lat,p.lon)?Number(p.lat):S.me?.lat,lon=validCoord(p.lat,p.lon)?Number(p.lon):S.me?.lon;showModal(`<div class="modal-head"><h2>Add property</h2><button class="close" id="closeModal">×</button></div><p class="muted">This will create a shared property record. You can log the first visit from Log.</p><div class="form-grid"><div class="field full"><label>Name</label><input id="newName" value="${esc(p.name||"")}"></div><div class="field"><label>Area</label><input id="newArea" value="${esc(p.address||"")}"></div><div class="field"><label>Type</label><select id="newType"><option value="tech_park">Tech Park</option><option value="coworking">Coworking</option><option value="business_park">Business Park</option><option value="corporate_office">Corporate Office</option><option value="commercial">Commercial</option></select></div><div class="field"><label>Latitude</label><input id="newLat" value="${lat??""}"></div><div class="field"><label>Longitude</label><input id="newLon" value="${lon??""}"></div></div><div class="actions" style="margin-top:14px"><button class="btn blue" id="saveNewProperty">Save to team database</button></div>`);$("#closeModal").onclick=closeModal;$("#saveNewProperty").onclick=async()=>{try{const d=await api("/api/property",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:$("#newName").value,area:$("#newArea").value,property_type:$("#newType").value,latitude:+$("#newLat").value,longitude:+$("#newLon").value,rep:S.rep})});closeModal();await reloadData();toast("Property added to the team database");openProperty(d.property_id)}catch(e){toast(e.message,5000)}}}

/* ------------------------------ Home */
function renderHome(){
  const due=S.followups.filter(x=>x.rep===S.rep);const opportunities=S.props.filter(p=>p.status==="live").length;const recent=S.activity||[];
  $("#screen-home").innerHTML=`<div class="screen-inner"><div class="page-head"><div><h1>Good ${new Date().getHours()<12?"morning":new Date().getHours()<17?"afternoon":"evening"}, ${esc(S.rep.split(" ")[0])}</h1><p>Here is what needs your attention today.</p></div><div class="actions"><button class="btn blue" id="homeNear">Explore Near Me</button><button class="btn secondary" id="homeAsk">Ask AI</button></div></div>
    <div class="grid grid-4"><div class="card kpi"><b>${opportunities}</b><span>Opportunities</span></div><div class="card kpi"><b>${due.length}</b><span>Your follow-ups</span></div><div class="card kpi"><b>${S.stats.properties||0}</b><span>Team properties</span></div><div class="card kpi"><b>${S.stats.visits||0}</b><span>Total visits</span></div></div>
    <div class="section-title">Priority actions</div><div class="grid grid-2"><div class="card"><h3>Follow-ups</h3>${due.slice(0,5).map(f=>`<div class="list-row clickable" data-fup="${f.property_id}"><div><b>${esc(f.property_name)}</b><div class="meta">${esc(f.follow_up_state)} · ${esc(f.visit_date||"")}</div></div><span class="pill pending">Due</span></div>`).join("")||empty("No open follow-ups assigned to you.")}</div><div class="card"><h3>Team intelligence</h3>${S.overlaps.slice(0,5).map(o=>`<div class="list-row clickable" data-ov="${o.property_id}"><div><b>${esc(o.property_name)}</b><div class="meta">${esc((o.reps||[]).join(", "))}</div></div><span class="pill locked">Overlap</span></div>`).join("")||empty("No overlap risks in the current data.")}</div></div>
    <div class="section-title">Recent activity</div><div class="card"><div id="homeActivity">Loading team activity…</div></div></div>`;
  $("#homeNear").onclick=()=>setScreen("near");$("#homeAsk").onclick=()=>setScreen("ask");document.querySelectorAll("[data-fup]").forEach(x=>x.onclick=()=>openProperty(+x.dataset.fup));document.querySelectorAll("[data-ov]").forEach(x=>x.onclick=()=>openProperty(+x.dataset.ov));loadActivity();
}
async function loadActivity(){try{const d=await api("/api/activity?limit=8");S.activity=d.activity||[];const el=$("#homeActivity");if(!el)return;el.innerHTML=S.activity.map(a=>`<div class="list-row"><div><b>${esc(a.property_name)}</b><div class="meta">${esc(a.rep)} · ${esc(a.outcome_category)} · ${esc(a.visit_date||"")}</div></div><span class="meta">${esc((a.remarks||"").slice(0,70))}</span></div>`).join("")||empty("No app activity yet.")}catch(e){}}

/* ------------------------------ Plan */
function renderPlan(){
  $("#screen-plan").innerHTML=`<div class="screen-inner"><div class="page-head"><div><h1>Today’s Plan</h1><p>${S.plan.length} selected stops. Add places from Near Me or property intelligence.</p></div><div class="actions"><button class="btn secondary" id="clearPlan">Clear</button><button class="btn blue" id="routePlan">Calculate route</button></div></div><div class="plan-layout"><div><div id="planMap" class="plan-map"><div class="map"></div></div></div><div class="card"><h3>Stops</h3><p class="drag-hint">The route is calculated from your current location. Google routing is used when configured; otherwise the app clearly labels estimates.</p><div id="planList" class="plan-list"></div><div id="routeSummary" style="margin-top:12px"></div></div></div></div>`;
  initPlanMap();drawPlanMap();renderPlanList();$("#clearPlan").onclick=()=>{S.plan=[];renderPlan()};$("#routePlan").onclick=calculateRoute;
}
function renderPlanList(){const el=$("#planList");el.innerHTML=S.plan.map((p,i)=>`<div class="plan-stop"><div class="stop-no">${i+1}</div><div style="min-width:0;flex:1"><b>${esc(p.name)}</b><div class="meta">${p.type||""} ${p.lat!=null?`· ${S.me?fmtD(toolsDist(S.me.lat,S.me.lon,p.lat,p.lon)):""}`:""}</div></div><button class="btn secondary small" data-remove="${i}">Remove</button></div>`).join("")||empty("Your plan is empty.");el.querySelectorAll("[data-remove]").forEach(b=>b.onclick=()=>{S.plan.splice(+b.dataset.remove,1);renderPlan()})}
async function calculateRoute(){if(!S.me){toast("Turn on GPS or set a location first");return}if(!S.plan.length){toast("Add at least one stop");return}try{$("#routeSummary").innerHTML=`<div class="loading">Calculating route…</div>`;const d=await api(`/api/route?origin_lat=${S.me.lat}&origin_lon=${S.me.lon}&mode=WALK&points=${encodeURIComponent(JSON.stringify(S.plan))}`);S.routeData=d;S.routeLayer.clearLayers();if(d.encoded_polyline){const pts=decodePolyline(d.encoded_polyline).filter(x=>validCoord(x[0],x[1]));if(pts.length>1){L.polyline(pts,{color:"#2563eb",weight:5,opacity:.85}).addTo(S.routeLayer);S.planMap.fitBounds(pts,{padding:[30,30]})}}else if(d.points){L.polyline(d.points,{color:"#2563eb",weight:5,opacity:.7,dashArray:"8 8"}).addTo(S.routeLayer)}const min=Math.round((d.duration_s||0)/60);$("#routeSummary").innerHTML=`<div class="alert ${d.provider==="estimate"?"warn":"good"}"><b>${fmtD(d.distance_m||0)}</b> · <b>${min} min</b><br><span>${esc(d.warning||`Routing provider: ${d.provider}`)}</span></div>`;if(d.optimized_order?.length){const original=[...S.plan];const order=[...d.optimized_order, d.optimized_order.length].map(i=>original[i]).filter(Boolean);S.plan=order;renderPlanList();drawPlanMap()}}catch(e){toast(e.message,5000)}}

/* ------------------------------ Log */
function renderLog(){
  $("#screen-log").innerHTML=`<div class="screen-inner"><div class="page-head"><div><h1>Log a visit</h1><p>Speak naturally or type. The system structures the note before anything is saved.</p></div></div><div class="grid grid-2"><div class="card"><h3>1. Capture what happened</h3><div class="voice-box"><button id="recordBtn" class="record-btn">●</button><div id="recordLabel" style="margin-top:8px;font-weight:700">Tap to record</div><div class="meta">Your browser microphone is used. Nothing is saved until you confirm.</div></div><div class="field" style="margin-top:12px"><label>Or type your note</label><textarea id="noteText" placeholder="Example: Visited ABC Tech Park. Facility manager said they need around 30 two-wheeler spaces and asked for a proposal."></textarea></div><div class="actions" style="margin-top:10px"><button id="extractText" class="btn blue">Understand note</button><button id="clearNote" class="btn secondary">Clear</button></div></div><div class="card"><h3>2. Review before saving</h3><div id="draftArea">${empty("Your structured draft will appear here.")}</div></div></div></div>`;
  if(S.prefillProperty)$("#noteText").value=`Visited ${S.prefillProperty.property_name}. `;$("#extractText").onclick=()=>extractNote($("#noteText").value);$("#clearNote").onclick=()=>{$("#noteText").value="";S.draft=null;$("#draftArea").innerHTML=empty("Your structured draft will appear here.")};$("#recordBtn").onclick=toggleRecording;
}
async function extractNote(text){if(!text.trim()){toast("Write or speak a note first");return}try{$("#draftArea").innerHTML=`<div class="loading">Understanding the note…</div>`;const d=await api("/api/extract",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({text})});await prepareDraft(d,text)}catch(e){$("#draftArea").innerHTML=`<div class="alert bad">${esc(e.message)}</div>`}}
async function prepareDraft(d,raw){
  const name=d.property_name||"";let matches=[];try{matches=(await api(`/api/search?q=${encodeURIComponent(name)}&limit=5`)).results||[]}catch{}
  const top=matches[0];const ambiguous=top&&matches[1]&&Math.abs((top.match_score||0)-(matches[1].match_score||0))<.08;
  S.draft={...d,raw,match:ambiguous?null:top||null,candidates:matches,newProperty:!top||((top.match_score||0)<.78),lat:S.me?.lat??null,lon:S.me?.lon??null,rep:S.rep,visit_date:today()};renderDraft();
}
function renderDraft(){const d=S.draft;if(!d)return;const matchLabel=d.newProperty?"New property — will be created":`Existing property — ${d.match.property_name}`;$("#draftArea").innerHTML=`<div class="confirm-box"><div class="alert ${d.newProperty?"info":"good"}"><b>${esc(matchLabel)}</b>${d.candidates?.length?`<div class="meta">Top match confidence: ${Math.round((d.match?.match_score||0)*100)}%</div>`:""}</div><div class="draft-grid"><div class="draft-item"><span>Property</span><b>${esc(d.property_name||"—")}</b></div><div class="draft-item"><span>Outcome</span><b>${esc(d.outcome_category||"—")}</b></div><div class="draft-item"><span>Requirement</span><b>${esc(d.requirement_detail||"—")}</b></div><div class="draft-item"><span>Contact</span><b>${esc(d.contact_role||"—")}</b></div><div class="draft-item"><span>Competitor</span><b>${esc(d.competitor_vendor||"—")}</b></div><div class="draft-item"><span>Follow-up</span><b>${esc(d.follow_up_state||"none")}</b></div><div class="draft-item" style="grid-column:1/-1"><span>Remarks</span><b>${esc(d.remarks||"—")}</b></div></div>${d.newProperty?`<div class="form-grid" style="margin-top:12px"><div class="field"><label>Area</label><input id="draftAreaInput" value=""></div><div class="field"><label>Property type</label><select id="draftType"><option value="tech_park">Tech Park</option><option value="coworking">Coworking</option><option value="business_park">Business Park</option><option value="corporate_office">Corporate Office</option><option value="commercial">Commercial</option></select></div><div class="field"><label>Latitude</label><input id="draftLat" value="${d.lat??""}"></div><div class="field"><label>Longitude</label><input id="draftLon" value="${d.lon??""}"></div></div>`:""}<div class="actions" style="margin-top:14px"><button class="btn blue" id="confirmDraft">✓ Confirm & Save</button><button class="btn secondary" id="editDraft">Edit note</button></div></div>`;
  $("#confirmDraft").onclick=confirmDraft;$("#editDraft").onclick=()=>$("#noteText").focus();
}
async function confirmDraft(){const d=S.draft;if(!d)return;try{const body={rep:S.rep,property_id:d.newProperty?null:d.match.id,new_property:d.newProperty,property_name:d.property_name,area:d.newProperty?$("#draftAreaInput")?.value||"":d.match?.area||"",property_type:d.newProperty?$("#draftType")?.value||"commercial":d.match?.type||"commercial",latitude:d.newProperty?Number($("#draftLat")?.value):S.me?.lat??null,longitude:d.newProperty?Number($("#draftLon")?.value):S.me?.lon??null,outcome_category:d.outcome_category,remarks:d.remarks||"",visit_date:d.visit_date||today(),requirement_detail:d.requirement_detail||"",competitor_vendor:d.competitor_vendor||"",pricing_note:d.pricing_note||"",contact_role:d.contact_role||"",follow_up_state:d.follow_up_state||"none",access_blocked:!!d.access_blocked};if(!validCoord(body.latitude,body.longitude)){delete body.latitude;delete body.longitude;}const result=await api("/api/field-entry",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});toast("Saved to the shared team database");S.draft=null;S.prefillProperty=null;await reloadData();openProperty(result.property_id||body.property_id)}catch(e){toast(e.message,6000)}}
async function toggleRecording(){if(S.recording){S.recorder?.stop();return}if(!navigator.mediaDevices?.getUserMedia){toast("Microphone recording is not supported in this browser");return}try{const stream=await navigator.mediaDevices.getUserMedia({audio:true});S.audioChunks=[];S.recorder=new MediaRecorder(stream);S.recording=true;$("#recordBtn").classList.add("recording");$("#recordLabel").textContent="Recording… tap to stop";S.recorder.ondataavailable=e=>{if(e.data.size)S.audioChunks.push(e.data)};S.recorder.onstop=async()=>{stream.getTracks().forEach(t=>t.stop());S.recording=false;$("#recordBtn").classList.remove("recording");$("#recordLabel").textContent="Processing voice note…";const blob=new Blob(S.audioChunks,{type:S.recorder.mimeType||"audio/webm"});try{const fd=new FormData();fd.append("audio",blob,"field-note.webm");const d=await api("/api/extract",{method:"POST",body:fd});$("#recordLabel").textContent="Voice note understood";await prepareDraft(d,"[voice note]")}catch(e){$("#recordLabel").textContent="Tap to record";toast(e.message,6000)}};S.recorder.start()}catch(e){toast("Microphone permission is required")}}

/* ------------------------------ Ask */
function renderAsk(){
  $("#screen-ask").innerHTML=`<div class="screen-inner"><div class="page-head"><div><h1>Ask</h1><p>Ask about places, people, nearby opportunities, follow-ups or what the team knows.</p></div></div><div class="ask-layout"><div class="card"><div class="quick-prompts"><button class="quick">Has anyone visited Orion Tech Park?</button><button class="quick">What is nearby that nobody visited?</button><button class="quick">What should I visit next?</button><button class="quick">What follow-ups are due?</button><button class="quick">Brief me on Orion Tech Park</button></div><div id="chat" class="chat"></div><div class="row" style="display:flex;gap:8px;margin-top:12px"><textarea id="askInput" style="flex:1;min-height:60px" placeholder="Ask anything about the field…"></textarea><button id="askSend" class="btn blue">Ask</button></div></div></div></div>`;
  document.querySelectorAll(".quick").forEach(b=>b.onclick=()=>{$("#askInput").value=b.textContent;askQuestion()});$("#askSend").onclick=askQuestion;
}
async function askQuestion(){const input=$("#askInput");const q=input.value.trim();if(!q)return;const chat=$("#chat");chat.insertAdjacentHTML("beforeend",`<div class="bubble user">${esc(q)}</div>`);input.value="";const holder=document.createElement("div");holder.className="bubble ai";holder.textContent="Thinking…";chat.appendChild(holder);try{const d=await api("/api/ask",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({question:q,rep:S.rep})});holder.innerHTML=`${esc(d.answer||d.response||JSON.stringify(d))}${d.trace?`<div class="trace">${esc(d.trace.join(" · "))}</div>`:""}`}catch(e){holder.innerHTML=`<div class="alert bad">${esc(e.message)}</div>`}chat.scrollTop=chat.scrollHeight}

/* ------------------------------ Team */
async function renderTeam(){
  $("#screen-team").innerHTML=`<div class="screen-inner"><div class="page-head"><div><h1>Team</h1><p>Shared intelligence across all four reps.</p></div><button class="btn secondary" id="teamRefresh">Refresh</button></div><div id="teamContent" class="loading">Loading team intelligence…</div></div>`;
  try{const d=await api("/api/team");S.team=d;const byRep={};S.props.forEach(p=>(p.reps||[]).forEach(r=>byRep[r]=(byRep[r]||0)+p.visits));const cov=Object.entries(d.coverage||{}).sort((a,b)=>b[1].total-a[1].total).slice(0,10);$("#teamContent").innerHTML=`<div class="grid grid-4">${S.reps.map(r=>`<div class="card kpi"><b>${byRep[r]||0}</b><span>${esc(r.split(" ")[0])} visits</span></div>`).join("")}</div><div class="section-title">Open follow-ups</div><div class="card">${(d.followups||[]).slice(0,12).map(f=>`<div class="list-row clickable" data-team-pid="${f.property_id}"><div><b>${esc(f.property_name)}</b><div class="meta">${esc(f.rep)} · ${esc(f.follow_up_state)} · ${esc(f.visit_date||"")}</div></div><span class="pill pending">Follow-up</span></div>`).join("")||empty("No open follow-ups.")}</div><div class="section-title">Coverage by area</div><div class="card">${cov.map(([a,x])=>`<div class="list-row"><div><b>${esc(a)}</b><div class="meta">${x.visited} visited / ${x.total} properties</div></div><b>${x.total?Math.round(x.visited/x.total*100):0}%</b></div>`).join("")}</div><div class="section-title">Overlap risks</div><div class="card">${(d.overlaps||[]).map(o=>`<div class="list-row clickable" data-team-pid="${o.property_id}"><div><b>${esc(o.property_name)}</b><div class="meta">${esc((o.reps||[]).join(", "))}</div></div><span class="pill locked">Overlap</span></div>`).join("")||empty("No overlap risks.")}</div>`;document.querySelectorAll("[data-team-pid]").forEach(x=>x.onclick=()=>openProperty(+x.dataset.teamPid));$("#teamRefresh").onclick=()=>renderTeam()}catch(e){$("#teamContent").innerHTML=`<div class="alert bad">${esc(e.message)}</div>`}}

/* ------------------------------ modal */
function showModal(html){$("#modalRoot").innerHTML=`<div class="modal-backdrop"><div class="modal">${html}</div></div>`}
function closeModal(){$("#modalRoot").innerHTML=""}

window.addEventListener("resize",()=>{S.map?.invalidateSize();S.planMap?.invalidateSize()});
window.addEventListener("popstate",()=>goBack());

boot();
