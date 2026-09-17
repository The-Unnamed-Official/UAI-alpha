(() => {
  'use strict';

  const AUTH_KEY = 'unai_local_accounts_v1';
  const SESSION_KEY = 'unai_local_session_v1';
  const LEGACY_KEY = 'unai_state_v4';
  const DEFAULT_API_URL = window.UNAI_API_URL || 'https://unai-alpha.bbrraaggee.workers.dev/api/chat';
  const MAX_MESSAGE = 24000;
  const MODELS = {
    'openai/gpt-oss-20b': { id:'openai/gpt-oss-20b', name:'UnAI Flash', short:'Fast', description:'Quick, capable responses for everyday work.', icon:'zap' },
    'openai/gpt-oss-120b': { id:'openai/gpt-oss-120b', name:'UnAI Pro', short:'Reasoning', description:'Higher-capability model for difficult tasks.', icon:'brain-circuit' }
  };

  const $ = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => [...r.querySelectorAll(s)];
  const uid = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const now = () => Date.now();
  const escapeHtml = (value='') => String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  let auth = loadAuth();
  let activeAccount = null;
  let state = null;
  let streamController = null;
  let streamMessageId = null;
  let activePopover = null;
  let pendingRenameId = null;
  let confirmResolver = null;

  function refreshIcons(root=document){ if(window.lucide?.createIcons) window.lucide.createIcons({attrs:{'aria-hidden':'true'},root}); }
  function normalizeEmail(v=''){ return String(v).trim().toLowerCase(); }
  function validEmail(v){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
  function profileStoreKey(accountId){ return `unai_profile_${accountId}_v1`; }

  function loadAuth(){
    try {
      const parsed = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null');
      if(parsed?.version === 1 && parsed.accounts) return parsed;
    } catch {}
    return {version:1, accounts:{}};
  }
  function saveAuth(){ localStorage.setItem(AUTH_KEY, JSON.stringify(auth)); }

  function defaultState(account){
    return {
      version:1,
      profile:{name:account?.name || 'Unnamed', avatar:account?.avatar || ''},
      theme:'obsidian', model:'openai/gpt-oss-20b', conversations:{}, order:[], activeId:null,
      settings:{apiUrl:DEFAULT_API_URL,temperature:.7,customInstructions:'',compactMode:false,reducedMotion:false,enterToSend:true,showTimestamps:true}
    };
  }

  function loadUserState(account){
    const key = profileStoreKey(account.id);
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || 'null');
      if(parsed?.version === 1){
        const base = defaultState(account);
        return {...base,...parsed,profile:{...base.profile,...parsed.profile},settings:{...base.settings,...parsed.settings}};
      }
    } catch {}
    const fresh = defaultState(account);
    // Preserve work from the previous UnAI redesign when the first local account is created.
    if(!localStorage.getItem('unai_legacy_migrated_v1')){
      try {
        const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null');
        if(legacy && typeof legacy === 'object'){
          fresh.profile = {...fresh.profile,...(legacy.profile||{})};
          fresh.theme = legacy.theme || fresh.theme;
          fresh.model = MODELS[legacy.model] ? legacy.model : fresh.model;
          fresh.conversations = legacy.conversations || {};
          fresh.order = Array.isArray(legacy.order) ? legacy.order : [];
          fresh.activeId = legacy.activeId || fresh.order[0] || null;
          fresh.settings = {...fresh.settings,...(legacy.settings||{})};
          localStorage.setItem('unai_legacy_migrated_v1','1');
        }
      } catch {}
    }
    return fresh;
  }
  function saveState(){
    if(!activeAccount || !state) return;
    try { localStorage.setItem(profileStoreKey(activeAccount.id), JSON.stringify(state)); }
    catch(err){ toast('Storage is full','UnAI could not save all local changes.','triangle-alert'); }
  }

  async function derivePassword(password, saltBase64){
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const salt = saltBase64 ? Uint8Array.from(atob(saltBase64), c=>c.charCodeAt(0)) : crypto.getRandomValues(new Uint8Array(16));
    const bits = await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt,iterations:120000}, key, 256);
    const hash = btoa(String.fromCharCode(...new Uint8Array(bits)));
    const encodedSalt = btoa(String.fromCharCode(...salt));
    return {hash,salt:encodedSalt};
  }

  function sessionPayload(){
    try {
      const local = JSON.parse(localStorage.getItem(SESSION_KEY)||'null');
      if(local?.accountId) return local;
      const session = JSON.parse(sessionStorage.getItem(SESSION_KEY)||'null');
      if(session?.accountId) return session;
    } catch {}
    return null;
  }
  function setSession(accountId, remember){
    const payload = JSON.stringify({accountId,createdAt:now()});
    localStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(SESSION_KEY);
    (remember ? localStorage : sessionStorage).setItem(SESSION_KEY,payload);
  }
  function clearSession(){ localStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(SESSION_KEY); }

  function passwordScore(v=''){
    return [v.length>=8,/[A-Z]/.test(v),/[a-z]/.test(v),/\d/.test(v),/[^A-Za-z0-9]/.test(v),v.length>=12].filter(Boolean).length;
  }

  function setAuthTab(tab){
    const isLogin = tab === 'login';
    $$('[data-auth-tab]').forEach(b=>{ const a=b.dataset.authTab===tab; b.classList.toggle('active',a); b.setAttribute('aria-selected',a?'true':'false'); });
    $('#login-form').classList.toggle('hidden',!isLogin); $('#register-form').classList.toggle('hidden',isLogin);
    $('#auth-title').textContent = isLogin ? 'Welcome back' : 'Create your local profile';
    $('#auth-subtitle').textContent = isLogin ? 'Sign in to your local UnAI profile.' : 'Set up a realistic browser-only account for this device.';
    clearAuthErrors();
    setTimeout(()=>$(isLogin?'#login-email':'#register-name')?.focus(),50);
  }
  function clearAuthErrors(){ $$('.field-error').forEach(e=>e.textContent=''); }
  function setError(id,text){ const el=$(id); if(el) el.textContent=text; }
  function setButtonBusy(btn,busy,label){
    if(!btn) return; btn.disabled=busy;
    if(busy) btn.dataset.original = btn.querySelector('span')?.textContent || '';
    const span=btn.querySelector('span'); if(span) span.textContent=busy ? label : (btn.dataset.original||span.textContent);
  }

  async function registerAccount(e){
    e.preventDefault(); clearAuthErrors();
    const name=$('#register-name').value.trim(); const email=normalizeEmail($('#register-email').value); const pass=$('#register-password').value; const confirm=$('#register-confirm').value;
    let bad=false;
    if(name.length<2){setError('#register-name-error','Enter at least 2 characters.');bad=true;}
    if(!validEmail(email)){setError('#register-email-error','Enter a valid email address.');bad=true;}
    if(auth.accounts[email]){setError('#register-email-error','A local profile with this email already exists on this device.');bad=true;}
    if(pass.length<8 || !/[A-Z]/.test(pass) || !/\d/.test(pass)){setError('#register-password-error','Use at least 8 characters with an uppercase letter and a number.');bad=true;}
    if(pass!==confirm){setError('#register-confirm-error','Passwords do not match.');bad=true;}
    if(!$('#register-terms').checked){setError('#register-terms-error','Confirm the local-only profile notice and project license.');bad=true;}
    if(bad) return;
    const btn=$('#register-submit'); setButtonBusy(btn,true,'Creating profile…');
    try{
      const derived=await derivePassword(pass);
      const account={id:uid(),name,email,avatar:'',salt:derived.salt,passwordHash:derived.hash,createdAt:now(),lastLogin:now()};
      auth.accounts[email]=account; saveAuth(); setSession(account.id,true); activeAccount=account; state=loadUserState(account); state.profile.name=name; saveState();
      await sleep(250); enterApp(); toast('Profile created',`Welcome to UnAI, ${name}.`,'badge-check');
    }catch(err){setError('#register-password-error','This browser could not create the local credential.');}
    finally{setButtonBusy(btn,false,'');}
  }

  async function loginAccount(e){
    e.preventDefault(); clearAuthErrors();
    const email=normalizeEmail($('#login-email').value); const pass=$('#login-password').value; let bad=false;
    if(!validEmail(email)){setError('#login-email-error','Enter a valid email address.');bad=true;}
    if(!pass){setError('#login-password-error','Enter your password.');bad=true;}
    if(bad) return;
    const account=auth.accounts[email];
    const btn=$('#login-submit'); setButtonBusy(btn,true,'Signing in…');
    await sleep(220);
    if(!account){ setButtonBusy(btn,false,''); setError('#login-email-error','No local profile with this email exists on this device.'); return; }
    try{
      const derived=await derivePassword(pass,account.salt);
      if(derived.hash!==account.passwordHash){ setButtonBusy(btn,false,''); setError('#login-password-error','Incorrect password. Try again.'); return; }
      account.lastLogin=now(); saveAuth(); setSession(account.id,$('#remember-me').checked); activeAccount=account; state=loadUserState(account); enterApp();
    }catch{setError('#login-password-error','Unable to verify this local credential.');}
    finally{setButtonBusy(btn,false,'');}
  }

  function findAccountById(id){ return Object.values(auth.accounts).find(a=>a.id===id) || null; }
  function tryRestoreSession(){ const s=sessionPayload(); if(!s) return false; const a=findAccountById(s.accountId); if(!a){clearSession();return false;} activeAccount=a; state=loadUserState(a); return true; }
  function showAuth(){
    closeAllMenus(); closeAllModals(); $('#app-shell').classList.add('hidden'); $('#auth-gate').classList.remove('hidden'); document.body.dataset.theme='obsidian';
    $('#login-password').value=''; setAuthTab('login'); refreshIcons();
  }
  function enterApp(){
    $('#auth-gate').classList.add('hidden'); $('#app-shell').classList.remove('hidden');
    if(!state.activeId || !state.conversations[state.activeId]) state.activeId=state.order.find(id=>state.conversations[id])||null;
    applyPreferences(); renderAll(); syncSettingsForm(); refreshIcons(); autosizeComposer();
    setTimeout(()=>$('#composer-input')?.focus(),80);
  }
  function logout(){ if(streamController) streamController.abort(); clearSession(); activeAccount=null; state=null; showAuth(); toast('Signed out','Your local data remains on this device.','log-out'); }

  function applyPreferences(){
    document.body.dataset.theme=state?.theme||'obsidian';
    document.body.dataset.compact=String(!!state?.settings?.compactMode);
    document.body.dataset.reducedMotion=String(!!state?.settings?.reducedMotion);
    $$('.theme-choice').forEach(b=>b.classList.toggle('active',b.dataset.theme===state?.theme));
  }

  function currentConversation(){ return state?.activeId ? state.conversations[state.activeId] : null; }
  function createConversation(title='New chat',focus=true){
    const id=uid(); state.conversations[id]={id,title,createdAt:now(),updatedAt:now(),messages:[]}; state.order=[id,...state.order.filter(x=>x!==id)]; state.activeId=id; saveState(); renderAll(); closeSidebar(); if(focus)setTimeout(()=>$('#composer-input')?.focus(),30); return id;
  }
  function ensureConversation(){ return currentConversation() ? state.activeId : createConversation('New chat',false); }
  function autoTitle(text){ const clean=text.replace(/\s+/g,' ').trim(); return clean.length>48?`${clean.slice(0,48).trim()}…`:clean||'New chat'; }
  function groupLabel(ts){ const d=new Date(ts);const t=new Date();const today=new Date(t.getFullYear(),t.getMonth(),t.getDate()).getTime();const day=new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime();const diff=Math.round((today-day)/86400000); if(diff<=0)return'Today';if(diff===1)return'Yesterday';if(diff<7)return'Previous 7 days';if(diff<30)return'Previous 30 days';return'Older'; }
  function formatTime(ts){ try{return new Intl.DateTimeFormat(undefined,{hour:'2-digit',minute:'2-digit'}).format(new Date(ts));}catch{return'';} }

  function renderSidebar(){
    const list=$('#conversation-list'); if(!list)return; const q=($('#conversation-search').value||'').trim().toLowerCase(); list.innerHTML='';
    const groups=new Map();
    for(const id of state.order){ const c=state.conversations[id]; if(!c)continue; if(q && !c.title.toLowerCase().includes(q) && !c.messages.some(m=>String(m.content).toLowerCase().includes(q)))continue; const g=groupLabel(c.updatedAt||c.createdAt);if(!groups.has(g))groups.set(g,[]);groups.get(g).push(c); }
    if(!groups.size){list.innerHTML=`<div style="padding:28px 14px;color:var(--muted);font-size:9px;text-align:center">${q?'No conversations match your search.':'No conversations yet.'}</div>`;return;}
    for(const [g,convs] of groups){const label=document.createElement('div');label.className='sidebar-section-label';label.textContent=g;list.append(label);for(const c of convs){const row=document.createElement('div');row.className=`conversation-row${c.id===state.activeId?' active':''}`;row.tabIndex=0;row.innerHTML=`<span class="spark"></span><span class="conversation-title" title="${escapeHtml(c.title)}">${escapeHtml(c.title)}</span><span class="conversation-actions"><button class="conversation-action rename-conv" type="button" aria-label="Rename"><i data-lucide="pencil"></i></button><button class="conversation-action danger delete-conv" type="button" aria-label="Delete"><i data-lucide="trash-2"></i></button></span>`;
      row.addEventListener('click',ev=>{if(ev.target.closest('button'))return;state.activeId=c.id;saveState();renderAll();closeSidebar();});row.addEventListener('keydown',ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();state.activeId=c.id;saveState();renderAll();}});
      $('.rename-conv',row).addEventListener('click',ev=>{ev.stopPropagation();openRename(c.id);});$('.delete-conv',row).addEventListener('click',async ev=>{ev.stopPropagation();if(ev.shiftKey||await confirmAction('Delete this conversation?','The messages will be permanently removed from this local profile.','Delete conversation')){delete state.conversations[c.id];state.order=state.order.filter(x=>x!==c.id);if(state.activeId===c.id)state.activeId=state.order[0]||null;saveState();renderAll();}});list.append(row);}}
    refreshIcons(list);
  }

  function avatarHtml(className='profile-avatar'){
    if(state.profile.avatar)return`<span class="${className}"><img src="${escapeHtml(state.profile.avatar)}" alt=""></span>`;
    return`<span class="${className}"><i data-lucide="user-round"></i></span>`;
  }
  function renderProfile(){
    const btn=$('#profile-button'); if(btn)btn.innerHTML=`${avatarHtml()}<span class="profile-meta"><span class="profile-name">${escapeHtml(state.profile.name)}</span><span class="profile-status">${escapeHtml(activeAccount.email)} · Local profile</span></span><i data-lucide="chevrons-up-down"></i>`;
    $('#profile-menu-head').innerHTML=`${avatarHtml()}<div><strong>${escapeHtml(state.profile.name)}</strong><span>${escapeHtml(activeAccount.email)}</span></div>`;
    $('#settings-avatar').innerHTML=state.profile.avatar?`<img src="${escapeHtml(state.profile.avatar)}" alt="">`:'<i data-lucide="user-round"></i>';
    $('#account-card').innerHTML=`${avatarHtml()}<div><strong>${escapeHtml(state.profile.name)}</strong><span>${escapeHtml(activeAccount.email)} · Created ${new Date(activeAccount.createdAt).toLocaleDateString()}</span></div>`;
    refreshIcons();
  }
  function renderModel(){ const m=MODELS[state.model]||MODELS[Object.keys(MODELS)[0]];$('#model-button').innerHTML=`<span class="model-orb"><i data-lucide="${m.icon}"></i></span><span class="model-copy"><strong>${m.name}</strong><small>${m.short}</small></span><i data-lucide="chevron-down"></i>`;refreshIcons($('#model-button')); }
  function setStatus(text,type='ready'){const chip=$('#status-chip');chip.classList.toggle('busy',type==='busy');chip.classList.toggle('error',type==='error');$('.status-text',chip).textContent=text;}

  function markdown(text){
    try{if(window.marked&&window.DOMPurify){const renderer=new marked.Renderer();renderer.code=({text,lang})=>`<div class="code-block"><div class="code-head"><span>${escapeHtml(lang||'code')}</span><button class="code-copy" type="button">Copy</button></div><pre><code>${escapeHtml(text)}</code></pre></div>`;return DOMPurify.sanitize(marked.parse(String(text||''),{renderer,gfm:true,breaks:true}),{ADD_ATTR:['target']});}}catch{}
    return escapeHtml(text).replace(/\n/g,'<br>');
  }
  function messageHtml(m,isStreaming=false){
    const user=m.role==='user'; const avatar=user?(state.profile.avatar?`<span class="message-avatar"><img src="${escapeHtml(state.profile.avatar)}" alt=""></span>`:`<span class="message-avatar"><i data-lucide="user-round"></i></span>`):`<span class="message-avatar"><img src="unai.png" alt="UnAI"></span>`;
    const tools=user?`<button class="message-tool copy-message" type="button" title="Copy"><i data-lucide="copy"></i></button>`:`<button class="message-tool copy-message" type="button" title="Copy"><i data-lucide="copy"></i></button><button class="message-tool regenerate-message" type="button" title="Regenerate"><i data-lucide="refresh-cw"></i></button>`;
    return `<article class="message ${user?'user':'assistant'}" data-message-id="${m.id}">${avatar}<div class="message-main"><div class="message-head"><span class="message-name">${user?escapeHtml(state.profile.name):'UnAI'}</span>${state.settings.showTimestamps?`<span class="message-time">${formatTime(m.at)}</span>`:''}</div><div class="message-body">${markdown(m.content)}${isStreaming?'<span class="typing-cursor"></span>':''}</div><div class="message-tools">${tools}</div></div></article>`;
  }
  function emptyStateHtml(){return `<div class="empty-state"><div class="empty-state-inner"><div class="empty-logo"><img src="unai.png" alt=""></div><h1>What can I help with?</h1><p>Start a conversation, work through code, explore an idea or turn a rough thought into something useful.</p><div class="prompt-grid"><button class="prompt-card" data-prompt="Explain a difficult concept in a clear, practical way: "><i data-lucide="brain"></i><strong>Learn something</strong><span>Break down a difficult concept</span></button><button class="prompt-card" data-prompt="Help me build this from scratch with a clean, robust implementation: "><i data-lucide="code-2"></i><strong>Build something</strong><span>Plan and implement a project</span></button><button class="prompt-card" data-prompt="Review this carefully, find problems, and improve it without changing what already works:\n\n"><i data-lucide="scan-search"></i><strong>Review work</strong><span>Find issues and improve quality</span></button><button class="prompt-card" data-prompt="Brainstorm original ideas for: "><i data-lucide="lightbulb"></i><strong>Brainstorm</strong><span>Generate thoughtful directions</span></button></div></div></div>`;}
  function renderChat(){
    const host=$('#chat-inner'); const c=currentConversation(); if(!c||!c.messages.length){host.innerHTML=emptyStateHtml();$$('.prompt-card',host).forEach(b=>b.addEventListener('click',()=>usePrompt(b.dataset.prompt)));refreshIcons(host);return;}
    host.innerHTML=`<div class="message-list">${c.messages.map(m=>messageHtml(m,m.id===streamMessageId)).join('')}</div>`;
    $$('.copy-message',host).forEach(b=>b.addEventListener('click',async()=>{const id=b.closest('.message').dataset.messageId;const m=c.messages.find(x=>x.id===id);if(m){await navigator.clipboard.writeText(m.content);toast('Copied','Message copied to clipboard.','copy');}}));
    $$('.regenerate-message',host).forEach(b=>b.addEventListener('click',()=>regenerateFrom(b.closest('.message').dataset.messageId)));
    $$('.code-copy',host).forEach(b=>b.addEventListener('click',async()=>{const code=b.closest('.code-block')?.querySelector('code')?.textContent||'';await navigator.clipboard.writeText(code);b.textContent='Copied';setTimeout(()=>b.textContent='Copy',1200);}));
    refreshIcons(host); requestAnimationFrame(()=>{$('#chat-scroller').scrollTop=$('#chat-scroller').scrollHeight;});
  }
  function renderAll(){ renderSidebar();renderProfile();renderModel();renderChat();updateComposerMeta(); }

  function autosizeComposer(){const input=$('#composer-input');input.style.height='auto';input.style.height=Math.min(input.scrollHeight,220)+'px';updateComposerMeta();}
  function updateComposerMeta(){const input=$('#composer-input');if(!input)return;$('#composer-count').textContent=`${input.value.length.toLocaleString()} / ${MAX_MESSAGE.toLocaleString()}`;$('#send-button').disabled=!input.value.trim()&&!streamController;}
  function usePrompt(text){const i=$('#composer-input');i.value=text;i.focus();i.setSelectionRange(i.value.length,i.value.length);autosizeComposer();closeAllMenus();}

  function apiMessages(messages){return messages.filter(m=>['user','assistant'].includes(m.role)&&m.content?.trim()).slice(-40).map(m=>({role:m.role,content:m.content}));}
  async function fetchAI(conv,assistant){
    const endpoint=(state.settings.apiUrl||DEFAULT_API_URL).trim(); if(!endpoint)throw new Error('No Worker endpoint is configured.');
    streamController=new AbortController();streamMessageId=assistant.id;setStatus('Thinking…','busy');renderChat();updateSendButtonForStream();
    const res=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},signal:streamController.signal,body:JSON.stringify({model:state.model,messages:apiMessages(conv.messages.filter(m=>m.id!==assistant.id)),temperature:Number(state.settings.temperature)||.7,customInstructions:state.settings.customInstructions||'',stream:true})});
    if(!res.ok){let msg=`Request failed (${res.status})`;try{const data=await res.json();msg=data.error?.message||data.error||msg;}catch{try{msg=await res.text()||msg;}catch{}}throw new Error(msg);}
    const type=res.headers.get('content-type')||'';
    if(type.includes('text/event-stream')&&res.body) await consumeSSE(res.body,assistant,conv);
    else {const data=await res.json();assistant.content=data.choices?.[0]?.message?.content||data.content||'(No content returned)';renderChat();}
  }
  async function consumeSSE(stream,assistant,conv){
    const reader=stream.getReader();const dec=new TextDecoder();let buffer='';
    while(true){const {done,value}=await reader.read();if(done)break;buffer+=dec.decode(value,{stream:true});const parts=buffer.split('\n');buffer=parts.pop()||'';for(const raw of parts){const line=raw.trim();if(!line.startsWith('data:'))continue;const payload=line.slice(5).trim();if(!payload||payload==='[DONE]')continue;try{const data=JSON.parse(payload);const chunk=data.choices?.[0]?.delta?.content||'';if(chunk){assistant.content+=chunk;conv.updatedAt=now();renderStreamingMessage(assistant);}}catch{}}}
  }
  function renderStreamingMessage(message){const el=$(`[data-message-id="${CSS.escape(message.id)}"] .message-body`);if(el){el.innerHTML=markdown(message.content)+'<span class="typing-cursor"></span>';$$('.code-copy',el).forEach(b=>b.addEventListener('click',async()=>navigator.clipboard.writeText(b.closest('.code-block')?.querySelector('code')?.textContent||'')));$('#chat-scroller').scrollTop=$('#chat-scroller').scrollHeight;}else renderChat();}
  function updateSendButtonForStream(){const b=$('#send-button');if(streamController){b.disabled=false;b.classList.add('stop');b.innerHTML='<i data-lucide="square"></i>';b.title='Stop generating';}else{b.classList.remove('stop');b.innerHTML='<i data-lucide="arrow-up"></i>';b.title='Send message';updateComposerMeta();}refreshIcons(b);}
  function finishStream(){streamController=null;streamMessageId=null;setStatus('Ready');updateSendButtonForStream();saveState();renderAll();}

  async function sendMessage(forced=null){
    if(streamController){streamController.abort();finishStream();return;}
    const input=$('#composer-input');const text=(forced??input.value).trim();if(!text)return;if(text.length>MAX_MESSAGE){toast('Message too long',`Keep a message under ${MAX_MESSAGE.toLocaleString()} characters.`,'triangle-alert');return;}
    ensureConversation();const conv=currentConversation();const first=conv.messages.length===0;const user={id:uid(),role:'user',content:text,at:now()};const assistant={id:uid(),role:'assistant',content:'',at:now()};conv.messages.push(user,assistant);conv.updatedAt=now();if(first)conv.title=autoTitle(text);state.order=[conv.id,...state.order.filter(x=>x!==conv.id)];if(forced===null){input.value='';autosizeComposer();}saveState();renderAll();streamMessageId=assistant.id;renderChat();
    try{await fetchAI(conv,assistant);}catch(err){if(err.name==='AbortError'){if(!assistant.content)conv.messages=conv.messages.filter(m=>m.id!==assistant.id);}else{assistant.content=`**Connection error**\n\n${err.message}\n\nCheck **Settings → Connection** and try again.`;setStatus('Connection issue','error');toast('AI connection failed',err.message,'wifi-off',5000);}}
    finally{finishStream();}
  }
  async function regenerateFrom(messageId){
    if(streamController)return;const conv=currentConversation();if(!conv)return;const idx=conv.messages.findIndex(m=>m.id===messageId);if(idx<0)return;let userIdx=idx-1;while(userIdx>=0&&conv.messages[userIdx].role!=='user')userIdx--;if(userIdx<0)return;conv.messages=conv.messages.slice(0,userIdx+1);const assistant={id:uid(),role:'assistant',content:'',at:now()};conv.messages.push(assistant);saveState();renderChat();try{await fetchAI(conv,assistant);}catch(err){if(err.name!=='AbortError')assistant.content=`**Connection error**\n\n${err.message}`;}finally{finishStream();}}

  function positionMenu(menu,anchor,placement='top'){const r=anchor.getBoundingClientRect();menu.classList.remove('hidden');const mr=menu.getBoundingClientRect();let left=Math.min(window.innerWidth-mr.width-8,Math.max(8,r.left));let top=placement==='top'?r.top-mr.height-8:r.bottom+8;if(top<8)top=r.bottom+8;if(top+mr.height>window.innerHeight-8)top=Math.max(8,r.top-mr.height-8);menu.style.left=`${left}px`;menu.style.top=`${top}px`;}
  function toggleProfileMenu(){const menu=$('#profile-menu');if(!menu.classList.contains('hidden')){closeAllMenus();return;}closeAllMenus();positionMenu(menu,$('#profile-button'),'top');activePopover=menu;$('#profile-button').setAttribute('aria-expanded','true');}
  function togglePromptMenu(){const menu=$('#prompt-menu');if(!menu.classList.contains('hidden')){closeAllMenus();return;}closeAllMenus();positionMenu(menu,$('#prompt-menu-button'),'top');activePopover=menu;}
  function showModelMenu(){
    closeAllMenus();const menu=document.createElement('div');menu.className='floating-menu';menu.id='model-menu-live';menu.innerHTML=`<div class="menu-caption">CHOOSE MODEL</div>${Object.values(MODELS).map(m=>`<button class="prompt-menu-item" data-model="${m.id}"><i data-lucide="${m.icon}"></i><span><strong>${m.name}${state.model===m.id?' · Active':''}</strong><small>${m.description}</small></span></button>`).join('')}`;document.body.append(menu);activePopover=menu;positionMenu(menu,$('#model-button'),'bottom');$$('[data-model]',menu).forEach(b=>b.addEventListener('click',()=>{state.model=b.dataset.model;saveState();renderModel();closeAllMenus();toast('Model changed',`${MODELS[state.model].name} is now active.`,'cpu');}));refreshIcons(menu);
  }
  function closeAllMenus(){if(activePopover&&activePopover.id==='model-menu-live')activePopover.remove();$$('.floating-menu').forEach(m=>m.classList.add('hidden'));activePopover=null;$('#profile-button')?.setAttribute('aria-expanded','false');}

  function openSidebar(){ $('#sidebar').classList.add('open');$('#mobile-scrim').classList.add('open'); }
  function closeSidebar(){ $('#sidebar').classList.remove('open');$('#mobile-scrim').classList.remove('open'); }
  function openModal(id){ closeAllMenus();$('#'+id)?.classList.remove('hidden');refreshIcons($('#'+id)); }
  function closeModal(id){ $('#'+id)?.classList.add('hidden'); if(id==='confirm-backdrop'&&confirmResolver){confirmResolver(false);confirmResolver=null;} }
  function closeAllModals(){ $$('.modal-backdrop').forEach(m=>m.classList.add('hidden')); }

  function confirmAction(title,copy,confirmText='Confirm'){
    if(confirmResolver){confirmResolver(false);confirmResolver=null;}
    $('#confirm-title').textContent=title;$('#confirm-copy').textContent=copy;$('#confirm-yes').textContent=confirmText;openModal('confirm-backdrop');
    return new Promise(resolve=>{confirmResolver=resolve;});
  }
  function resolveConfirm(value){if(!confirmResolver)return;const r=confirmResolver;confirmResolver=null;$('#confirm-backdrop').classList.add('hidden');r(value);}

  function openRename(id){const c=state.conversations[id];if(!c)return;pendingRenameId=id;$('#rename-input').value=c.title;openModal('rename-backdrop');setTimeout(()=>{$('#rename-input').focus();$('#rename-input').select();},50);}
  function saveRename(){const c=state.conversations[pendingRenameId];if(!c)return;c.title=$('#rename-input').value.trim()||'New chat';c.updatedAt=now();saveState();closeModal('rename-backdrop');renderSidebar();pendingRenameId=null;}

  function switchSettingsTab(tab){$$('.settings-nav button').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));$$('.settings-pane').forEach(p=>p.classList.toggle('hidden',p.dataset.pane!==tab));}
  function openSettings(tab='general'){syncSettingsForm();switchSettingsTab(tab);openModal('settings-backdrop');}
  function syncSettingsForm(){if(!state)return;$('#settings-name').value=state.profile.name||'';$('#settings-model').value=state.model;$('#settings-temperature').value=state.settings.temperature;$('#temperature-value').textContent=Number(state.settings.temperature).toFixed(1);$('#settings-instructions').value=state.settings.customInstructions||'';$('#settings-api-url').value=state.settings.apiUrl||'';$('#settings-compact').checked=!!state.settings.compactMode;$('#settings-reduced-motion').checked=!!state.settings.reducedMotion;$('#settings-enter-send').checked=state.settings.enterToSend!==false;$('#settings-timestamps').checked=state.settings.showTimestamps!==false;renderProfile();}
  function saveSettings(){
    const name=$('#settings-name').value.trim()||'Unnamed';state.profile.name=name;activeAccount.name=name;activeAccount.avatar=state.profile.avatar;auth.accounts[activeAccount.email]=activeAccount;saveAuth();state.model=$('#settings-model').value;state.settings.temperature=Number($('#settings-temperature').value);state.settings.customInstructions=$('#settings-instructions').value.trim();state.settings.apiUrl=$('#settings-api-url').value.trim()||DEFAULT_API_URL;state.settings.compactMode=$('#settings-compact').checked;state.settings.reducedMotion=$('#settings-reduced-motion').checked;state.settings.enterToSend=$('#settings-enter-send').checked;state.settings.showTimestamps=$('#settings-timestamps').checked;saveState();applyPreferences();renderAll();closeModal('settings-backdrop');toast('Settings saved','Your local preferences were updated.','check');
  }
  async function handleAvatar(file){if(!file)return;if(!file.type.startsWith('image/'))return toast('Unsupported file','Choose an image for your avatar.','image-off');if(file.size>8*1024*1024)return toast('Image too large','Choose an image smaller than 8 MB.','image-off');state.profile.avatar=await resizeImage(file,192);activeAccount.avatar=state.profile.avatar;auth.accounts[activeAccount.email]=activeAccount;saveAuth();saveState();renderProfile();renderChat();toast('Avatar updated','Saved only to this local profile.','user-round-check');}
  function resizeImage(file,size){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=reject;reader.onload=()=>{const img=new Image();img.onerror=reject;img.onload=()=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=size;const ctx=canvas.getContext('2d');const scale=Math.max(size/img.width,size/img.height);const w=img.width*scale,h=img.height*scale;ctx.drawImage(img,(size-w)/2,(size-h)/2,w,h);resolve(canvas.toDataURL('image/webp',.86));};img.src=reader.result;};reader.readAsDataURL(file);});}

  async function showLicense(){openModal('license-backdrop');const pre=$('#license-content');pre.textContent='Loading LICENSE…';try{const r=await fetch('./LICENSE',{cache:'no-store'});if(!r.ok)throw new Error();pre.textContent=await r.text();}catch{pre.textContent='Could not load LICENSE from this deployment. Make sure the LICENSE file is published beside index.html.';}}
  function exportData(){const payload={exportedAt:new Date().toISOString(),account:{name:activeAccount.name,email:activeAccount.email,createdAt:activeAccount.createdAt},state};const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`unai-${activeAccount.email.replace(/[^a-z0-9]/gi,'_')}-${new Date().toISOString().slice(0,10)}.json`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
  async function importData(file){try{const p=JSON.parse(await file.text());const imported=p.state||p;if(!imported||typeof imported!=='object'||!imported.conversations)throw new Error();const base=defaultState(activeAccount);state={...base,...imported,version:1,profile:{...base.profile,...imported.profile},settings:{...base.settings,...imported.settings}};if(!MODELS[state.model])state.model=base.model;saveState();applyPreferences();renderAll();syncSettingsForm();toast('Backup imported','Conversations and settings were restored into this local profile.','archive-restore');}catch{toast('Import failed','That file is not a valid UnAI backup.','circle-alert');}}
  async function testConnection(){const out=$('#connection-result');const base=$('#settings-api-url').value.trim();if(!base){out.className='connection-result bad';out.textContent='Enter a Worker endpoint first.';return;}out.className='connection-result';out.textContent='Testing connection…';try{const u=new URL(base);u.pathname='/health';const r=await fetch(u.toString(),{cache:'no-store'});if(!r.ok)throw new Error(`HTTP ${r.status}`);const data=await r.json();out.className='connection-result ok';out.textContent=data.ok?'Connection healthy. The UnAI Worker is responding.':'The endpoint responded, but did not identify as healthy.';}catch(err){out.className='connection-result bad';out.textContent=`Connection failed: ${err.message}`;}}

  async function changePassword(){const current=$('#password-current').value;const next=$('#password-new').value;$('#password-change-error').textContent='';if(next.length<8||!/[A-Z]/.test(next)||!/\d/.test(next)){setError('#password-change-error','New password needs 8+ characters, an uppercase letter and a number.');return;}const check=await derivePassword(current,activeAccount.salt);if(check.hash!==activeAccount.passwordHash){setError('#password-change-error','Current password is incorrect.');return;}const d=await derivePassword(next);activeAccount.salt=d.salt;activeAccount.passwordHash=d.hash;auth.accounts[activeAccount.email]=activeAccount;saveAuth();$('#password-current').value='';$('#password-new').value='';closeModal('password-backdrop');toast('Password changed','The local credential was updated on this device.','key-round');}
  async function deleteCurrentAccount(){if(!await confirmAction('Delete this local account?','This permanently removes the local profile, conversations and settings from this browser.','Delete account'))return;delete auth.accounts[activeAccount.email];saveAuth();localStorage.removeItem(profileStoreKey(activeAccount.id));logout();}

  function toast(title,copy,icon='sparkles',duration=3600){const stack=$('#toast-stack');const el=document.createElement('div');el.className='toast';el.innerHTML=`<i data-lucide="${icon}"></i><div><div class="toast-title">${escapeHtml(title)}</div><div class="toast-copy">${escapeHtml(copy)}</div></div>`;stack.append(el);refreshIcons(el);setTimeout(()=>el.remove(),duration);}

  function bindUI(){
    $$('[data-auth-tab]').forEach(b=>b.addEventListener('click',()=>setAuthTab(b.dataset.authTab)));
    $('#login-form').addEventListener('submit',loginAccount);$('#register-form').addEventListener('submit',registerAccount);
    $$('[data-toggle-password]').forEach(b=>b.addEventListener('click',()=>{const input=$('#'+b.dataset.togglePassword);const show=input.type==='password';input.type=show?'text':'password';b.innerHTML=`<i data-lucide="${show?'eye-off':'eye'}"></i>`;b.setAttribute('aria-label',show?'Hide password':'Show password');refreshIcons(b);}));
    $('#register-password').addEventListener('input',e=>{const v=e.target.value,s=passwordScore(v);const fill=$('#password-meter-fill');fill.style.width=`${Math.min(100,s/6*100)}%`;fill.style.background=s<3?'var(--danger)':s<5?'var(--gold-400)':'var(--success)';const rules={length:v.length>=8,upper:/[A-Z]/.test(v),number:/\d/.test(v)};Object.entries(rules).forEach(([k,ok])=>{const el=$(`[data-rule="${k}"]`);el.classList.toggle('ok',ok);el.innerHTML=`<i data-lucide="${ok?'check-circle-2':'circle'}"></i> ${k==='length'?'8+ characters':k==='upper'?'Uppercase':'Number'}`;});refreshIcons($('#password-rules'));});
    $('#forgot-password').addEventListener('click',()=>openModal('forgot-backdrop'));$('#auth-license-button').addEventListener('click',showLicense);$('#auth-license-bottom').addEventListener('click',showLicense);
    $('#forgot-delete-profile').addEventListener('click',async()=>{const email=normalizeEmail(prompt('Enter the email of the local profile to delete:')||'');if(!email)return;const acc=auth.accounts[email];if(!acc){toast('Profile not found','No local profile with that email exists on this device.','user-x');return;}if(confirm(`Delete the local profile for ${email}? This cannot be undone.`)){delete auth.accounts[email];saveAuth();localStorage.removeItem(profileStoreKey(acc.id));closeModal('forgot-backdrop');toast('Local profile deleted','You can now create a new profile with that email.','trash-2');}});

    $('#new-chat').addEventListener('click',()=>createConversation());$('#conversation-search').addEventListener('input',renderSidebar);$('#profile-button').addEventListener('click',toggleProfileMenu);$('#settings-button').addEventListener('click',()=>openSettings('general'));$('#model-button').addEventListener('click',showModelMenu);$('#mobile-menu').addEventListener('click',openSidebar);$('#mobile-scrim').addEventListener('click',closeSidebar);$('#sidebar-collapse').addEventListener('click',closeSidebar);
    $('#send-button').addEventListener('click',()=>sendMessage());$('#composer-input').addEventListener('input',autosizeComposer);$('#composer-input').addEventListener('keydown',e=>{const send=state?.settings?.enterToSend!==false?(e.key==='Enter'&&!e.shiftKey):(e.key==='Enter'&&(e.ctrlKey||e.metaKey));if(send&&!e.isComposing){e.preventDefault();sendMessage();}});$('#prompt-menu-button').addEventListener('click',togglePromptMenu);$$('.prompt-menu-item[data-prompt]').forEach(b=>b.addEventListener('click',()=>usePrompt(b.dataset.prompt)));
    $('#profile-menu-settings').addEventListener('click',()=>openSettings('general'));$('#profile-menu-export').addEventListener('click',exportData);$('#profile-menu-license').addEventListener('click',showLicense);$('#logout-button').addEventListener('click',logout);$('#settings-logout-button').addEventListener('click',logout);
    $('#rename-current').addEventListener('click',()=>state.activeId&&openRename(state.activeId));$('#rename-save').addEventListener('click',saveRename);$('#rename-input').addEventListener('keydown',e=>{if(e.key==='Enter')saveRename();});
    $('#clear-current').addEventListener('click',async()=>{const c=currentConversation();if(!c?.messages.length)return;if(await confirmAction('Clear this conversation?','Every message in this chat will be permanently removed.','Clear conversation')){c.messages=[];c.updatedAt=now();saveState();renderAll();}});

    $$('.settings-nav button').forEach(b=>b.addEventListener('click',()=>switchSettingsTab(b.dataset.tab)));$$('.theme-choice').forEach(b=>b.addEventListener('click',()=>{state.theme=b.dataset.theme;applyPreferences();saveState();}));$('#settings-temperature').addEventListener('input',e=>$('#temperature-value').textContent=Number(e.target.value).toFixed(1));$('#settings-save').addEventListener('click',saveSettings);$('#avatar-upload-button').addEventListener('click',()=>$('#avatar-file').click());$('#avatar-file').addEventListener('change',e=>{handleAvatar(e.target.files?.[0]);e.target.value='';});$('#avatar-remove-button').addEventListener('click',()=>{state.profile.avatar='';activeAccount.avatar='';auth.accounts[activeAccount.email]=activeAccount;saveAuth();saveState();renderProfile();renderChat();});$('#test-connection').addEventListener('click',testConnection);$('#license-button').addEventListener('click',showLicense);$('#license-button-settings').addEventListener('click',showLicense);$('#export-button').addEventListener('click',exportData);$('#import-button').addEventListener('click',()=>$('#import-file').click());$('#import-file').addEventListener('change',e=>{if(e.target.files?.[0])importData(e.target.files[0]);e.target.value='';});
    $('#clear-chats-button').addEventListener('click',async()=>{if(await confirmAction('Clear every conversation?','All conversations for this local profile will be deleted. Your settings stay intact.','Clear all conversations')){state.conversations={};state.order=[];state.activeId=null;saveState();renderAll();toast('Conversations cleared','This local profile now has an empty history.','trash-2');}});$('#change-password-button').addEventListener('click',()=>{closeModal('settings-backdrop');openModal('password-backdrop');setTimeout(()=>$('#password-current').focus(),40);});$('#password-change-save').addEventListener('click',changePassword);$('#delete-account-button').addEventListener('click',deleteCurrentAccount);

    $$('[data-close-modal]').forEach(b=>b.addEventListener('click',()=>closeModal(b.dataset.closeModal)));$$('.modal-backdrop').forEach(m=>m.addEventListener('mousedown',e=>{if(e.target===m&&m.id!=='confirm-backdrop')closeModal(m.id);}));$('#confirm-yes').addEventListener('click',()=>resolveConfirm(true));$('#confirm-no').addEventListener('click',()=>resolveConfirm(false));
    document.addEventListener('click',e=>{if(activePopover&&!activePopover.contains(e.target)&&!e.target.closest('#profile-button,#model-button,#prompt-menu-button'))closeAllMenus();});
    window.addEventListener('resize',closeAllMenus);
    document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeAllMenus();closeSidebar();const open=$$('.modal-backdrop:not(.hidden)').at(-1);if(open)closeModal(open.id);}if(!state)return;if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='n'){e.preventDefault();createConversation();}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();openSidebar();setTimeout(()=>$('#conversation-search').focus(),50);}if((e.ctrlKey||e.metaKey)&&e.key===','){e.preventDefault();openSettings();}if(e.key==='/'&&!/input|textarea|select/i.test(document.activeElement?.tagName||'')){e.preventDefault();$('#composer-input').focus();}});
  }

  function init(){
    if(window.marked?.setOptions)window.marked.setOptions({gfm:true,breaks:true});bindUI();refreshIcons();
    if(tryRestoreSession())enterApp();else showAuth();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
