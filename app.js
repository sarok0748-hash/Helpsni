function formatMoney(value){return new Intl.NumberFormat("cs-CZ").format(Number(value))+" Kč";}
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.4/+esm';

const PLATFORM_FEE = 0.10;
const MAX_CHAT_IMAGE_BYTES = 1_500_000;
let configured = false;
let supabase = null;

function isPublicSupabaseKey(key = '') {
  return typeof key === 'string' && (key.startsWith('sb_publishable_') || key.startsWith('eyJ'));
}

async function configureSupabase() {
  try {
    const response = await fetch('/api/config', { cache: 'no-store' });
    if (response.ok) {
      const config = await response.json();
      if (config?.url?.startsWith('https://') && isPublicSupabaseKey(config?.key)) {
        supabase = createClient(config.url, config.key);
        configured = true;
        return;
      }
    }
  } catch (error) {
    console.warn('Vercel config není dostupný:', error);
  }

  const savedUrl = localStorage.getItem('helpsni_supabase_url') || 'https://ffiuzcrjunzthgredrqu.supabase.co';
  const savedKey = localStorage.getItem('helpsni_supabase_key') || '';
  if (savedUrl.startsWith('https://') && isPublicSupabaseKey(savedKey)) {
    supabase = createClient(savedUrl, savedKey);
    configured = true;
  }
}

let state = { currentUser: null, jobs: [], messages: [], ratings: [] };
let screen = 'landing';
let roleMode = 'customer';
let activeSection = 'overview';
let selectedJobId = null;
let jobFilter = 'active';
let realtimeChannel = null;

function el(id) { return document.getElementById(id); }
function money(value) { return new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'CZK', maximumFractionDigits: 0 }).format(Number(value || 0)); }
function escapeHtml(s='') { return String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function currentUser() { return state.currentUser; }
function jobById(id) { return state.jobs.find(j => j.id === id); }
function statusLabel(status) { return ({open:'Otevřená',accepted:'Přijatá',in_progress:'Probíhá',completed:'Čeká na potvrzení',archived:'Archivovaná',cancelled:'Zrušená'})[status] || status; }
function paymentLabel(status) { return ({unpaid:'Nezaplaceno',reserved:'Rezervováno',released:'Vyplaceno',refunded:'Vráceno'})[status] || status; }
function paymentMethodLabel(method) { return ({apple_pay:'Apple Pay',google_pay:'Google Pay',card:'Platební karta'})[method] || '—'; }
function formatTime(iso) { return new Intl.DateTimeFormat('cs-CZ',{hour:'2-digit',minute:'2-digit'}).format(new Date(iso)); }
function averageRating(userId) {
  const list = state.ratings.filter(r => r.toUserId === userId);
  return list.length ? list.reduce((sum,r)=>sum+r.stars,0)/list.length : 0;
}
function dbJob(row){ return { id:row.id, createdAt:row.created_at, acceptedAt:row.accepted_at, completedAt:row.completed_at, customerId:row.customer_id, workerId:row.worker_id, title:row.title, description:row.description, category:row.category, city:row.city, address:row.address, price:Number(row.price), status:row.status, paymentStatus:row.payment_status||'unpaid', paymentMethod:row.payment_method||null }; }
function dbMessage(row){ return { id:row.id, createdAt:row.created_at, jobId:row.job_id, senderId:row.sender_id, body:row.body||'', imageData:row.image_data||null, readAt:row.read_at||null }; }
function dbRating(row){ return { id:row.id, jobId:row.job_id, fromUserId:row.author_id, toUserId:row.target_id, stars:Number(row.rating), comment:row.comment||'', createdAt:row.created_at }; }
function dbProfile(row, email){ return { id:row.id, name:row.full_name||'', email:email||'', role:row.role||'customer', phone:row.phone||'', city:row.city||'', bankAccount:row.bank_account||'' }; }
function showError(error, fallback='Něco se nepovedlo.') { console.error(error); alert(error?.message || fallback); }
async function loadData(){
  if(!supabase || !state.currentUser) return;
  const [{data:jobs,error:je},{data:messages,error:me},{data:reviews,error:re}] = await Promise.all([
    supabase.from('jobs').select('*').order('created_at',{ascending:false}),
    supabase.from('messages').select('*').order('created_at',{ascending:true}),
    supabase.from('reviews').select('*').order('created_at',{ascending:true})
  ]);
  if(je) throw je; if(me) throw me; if(re) throw re;
  state.jobs=(jobs||[]).map(dbJob); state.messages=(messages||[]).map(dbMessage); state.ratings=(reviews||[]).map(dbRating);
}
async function loadProfile(authUser){
  let {data,error}=await supabase.from('profiles').select('*').eq('id',authUser.id).maybeSingle();
  if(error) throw error;
  if(!data){
    const fullName=authUser.user_metadata?.full_name || authUser.email?.split('@')[0] || 'Uživatel';
    const city=authUser.user_metadata?.city || 'Neuvedeno';
    const role=authUser.user_metadata?.role || 'customer';
    const result=await supabase.from('profiles').insert({id:authUser.id,full_name:fullName,city,role}).select().single();
    if(result.error) throw result.error; data=result.data;
  }
  state.currentUser=dbProfile(data,authUser.email);
  roleMode=state.currentUser.role==='worker'?'worker':'customer';
}
async function refreshAll(){ try { await loadData(); render(); } catch(error){ showError(error,'Nepodařilo se načíst data.'); } }
async function init(){
  await configureSupabase();
  if(!configured){
    // Když konfigurace ještě není dostupná, návštěvník vždy uvidí normální úvodní stránku.
    // Nastavovací obrazovka se veřejně nikdy nezobrazuje.
    screen='landing';
    render();
    return;
  }
  const {data:{session}}=await supabase.auth.getSession();
  if(session?.user){ await loadProfile(session.user); await loadData(); subscribeRealtime(); }
  supabase.auth.onAuthStateChange(async (_event,sessionNow)=>{
    if(sessionNow?.user){ await loadProfile(sessionNow.user); await loadData(); subscribeRealtime(); }
    else { state={currentUser:null,jobs:[],messages:[],ratings:[]}; screen='landing'; }
    render();
  });
  render();
}
function subscribeRealtime(){
  if(!supabase || realtimeChannel) return;
  realtimeChannel=supabase.channel('helpsni-live')
    .on('postgres_changes',{event:'*',schema:'public',table:'jobs'},refreshAll)
    .on('postgres_changes',{event:'*',schema:'public',table:'messages'},refreshAll)
    .on('postgres_changes',{event:'*',schema:'public',table:'reviews'},refreshAll)
    .subscribe();
}
function notifyUser(title, body, data={}) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if ('serviceWorker' in navigator) navigator.serviceWorker.ready.then(reg => reg.showNotification(title, { body, icon: 'icon-192.png', badge: 'favicon.png', data })).catch(() => new Notification(title,{body,icon:'icon-192.png'}));
  else new Notification(title, { body, icon: 'icon-192.png' });
}
async function requestNotifications() {
  if (!('Notification' in window)) return alert('Tento prohlížeč oznámení nepodporuje.');
  const result = await Notification.requestPermission();
  if (result === 'granted') notifyUser('Helpsni', 'Oznámení jsou zapnutá.');
  render();
}
function render() {
  const root = el('app');
  if (!state.currentUser) root.innerHTML = screen === 'auth' ? authView() : landingView();
  else root.innerHTML = dashboardView();
  bindEvents();
}


function setupView(){ return `<main class="auth-page"><section class="auth-card"><div class="mini-brand"><img src="logo-icon.png" alt=""/> Helpsni</div><h1>Propojit Helpsni se Supabase</h1><p>Vložte veřejný Publishable key. Je bezpečný pro použití ve webu. Secret key sem nikdy nevkládejte.</p><form id="setupForm"><label>Project URL<input name="url" required value="https://ffiuzcrjunzthgredrqu.supabase.co" /></label><label>Publishable key<input name="key" required placeholder="sb_publishable_..." /></label><button type="submit">Uložit a spustit</button></form><p class="muted">Pro všechna zařízení nastavte stejné hodnoty také ve Vercelu jako SUPABASE_URL a SUPABASE_PUBLISHABLE_KEY.</p></section></main>`; }

function landingView() {
  const openJobs = (state.jobs || []).filter(job => job.status === 'open').slice(0, 3);
  const liveJobs = openJobs.length ? openJobs : [
    { title: 'Úklid bytu', city: 'Praha', price: 850, category: 'Úklid', demo: true },
    { title: 'Stěhování', city: 'Brno', price: 2500, category: 'Stěhování', demo: true },
    { title: 'Montáž nábytku', city: 'Plzeň', price: 1300, category: 'Montáž nábytku', demo: true }
  ];
  const todayJobs = (state.jobs || []).filter(job => {
    if (!job.createdAt) return false;
    const created = new Date(job.createdAt);
    const now = new Date();
    return created.toDateString() === now.toDateString();
  }).length;
  const liveStripText = todayJobs > 0
    ? `🟢 Dnes přidáno ${todayJobs} zakázek • Helpsni funguje po celé ČR`
    : '🟢 Helpsni je připravené po celé ČR • Přidejte první zakázku během pár minut';
  const categoryIcon = category => ({
    'Úklid':'🧹','Stěhování':'🚚','Montáž nábytku':'🪑','Malování':'🎨',
    'Zahrada':'🌿','Elektro práce':'⚡','Instalatér':'🚰','Garáže':'🚗'
  }[category] || '🛠️');
  const liveJobCards = liveJobs.map(job => `
    <article class="live-job-card">
      <span class="live-job-icon">${categoryIcon(job.category)}</span>
      <div><strong>${escapeHtml(job.title)}</strong><span>${escapeHtml(job.city || 'Česká republika')}</span></div>
      <b>${formatMoney(job.price)}</b>
      ${job.demo ? '<small>Ukázka</small>' : '<small>Nová</small>'}
    </article>`).join('');

  return `
    <div class="live-strip"><span>${liveStripText}</span></div>
    <header class="topbar">
      <button class="brand plain" data-action="home"><img src="logo-icon.png" alt="Logo Helpsni" />Helpsni</button>
      <nav><a href="#jak">Jak to funguje</a><a href="#kategorie">Kategorie</a><a href="#bezpecnost">Bezpečnost</a><a href="#platby">Platby</a></nav>
      <div class="header-actions"><button class="ghost" data-action="auth">Přihlásit se</button><button data-action="auth">Registrovat</button></div>
    </header>
    <main>
      <section class="hero">
        <div class="hero-copy">
          <div class="eyebrow"><i></i> POMOC I PRÁCE NA JEDNOM MÍSTĚ</div>
          <h1>Potřebujete pomoc s prací doma nebo kolem domu?</h1>
          <p><strong>Helpsni spojuje zákazníky s pracovníky po celé České republice.</strong> Stačí zadat zakázku, nastavit cenu a pracovníci ve vašem okolí ji mohou přijmout.</p>
          <div class="hero-actions"><button data-action="auth">Zadat zakázku</button><button class="dark" data-action="auth">Chci pracovat</button></div>
          <div class="stats"><div><strong>4,9/5</strong><span>hodnocení</span></div><div><strong>Celá ČR</strong><span>dostupnost</span></div><div><strong>Rychle</strong><span>bez čekání</span></div></div>
        </div>
        <div class="mascot-zone" aria-label="Příklady prací na Helpsni">
          <div class="task-bubble task-clean">🧹 <b>Úklid</b></div>
          <div class="task-bubble task-garage">🚗 <b>Garáže</b></div>
          <div class="task-bubble task-moving">🚚 <b>Stěhování</b></div>
          <div class="task-bubble task-paint">🎨 <b>Malování</b></div>
          <div class="task-bubble task-garden">🌿 <b>Zahrada</b></div>
          <div class="task-bubble task-furniture">🪑 <b>Montáž nábytku</b></div>
          <div class="task-bubble task-repair">🔧 <b>Drobné opravy</b></div>
          <div class="task-bubble task-clearing">📦 <b>Vyklízení</b></div>
          <div class="task-bubble task-electric">⚡ <b>Elektro práce</b></div>
          <img class="animated-mascot" src="mascot.png" alt="Maskot Helpsni" />
        </div>
      </section>

      <section class="trust-strip" aria-label="Proč lidé důvěřují Helpsni">
        <article><span>⭐</span><div><strong>Hodnocení pracovníků</strong><small>Recenze po dokončení práce</small></div></article>
        <article><span>💬</span><div><strong>Bezpečný chat</strong><small>Domluva přímo v aplikaci</small></div></article>
        <article><span>🔒</span><div><strong>Bezpečné platby</strong><small>Platba přes platformu</small></div></article>
        <article><span>📱</span><div><strong>Mobil i počítač</strong><small>Funguje na všech zařízeních</small></div></article>
        <article><span>✅</span><div><strong>Ověření pracovníci</strong><small>Bez občanky a selfie s doklady</small></div></article>
      </section>

      <section class="landing-grid">
        <div class="how-panel" id="jak">
          <div class="landing-section-head"><span>JAK TO FUNGUJE</span><h2>Tři jednoduché kroky</h2></div>
          <div class="steps compact-steps">
            <article><b>1</b><h3>Zadejte zakázku</h3><p>Popište práci, město a rozpočet.</p></article>
            <article><b>2</b><h3>Pracovník ji přijme</h3><p>Zakázku uvidí lidé připravení pomoci.</p></article>
            <article><b>3</b><h3>Domluvte se</h3><p>Po přijetí se zpřístupní chat.</p></article>
          </div>
        </div>
        <aside class="live-jobs-panel">
          <div class="landing-section-head inline"><div><span>📍 PRÁVĚ PŘIDANÉ</span><h2>Nové zakázky</h2></div><i>Živě</i></div>
          <div class="live-job-list">${liveJobCards}</div>
          <button class="plain live-jobs-link" data-action="auth">Zobrazit všechny zakázky →</button>
        </aside>
      </section>

      <section class="categories-section" id="kategorie">
        <div class="landing-section-head"><span>NEJČASTĚJŠÍ PRÁCE</span><h2>S čím vám může Helpsni pomoct?</h2></div>
        <div class="category-grid">
          ${[
            ['🧹','Úklid'],['🚚','Stěhování'],['🪑','Montáž nábytku'],['🎨','Malování'],
            ['🌿','Zahrada'],['⚡','Elektro práce'],['🚰','Instalatér'],['🚗','Garáže']
          ].map(([icon,label]) => `<button class="category-card" data-action="auth"><span>${icon}</span><b>${label}</b><small>Zobrazit zakázky</small></button>`).join('')}
        </div>
      </section>

      <section class="info" id="bezpecnost"><h2>Bezpečně a přehledně</h2><p>Přesná adresa se pracovníkovi zobrazí až po přijetí zakázky. Ověření pracovníka nikdy nevyžaduje občanku ani selfie s doklady.</p></section>
      <section class="info" id="platby"><h2>Apple Pay, Google Pay a karta</h2><p>Platební obrazovky a logika jsou připravené v testovacím režimu. Ostré platby se později připojí k platební bráně.</p></section>
    </main>`;
}

function authView() {
  return `
    <main class="auth-page"><section class="auth-card">
      <button class="close-x" data-action="home">×</button>
      <div class="mini-brand"><img src="logo-icon.png" alt="" /> Helpsni</div>
      <h1>Přihlášení nebo registrace</h1>
      <p>Účet bude fungovat na mobilu i počítači.</p>
      <form id="authForm">
        <label>Jméno <small>(jen při registraci)</small><input name="name" placeholder="Např. Milan" /></label>
        <label>Město <small>(jen při registraci)</small><input name="city" placeholder="Např. Žatec" /></label>
        <label>E-mail<input name="email" type="email" required placeholder="email@example.cz" /></label>
        <label>Heslo<input name="password" type="password" minlength="6" required placeholder="Alespoň 6 znaků" /></label>
        <label>Výchozí režim<select name="role"><option value="customer">Zákazník</option><option value="worker">Pracovník</option></select></label>
        <div class="split"><button type="submit" name="mode" value="signin">Přihlásit</button><button type="submit" class="dark" name="mode" value="signup">Registrovat</button></div>
      </form>
    </section></main>`;
}

function dashboardView() {
  const user = currentUser();
  const myCustomerJobs = state.jobs.filter(j => j.customerId === user.id);
  const myWorkerJobs = state.jobs.filter(j => j.workerId === user.id);
  const openJobs = state.jobs.filter(j => j.status === 'open' && j.customerId !== user.id);
  const activeWorkerJobs = myWorkerJobs.filter(j => ['accepted','in_progress','completed'].includes(j.status));
  const releasedWorkerJobs = myWorkerJobs.filter(j => j.paymentStatus === 'released');
  const workerEarnings = releasedWorkerJobs.reduce((s,j)=>s+Number(j.price)*(1-PLATFORM_FEE),0);
  const profileComplete = Boolean(user.name && user.email && user.phone && user.city && user.bankAccount);
  const unreadMessages = state.messages.filter(m => {
    const job = jobById(m.jobId);
    return job && m.senderId !== user.id && !m.readAt && (job.customerId === user.id || job.workerId === user.id);
  }).length;

  return `
    <div class="app-shell">
      <aside>
        <div class="profile-head"><span>${escapeHtml(user.name.charAt(0).toUpperCase())}</span><div><b>${escapeHtml(user.name)}</b><small>${roleMode === 'worker' ? 'Pracovník' : 'Zákaznický účet'}</small></div></div>
        ${navButton('overview','Přehled')}
        ${navButton('jobs','Zakázky')}
        ${navButton('messages',`Zprávy <em>${unreadMessages}</em>`)}
        ${navButton('payments','Platby')}
        ${navButton('profile','Profil')}
        <button class="logout" data-action="logout">Odhlásit</button>
      </aside>
      <section class="workspace">
        <div class="role-switch"><button class="${roleMode==='customer'?'selected':''}" data-role="customer">Jsem zákazník</button><button class="${roleMode==='worker'?'selected':''}" data-role="worker">Jsem pracovník</button></div>
        ${notificationBanner()}
        ${renderSection({user,myCustomerJobs,myWorkerJobs,openJobs,activeWorkerJobs,workerEarnings,profileComplete})}
      </section>
      <nav class="mobile-nav" aria-label="Hlavní navigace">
        ${mobileNavButton('overview','Přehled','⌂')}
        ${mobileNavButton('jobs','Zakázky','▣')}
        ${mobileNavButton('messages','Zprávy','✉',unreadMessages)}
        ${mobileNavButton('payments','Platby','Kč')}
        ${mobileNavButton('profile','Profil','●')}
      </nav>
    </div>
    ${selectedJobId ? jobModal() : ''}`;
}
function navButton(section,label){ return `<button class="${activeSection===section?'active':''}" data-section="${section}">${label}</button>`; }
function mobileNavButton(section,label,icon,badge=0){ return `<button class="${activeSection===section?'active':''}" data-section="${section}"><span>${icon}${badge?`<i>${badge}</i>`:''}</span><small>${label}</small></button>`; }
function notificationBanner(){
  if (!('Notification' in window) || Notification.permission === 'granted') return '';
  return `<div class="notice"><div><b>Zapnout oznámení</b><span>Upozornění na přijetí zakázky, zprávy a změny stavu.</span></div><button data-action="notifications">Povolit</button></div>`;
}
function renderSection(ctx){
  if (activeSection === 'jobs') return jobsSection(ctx);
  if (activeSection === 'messages') return messagesSection(ctx);
  if (activeSection === 'payments') return paymentsSection(ctx);
  if (activeSection === 'profile') return profileSection(ctx);
  return overviewSection(ctx);
}
function overviewSection(ctx){
  return `
    <div class="page-head"><div><span>${roleMode==='worker'?'PANEL PRACOVNÍKA':'ZÁKAZNICKÝ PANEL'}</span><h1>${roleMode==='worker'?'Vyberte si zakázku':'Co potřebujete udělat?'}</h1></div>${roleMode==='customer'?'<button data-action="new-job">+ Přidat zakázku</button>':''}</div>
    ${roleMode==='customer' ? `
      <div class="metric-grid two">
        <article><span>Moje aktivní zakázky</span><strong>${ctx.myCustomerJobs.filter(j=>['open','accepted','in_progress','completed'].includes(j.status)).length}</strong></article>
        <article><span>Nepřečtené zprávy</span><strong>${unreadForUser(ctx.user.id)}</strong><small>Chat se otevře po přijetí zakázky.</small></article>
      </div>` : `
      <div class="metric-grid three">
        <article><span>Dostupné</span><strong>${ctx.openJobs.length}</strong></article>
        <article><span>Aktivní</span><strong>${ctx.activeWorkerJobs.length}</strong></article>
        <article><span>Vyplaceno</span><strong>${money(ctx.workerEarnings)}</strong><small>Po odečtení provize 10 %.</small></article>
      </div>`}
    <section class="job-section"><div class="section-title"><span>${roleMode==='worker'?'ZAKÁZKY V OKOLÍ':'VAŠE AKTIVITA'}</span><h2>${roleMode==='worker'?'Nové nabídky':'Moje zakázky'}</h2></div><div class="job-list">${overviewJobs(ctx)}</div></section>`;
}
function unreadForUser(userId){
  return state.messages.filter(m=>m.senderId!==userId&&!m.readAt&&(() => { const j=jobById(m.jobId); return j&&(j.customerId===userId||j.workerId===userId); })()).length;
}
function overviewJobs(ctx){
  const jobs = roleMode==='worker' ? [...ctx.openJobs, ...ctx.activeWorkerJobs].slice(0,6) : ctx.myCustomerJobs.filter(j=>j.status!=='archived').slice(0,6);
  return jobs.length ? jobs.map(jobCard).join('') : '<div class="empty">Zatím tu nejsou žádné zakázky.</div>';
}
function jobsSection(ctx){
  const jobs = roleMode==='worker' ? [...ctx.openJobs, ...ctx.myWorkerJobs] : ctx.myCustomerJobs;
  const filtered = jobFilter === 'active' ? jobs.filter(j=>['open','accepted','in_progress','completed'].includes(j.status)) : jobs.filter(j=>['archived','cancelled'].includes(j.status));
  return `<div class="page-head"><div><span>ZAKÁZKY</span><h1>${roleMode==='worker'?'Práce pro vás':'Vaše zakázky'}</h1></div>${roleMode==='customer'?'<button data-action="new-job">+ Přidat zakázku</button>':''}</div>
  <div class="tabs"><button class="${jobFilter==='active'?'active':''}" data-filter="active">Aktivní</button><button class="${jobFilter==='archive'?'active':''}" data-filter="archive">Archiv</button></div>
  <section class="job-section compact"><div class="job-list">${filtered.length?filtered.map(jobCard).join(''):'<div class="empty">V této části nejsou žádné zakázky.</div>'}</div></section>`;
}
function messagesSection(ctx){
  const relatedJobs = state.jobs.filter(j => (j.customerId===ctx.user.id || j.workerId===ctx.user.id) && ['accepted','in_progress','completed','archived'].includes(j.status));
  return `<div class="page-head"><div><span>ZPRÁVY</span><h1>Konverzace</h1></div></div>
  <div class="conversation-list">${relatedJobs.length?relatedJobs.map(j=>conversationCard(j,ctx.user.id)).join(''):'<div class="empty">Chat se zpřístupní po přijetí zakázky.</div>'}</div>`;
}
function conversationCard(job,userId){
  const msgs = state.messages.filter(m=>m.jobId===job.id);
  const last = msgs.at(-1);
  const unread = msgs.filter(m=>m.senderId!==userId&&!m.readAt).length;
  return `<article class="conversation-card" data-job="${job.id}"><div class="conversation-main"><span class="tag">${statusLabel(job.status)}</span><h3>${escapeHtml(job.title)}</h3><p>${last ? (last.imageData?'📷 Fotografie':escapeHtml(last.body||'')) : 'Zatím žádné zprávy'}</p></div><div class="conversation-meta">${unread?`<b>${unread}</b>`:''}<span>${last?formatTime(last.createdAt):''}</span></div></article>`;
}
function paymentsSection(ctx){
  const jobs = roleMode==='worker' ? ctx.myWorkerJobs : ctx.myCustomerJobs;
  const reserved = jobs.filter(j=>j.paymentStatus==='reserved').reduce((s,j)=>s+Number(j.price),0);
  const released = jobs.filter(j=>j.paymentStatus==='released').reduce((s,j)=>s+Number(j.price),0);
  return `<div class="page-head"><div><span>PLATBY</span><h1>${roleMode==='worker'?'Výplaty':'Vaše platby'}</h1></div></div>
  <div class="test-badge">TESTOVACÍ REŽIM — skutečné peníze se nyní nestrhávají</div>
  ${roleMode==='worker'?`<div class="metric-grid two"><article><span>Vyplaceno po provizi</span><strong>${money(released*(1-PLATFORM_FEE))}</strong></article><article><span>Rezervované odměny</span><strong>${money(reserved*(1-PLATFORM_FEE))}</strong></article></div>`:`<div class="metric-grid two"><article><span>Rezervované platby</span><strong>${money(reserved)}</strong></article><article><span>Dokončené platby</span><strong>${money(released)}</strong></article></div>`}
  <section class="payment-methods"><h2>Podporované metody</h2><div><span> Apple Pay</span><span>G Pay Google Pay</span><span>💳 Platební karta</span></div><p>Provize Helpsni: <b>10 %</b> z odměny pracovníka.</p></section>
  <section class="job-section compact"><div class="job-list">${jobs.length?jobs.map(paymentJobCard).join(''):'<div class="empty">Zatím tu nejsou žádné platby.</div>'}</div></section>`;
}
function paymentJobCard(job){
  return `<article class="job-card" data-job="${job.id}"><div><span class="tag">${paymentLabel(job.paymentStatus)}</span><h3>${escapeHtml(job.title)}</h3><p>${paymentMethodLabel(job.paymentMethod)} · ${statusLabel(job.status)}</p></div><strong>${money(job.price)}</strong></article>`;
}
function profileSection(ctx){
  const badge = ctx.profileComplete ? '<span class="verified-badge">✓ Ověřený pracovník</span>' : '<span class="pending-badge">Profil není dokončený</span>';
  const rating = averageRating(ctx.user.id);
  return `<div class="page-head"><div><span>PROFIL</span><h1>${escapeHtml(ctx.user.name)}</h1></div></div>
  <div class="profile-card"><div class="profile-status">${badge}${rating?`<span class="rating-summary">★ ${rating.toFixed(1)}</span>`:''}</div>
    <form id="profileForm" class="profile-form">
      <label>Jméno<input name="name" required value="${escapeHtml(ctx.user.name||'')}" /></label>
      <label>E-mail<input name="email" type="email" required value="${escapeHtml(ctx.user.email||'')}" readonly /></label>
      <label>Telefon<input name="phone" value="${escapeHtml(ctx.user.phone||'')}" placeholder="+420 777 000 000" /></label>
      <label>Město<input name="city" value="${escapeHtml(ctx.user.city||'')}" placeholder="Např. Žatec" /></label>
      <label>Účet pro výplatu<input name="bankAccount" value="${escapeHtml(ctx.user.bankAccount||'')}" placeholder="123456789/0100" /></label>
      <button type="submit">Uložit profil</button>
    </form>
    <div class="verification-list"><p><b>Ověření pracovníka:</b></p><p>${ctx.user.email?'✓':'○'} E-mail</p><p>${ctx.user.phone?'✓':'○'} Telefon</p><p>${ctx.user.name&&ctx.user.city?'✓':'○'} Vyplněný profil</p><p>${ctx.user.bankAccount?'✓':'○'} Účet pro výplatu</p><p class="muted">Občanka, selfie ani jiné osobní doklady se nikdy nevyžadují.</p></div>
    ${ratingsList(ctx.user.id)}
  </div>`;
}
function ratingsList(userId){
  const list=state.ratings.filter(r=>r.toUserId===userId).slice().reverse();
  return `<div class="ratings-list"><h3>Hodnocení</h3>${list.length?list.map(r=>`<article><b>${'★'.repeat(r.stars)}${'☆'.repeat(5-r.stars)}</b><p>${escapeHtml(r.comment||'Bez komentáře')}</p></article>`).join(''):'<p class="muted">Zatím bez hodnocení.</p>'}</div>`;
}
function jobCard(job) {
  const badges = [`<span class="tag">${escapeHtml(job.category)}</span>`];
  if(job.paymentStatus==='reserved') badges.push('<span class="payment-chip">Platba rezervována</span>');
  return `<article class="job-card" data-job="${job.id}"><div><div class="card-badges">${badges.join('')}</div><h3>${escapeHtml(job.title)}</h3><p>${escapeHtml(job.city)} · ${statusLabel(job.status)}</p></div><strong>${money(job.price)}</strong></article>`;
}
function jobModal() {
  const job = jobById(selectedJobId);
  if (!job) return '';
  const user = currentUser();
  const isCustomer = job.customerId === user.id;
  const isWorker = job.workerId === user.id;
  const participant = isCustomer || isWorker;
  const canAccept = roleMode === 'worker' && job.status === 'open' && !isCustomer;
  const canEditDelete = isCustomer && job.status === 'open';
  const canReserve = isCustomer && ['accepted','in_progress'].includes(job.status) && job.paymentStatus==='unpaid';
  const canRate = participant && job.status==='archived' && !state.ratings.some(r=>r.jobId===job.id&&r.fromUserId===user.id);
  const messages = state.messages.filter(m => m.jobId === job.id);
  if(participant) {
    const unreadIds=messages.filter(m=>m.senderId!==user.id&&!m.readAt).map(m=>m.id);
    if(unreadIds.length) supabase.rpc('mark_job_messages_read',{job_uuid:job.id}).then(()=>refreshAll());
  }
  return `<div class="modal-backdrop"><section class="modal job-detail-modal">
    <button class="close-x" data-action="close-modal">×</button>
    <span class="tag">${escapeHtml(job.category)}</span><h2>${escapeHtml(job.title)}</h2>
    <p>${escapeHtml(job.description)}</p><div class="detail-grid"><p><b>Město:</b> ${escapeHtml(job.city)}</p><p><b>Stav:</b> ${statusLabel(job.status)}</p><p><b>Platba:</b> ${paymentLabel(job.paymentStatus)}</p><p><b>Metoda:</b> ${paymentMethodLabel(job.paymentMethod)}</p></div>
    ${participant && job.status!=='open'?`<p><b>Adresa:</b> ${escapeHtml(job.address)} <a class="map-link" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(job.address)}">Otevřít mapu</a></p>`:''}
    <p class="price">${money(job.price)}</p>
    <div class="modal-actions">
      ${canAccept?'<button data-action="accept-job">Přijmout zakázku</button>':''}
      ${canEditDelete?'<button class="ghost" data-action="edit-job">Upravit</button><button class="danger" data-action="delete-job">Smazat</button>':''}
      ${canReserve?'<button data-action="open-payment">Rezervovat platbu</button>':''}
      ${isWorker && job.status==='accepted'?'<button data-action="start-job">Začít práci</button>':''}
      ${isWorker && job.status==='in_progress'?'<button data-action="complete-job">Označit jako dokončenou</button>':''}
      ${isCustomer && job.status==='completed'?'<button data-action="archive-job">Potvrdit, uvolnit platbu a archivovat</button>':''}
      ${canRate?'<button class="ghost" data-action="open-rating">Přidat hodnocení</button>':''}
    </div>
    ${participant && ['accepted','in_progress','completed','archived'].includes(job.status)?chatView(messages,user):''}
  </section></div>`;
}
function chatView(messages,user){
  return `<div class="chat"><h3>Chat</h3><div class="messages" id="messagesBox">${messages.map(m=>messageBubble(m,user)).join('')||'<small>Zatím žádné zprávy.</small>'}</div>
  <form id="chatForm" class="chat-compose"><label class="photo-button" title="Přidat fotografii">📷<input id="chatPhoto" name="photo" type="file" accept="image/*" /></label><input name="message" placeholder="Napište zprávu…"/><button>Odeslat</button></form><div id="photoPreview" class="photo-preview"></div></div>`;
}
function messageBubble(m,user){
  const mine=m.senderId===user.id;
  return `<div class="message-wrap ${mine?'mine':''}"><div class="message-bubble">${m.imageData?`<img src="${m.imageData}" alt="Fotografie v chatu"/>`:''}${m.body?`<p>${escapeHtml(m.body)}</p>`:''}<small>${formatTime(m.createdAt)}${mine?` · ${m.readAt?'Přečteno':'Odesláno'}`:''}</small></div></div>`;
}
function newJobModal(job=null) {
  const edit = Boolean(job);
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop" id="tempModal"><section class="modal"><button class="close-x" data-action="remove-temp">×</button><h2>${edit?'Upravit zakázku':'Nová zakázka'}</h2><form id="jobForm">
    <input type="hidden" name="id" value="${edit?job.id:''}"/>
    <label>Název práce<input name="title" required value="${edit?escapeHtml(job.title):''}" placeholder="Např. vymalovat pokoj"/></label>
    <label>Kategorie<select name="category">${['Úklid','Malování','Stěhování','Montáž','Zahrada','IT servis','Elektro','Instalatér','Jiné'].map(c=>`<option ${edit&&job.category===c?'selected':''}>${c}</option>`).join('')}</select></label>
    <label>Popis<textarea name="description" required placeholder="Co přesně potřebujete?">${edit?escapeHtml(job.description):''}</textarea></label>
    <div class="split"><label>Město<input name="city" required value="${edit?escapeHtml(job.city):''}"/></label><label>Cena Kč<input name="price" type="number" min="1" required value="${edit?job.price:''}"/></label></div>
    <label>Přesná adresa<input name="address" required value="${edit?escapeHtml(job.address):''}"/><small>Zobrazí se až po přijetí zakázky.</small></label>
    <button>${edit?'Uložit změny':'Publikovat zakázku'}</button>
  </form></section></div>`);
  bindEvents();
}
function paymentModal(){
  const job=jobById(selectedJobId);
  document.body.insertAdjacentHTML('beforeend',`<div class="modal-backdrop" id="paymentModal"><section class="modal"><button class="close-x" data-action="remove-payment">×</button><span class="test-badge">TESTOVACÍ PLATBA</span><h2>Rezervovat ${money(job.price)}</h2><p>Peníze budou v ostré verzi uvolněny pracovníkovi až po potvrzení dokončení. Provize Helpsni je 10 % z odměny pracovníka.</p><form id="paymentForm" class="payment-form"><label><input type="radio" name="method" value="apple_pay" required/>  Apple Pay</label><label><input type="radio" name="method" value="google_pay"/> G Pay Google Pay</label><label><input type="radio" name="method" value="card"/> 💳 Platební karta</label><button>Potvrdit testovací rezervaci</button></form></section></div>`);
  bindEvents();
}
function ratingModal(){
  document.body.insertAdjacentHTML('beforeend',`<div class="modal-backdrop" id="ratingModal"><section class="modal"><button class="close-x" data-action="remove-rating">×</button><h2>Ohodnotit spolupráci</h2><form id="ratingForm"><label>Počet hvězdiček<select name="stars">${[5,4,3,2,1].map(n=>`<option value="${n}">${n} ${n===1?'hvězdička':'hvězdiček'}</option>`).join('')}</select></label><label>Komentář<textarea name="comment" maxlength="500" placeholder="Jak spolupráce proběhla?"></textarea></label><button>Odeslat hodnocení</button></form></section></div>`);
  bindEvents();
}
function bindEvents() {
  document.querySelectorAll('[data-action="auth"]').forEach(b=>b.onclick=()=>{screen='auth';render();});
  document.querySelectorAll('[data-action="home"]').forEach(b=>b.onclick=()=>{screen='landing';render();});
  document.querySelectorAll('[data-action="logout"]').forEach(b=>b.onclick=async()=>{await supabase.auth.signOut();});
  document.querySelectorAll('[data-role]').forEach(b=>b.onclick=()=>{roleMode=b.dataset.role;activeSection='overview';render();});
  document.querySelectorAll('[data-section]').forEach(b=>b.onclick=()=>{activeSection=b.dataset.section;render();});
  document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{jobFilter=b.dataset.filter;render();});
  document.querySelectorAll('[data-action="new-job"]').forEach(b=>b.onclick=()=>newJobModal());
  document.querySelectorAll('[data-job]').forEach(card=>card.onclick=()=>{selectedJobId=card.dataset.job;render();requestAnimationFrame(()=>{const box=el('messagesBox');if(box)box.scrollTop=box.scrollHeight;});});
  document.querySelectorAll('[data-action="close-modal"]').forEach(b=>b.onclick=()=>{selectedJobId=null;render();});
  document.querySelectorAll('[data-action="remove-temp"]').forEach(b=>b.onclick=()=>el('tempModal')?.remove());
  document.querySelectorAll('[data-action="remove-payment"]').forEach(b=>b.onclick=()=>el('paymentModal')?.remove());
  document.querySelectorAll('[data-action="remove-rating"]').forEach(b=>b.onclick=()=>el('ratingModal')?.remove());
  document.querySelectorAll('[data-action="notifications"]').forEach(b=>b.onclick=requestNotifications);
  document.querySelectorAll('[data-action="accept-job"]').forEach(b=>b.onclick=async()=>{const {error}=await supabase.rpc('accept_job',{job_uuid:selectedJobId});if(error)return showError(error,'Zakázku se nepodařilo přijmout.');notifyUser('Zakázka přijata',jobById(selectedJobId)?.title||'Zakázka');await refreshAll();});
  document.querySelectorAll('[data-action="edit-job"]').forEach(b=>b.onclick=()=>{const job=jobById(selectedJobId);selectedJobId=null;render();newJobModal(job);});
  document.querySelectorAll('[data-action="delete-job"]').forEach(b=>b.onclick=async()=>{const job=jobById(selectedJobId);if(job&&confirm('Opravdu chcete zakázku smazat?')){const {error}=await supabase.from('jobs').delete().eq('id',job.id).eq('customer_id',currentUser().id).eq('status','open');if(error)return showError(error);selectedJobId=null;await refreshAll();}});
  document.querySelectorAll('[data-action="open-payment"]').forEach(b=>b.onclick=paymentModal);
  document.querySelectorAll('[data-action="open-rating"]').forEach(b=>b.onclick=ratingModal);
  document.querySelectorAll('[data-action="start-job"]').forEach(b=>b.onclick=()=>updateJobStatus('in_progress'));
  document.querySelectorAll('[data-action="complete-job"]').forEach(b=>b.onclick=()=>updateJobStatus('completed'));
  document.querySelectorAll('[data-action="archive-job"]').forEach(b=>b.onclick=()=>updateJobStatus('archived',true));

  const authForm=el('authForm');
  if(authForm) authForm.onsubmit=async e=>{
    e.preventDefault(); const fd=new FormData(authForm); const submitter=e.submitter?.value||'signin';
    const email=String(fd.get('email')).trim().toLowerCase(), password=String(fd.get('password'));
    if(submitter==='signup'){
      const name=String(fd.get('name')||'').trim(), city=String(fd.get('city')||'').trim();
      if(!name||!city)return alert('Při registraci vyplňte jméno a město.');
      const {data,error}=await supabase.auth.signUp({email,password,options:{data:{full_name:name,city,role:fd.get('role')}}});
      if(error)return showError(error);
      if(!data.session) alert('Registrace proběhla. Potvrďte e-mail a potom se přihlaste.');
    } else {
      const {error}=await supabase.auth.signInWithPassword({email,password}); if(error)return showError(error,'Přihlášení se nepovedlo.');
    }
  };
  const profileForm=el('profileForm');
  if(profileForm) profileForm.onsubmit=async e=>{e.preventDefault();const fd=new FormData(profileForm);const {data,error}=await supabase.from('profiles').update({full_name:String(fd.get('name')).trim(),phone:String(fd.get('phone')).trim()||null,city:String(fd.get('city')).trim(),bank_account:String(fd.get('bankAccount')).trim()||null}).eq('id',currentUser().id).select().single();if(error)return showError(error);state.currentUser=dbProfile(data,currentUser().email);render();alert('Profil byl uložen.');};
  const jobForm=el('jobForm');
  if(jobForm) jobForm.onsubmit=async e=>{e.preventDefault();const fd=new FormData(jobForm);const id=fd.get('id');const payload={title:String(fd.get('title')).trim(),category:fd.get('category'),description:String(fd.get('description')).trim(),city:String(fd.get('city')).trim(),address:String(fd.get('address')).trim(),price:Number(fd.get('price'))};let error;if(id){({error}=await supabase.from('jobs').update(payload).eq('id',id).eq('customer_id',currentUser().id).eq('status','open'));}else{({error}=await supabase.from('jobs').insert({...payload,customer_id:currentUser().id}));}if(error)return showError(error);el('tempModal')?.remove();activeSection='jobs';await refreshAll();};
  const paymentForm=el('paymentForm');
  if(paymentForm) paymentForm.onsubmit=async e=>{e.preventDefault();const fd=new FormData(paymentForm);const {error}=await supabase.rpc('reserve_job_payment',{job_uuid:selectedJobId,payment_method_value:fd.get('method')});if(error)return showError(error);el('paymentModal')?.remove();await refreshAll();};
  const ratingForm=el('ratingForm');
  if(ratingForm) ratingForm.onsubmit=async e=>{e.preventDefault();const job=jobById(selectedJobId),user=currentUser();const targetId=job.customerId===user.id?job.workerId:job.customerId;if(!targetId)return;const fd=new FormData(ratingForm);const {error}=await supabase.from('reviews').insert({job_id:job.id,author_id:user.id,target_id:targetId,rating:Number(fd.get('stars')),comment:String(fd.get('comment')||'').trim()||null});if(error)return showError(error);el('ratingModal')?.remove();await refreshAll();};
  const photoInput=el('chatPhoto');
  if(photoInput) photoInput.onchange=()=>{const file=photoInput.files?.[0],preview=el('photoPreview');if(!file){preview.innerHTML='';return;}if(file.size>MAX_CHAT_IMAGE_BYTES){alert('Fotografie je příliš velká. Maximum je přibližně 1,5 MB.');photoInput.value='';return;}const reader=new FileReader();reader.onload=()=>preview.innerHTML=`<img src="${reader.result}" alt="Náhled fotografie"/><span>${escapeHtml(file.name)}</span>`;reader.readAsDataURL(file);};
  const chatForm=el('chatForm');
  if(chatForm) chatForm.onsubmit=async e=>{e.preventDefault();const fd=new FormData(chatForm),text=String(fd.get('message')||'').trim(),file=fd.get('photo');if(!text&&(!file||!file.size))return;let imageData=null;if(file&&file.size){if(file.size>MAX_CHAT_IMAGE_BYTES)return alert('Fotografie je příliš velká.');imageData=await fileToDataUrl(file);}const {error}=await supabase.from('messages').insert({job_id:selectedJobId,sender_id:currentUser().id,body:text||null,image_data:imageData});if(error)return showError(error);await refreshAll();requestAnimationFrame(()=>{const box=el('messagesBox');if(box)box.scrollTop=box.scrollHeight;});};
}
async function updateJobStatus(status,release=false){const fn=status==='in_progress'?'start_job':status==='completed'?'complete_job':status==='archived'?'archive_job':null;if(!fn)return;const {error}=await supabase.rpc(fn,{job_uuid:selectedJobId});if(error)return showError(error);await refreshAll();}
function fileToDataUrl(file){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(file);});}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('service-worker.js').catch(()=>{});
init();
