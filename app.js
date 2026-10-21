'use strict';
const $ = id => document.getElementById(id);
const state = {articles:[],tab:'form',dashboardTimer:null,dashboardBusy:false,selectedArticle:null,board:null,selected:new Set(),saved:null,submission:null};
function el(tag,className,text) { const node=document.createElement(tag); if(className)node.className=className; if(text!==undefined)node.textContent=text; return node; }
function status(id,message='',error=false) { const node=$(id);node.textContent=message;node.className=`status ${error?'error':message?'success':''}`; }
async function api(path, options={}) {
  let response;
  const {timeout=15_000,...init}=options;
  try { response=await fetch(path,{credentials:'same-origin',...init,headers:{'Content-Type':'application/json',...init.headers},signal:AbortSignal.timeout(timeout)}); }
  catch { throw Error('연결이 지연되거나 끊어졌습니다. 잠시 후 다시 시도해 주세요.'); }
  let data;try{data=await response.json();}catch{throw Error('앱 서버에 연결할 수 없습니다. 운영자에게 문의해 주세요.');}
  if(!response.ok){const error=Error(data.error||'요청을 처리하지 못했습니다.');error.status=response.status;throw error;}
  return data;
}
function switchTab(tab) {
  state.tab=tab;
  for(const id of ['form','dashboard']){
    const active=id===tab; $(`tab-${id}`).classList.toggle('active',active);$(`tab-${id}`).setAttribute('aria-selected',String(active));$(`tab-${id}`).tabIndex=active?0:-1;$(`${id}Panel`).hidden=!active;
  }
  clearTimeout(state.dashboardTimer);
  if(tab==='dashboard')loadDashboard();
}
function dateText(value) {const date=new Date(value);return Number.isFinite(date.getTime())?new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(date):'확인되지 않음';}
async function loadArticles() {
  try {
    const data=await api('/api/articles'); state.articles=Array.isArray(data.articles)?data.articles:[];
    renderArticles();
  }catch(error){$('articleCards').replaceChildren(el('p','empty-state',error.message));$('articleCount').textContent='불러오기 실패';$('submitButton').disabled=true;}
}
function renderArticles() {
  const cards=$('articleCards'),select=$('selectedArticle'),current=select.value;cards.replaceChildren();select.replaceChildren(new Option('평가하실 기사를 선택해 주세요',''));
  $('articleCount').textContent=`${state.articles.length}개의 이야기`;$('submitButton').disabled=!state.articles.length;
  if(!state.articles.length)cards.append(el('p','empty-state','아직 게시된 기사가 없습니다. 운영자가 패들렛 기사를 선택하면 이곳에서 읽을 수 있습니다.'));
  state.articles.forEach((article,index)=>{
    const card=el('article','article-card'),top=el('div','article-card-top');
    top.append(el('span','pill',article.category),el('span','article-number',String(index+1).padStart(2,'0')));
    const read=el('button','read-article');read.type='button';read.append(el('span','','기사 더 읽기'),el('span','','↗'));read.setAttribute('aria-label',`${article.title} 기사 읽기`);read.addEventListener('click',()=>openArticle(article));
    card.append(top,el('h3','',article.title),el('p','article-summary',article.summary||'기사와 첨부 자료는 패들렛 원문에서 확인해 주세요.'),read);cards.append(card);
    select.add(new Option(article.title,article.id));
  });
  if(state.articles.some(a=>a.id===current))select.value=current;
}
function openArticle(article) {
  state.selectedArticle=article;$('articleCategory').textContent=article.category;$('articleDialogTitle').textContent=article.title;$('articleBody').textContent=article.content||'본문이 없는 기사입니다. 패들렛 원문과 첨부 자료를 확인해 주세요.';
  const link=$('articleSource');link.hidden=!article.url;if(article.url)link.href=article.url;else link.removeAttribute('href');
  $('articleDialog').showModal();
}
function renderBars(container,rows,total) {
  container.replaceChildren();
  if(!total){container.append(el('p','muted tiny','아직 시트에 저장된 응답이 없습니다.'));return;}
  const max=Math.max(1,...rows.map(r=>r.count));
  for(const row of rows){
    const wrapper=el('div','bar-row'),label=el('div','bar-label');label.append(el('span','',row.label),el('strong','',`${row.count.toLocaleString('ko-KR')}명`));
    const track=el('div','bar-track'),fill=el('div','bar-fill');fill.style.width=`${Math.max(0,Math.min(100,row.count/max*100))}%`;track.append(fill);track.setAttribute('aria-hidden','true');wrapper.append(label,track);container.append(wrapper);
  }
}
async function loadDashboard() {
  if(state.dashboardBusy||state.tab!=='dashboard'||document.hidden)return;
  state.dashboardBusy=true;$('refreshDashboard').disabled=true;
  try{
    const result=await api('/api/dashboard');const data=result.dashboard;
    $('metricTotal').textContent=data.total.toLocaleString('ko-KR');$('metricAverage').textContent=`${data.average.toFixed(1)} ★`;$('metricExternal').textContent=`${data.total?Math.round(data.external/data.total*100):0}%`;
    const sorted=[...data.articles].sort((a,b)=>b.count-a.count||a.label.localeCompare(b.label,'ko'));const top=sorted[0];
    $('metricTop').textContent=top?sorted.filter(r=>r.count===top.count).map(r=>r.label).join(' · '):'아직 응답이 없습니다';
    renderBars($('articleChart'),sorted,data.total);renderBars($('visitorChart'),data.affiliations,data.total);
    status('dashboardStatus',`${result.stale?'시트 연결이 지연되어 마지막 집계값을 표시합니다. · ':''}시트 집계 시각 ${dateText(data.updatedAt)} (한국 시간)`,result.stale);
  }catch(error){status('dashboardStatus',`${error.message} 새로운 집계를 표시할 수 없습니다.`,true);}
  finally{state.dashboardBusy=false;$('refreshDashboard').disabled=false;clearTimeout(state.dashboardTimer);if(state.tab==='dashboard'&&!document.hidden)state.dashboardTimer=setTimeout(loadDashboard,30_000+Math.random()*2000);}
}
async function submitFeedback(event) {
  event.preventDefault();if($('submitButton').disabled)return;
  const form=event.currentTarget,fields=new FormData(form);const payload={affiliation:fields.get('affiliation'),gender:fields.get('gender'),articleId:fields.get('articleId'),rating:Number(fields.get('rating')),review:String(fields.get('review')||'').trim()};
  if(!payload.review){status('submitStatus','한 줄 평을 작성해 주세요.',true);$('review').focus();return;}
  const fingerprint=JSON.stringify(payload);
  if(!state.submission||state.submission.fingerprint!==fingerprint)state.submission={fingerprint,requestId:crypto.randomUUID()};
  $('submitButton').disabled=true;status('submitStatus','구글 시트에 저장하고 있습니다. 잠시만 기다려 주세요.');
  try{
    const result=await api('/api/feedback',{method:'POST',body:JSON.stringify({...payload,requestId:state.submission.requestId}),timeout:45_000});
    $('ticketCode').textContent=result.ticketId;$('ticketDialog').showModal();form.reset();updateStars();state.submission=null;status('submitStatus','구글 시트 저장이 확인되었습니다.');
  }catch(error){status('submitStatus',`${error.message} 제출 번호는 재시도 시에도 유지되어 중복 저장을 방지합니다.`,true);}
  finally{$('submitButton').disabled=!state.articles.length;}
}
function updateStars() {
  const selected=document.querySelector('input[name=rating]:checked');const rating=Number(selected?.value||0);
  document.querySelectorAll('.stars label').forEach((node,index)=>node.classList.toggle('filled',index<rating));$('ratingHint').textContent=rating?`${rating}점 / 5점`:'별점을 선택해 주세요';
}
function showLogin(){$('loginForm').hidden=false;$('adminWorkspace').hidden=true;$('adminPassword').value='';}
async function loadAdmin() {
  try{
    const data=await api('/api/admin/settings');state.saved=data;$('loginForm').hidden=true;$('adminWorkspace').hidden=false;
    $('padletBoard').value=data.boardId||'';$('publishedInfo').textContent=data.publishedAt?`현재 ${data.articles.length}개 기사 게시 중 · ${dateText(data.publishedAt)} (한국 시간)`:'아직 게시된 기사가 없습니다.';
    $('adminConnections').textContent=`패들렛 키: ${data.padletConfigured?'설정됨':'서버 설정 필요'} · 구글 시트 저장: ${data.sheetsConfigured?'설정됨':'서버 설정 필요'}`;
    $('selectionWorkspace').hidden=true;state.board=null;state.selected=new Set(data.selectedIds);status('adminStatus');
  }catch(error){showLogin();if(error.status!==401)status('adminStatus',error.message,true);}
}
async function login(event){event.preventDefault();const button=event.currentTarget.querySelector('button');button.disabled=true;status('adminStatus');try{await api('/api/admin/login',{method:'POST',body:JSON.stringify({password:$('adminPassword').value})});$('adminPassword').value='';await loadAdmin();}catch(error){status('adminStatus',error.message,true);}finally{button.disabled=false;}}
async function loadPadlet(event) {
  event.preventDefault();$('loadPadlet').disabled=true;status('adminStatus','패들렛의 섹션과 기사를 불러오고 있습니다.');
  try{
    const board=await api('/api/admin/padlet',{method:'POST',body:JSON.stringify({board:$('padletBoard').value.trim()}),timeout:120_000});
    state.board=board;const available=new Set(board.articles.map(a=>a.id));state.selected=new Set(board.id===state.saved?.boardId?state.saved.selectedIds.filter(id=>available.has(id)):[]);renderChoices();$('selectionWorkspace').hidden=false;status('adminStatus',`${board.sections.length}개 섹션, ${board.articles.length}개 기사를 불러왔습니다.`);
  }catch(error){status('adminStatus',error.message,true);if(error.status===401)showLogin();}
  finally{$('loadPadlet').disabled=false;}
}
function updateSelectionCount(){const count=state.selected.size;$('selectionCount').textContent=`${count}개 기사 선택`;$('publishArticles').textContent=count?`선택한 ${count}개 기사 게시하기 →`:'기사 게시 해제하기';}
function renderChoices(){
  const board=state.board;$('boardTitle').textContent=board.title;const container=$('sectionChoices');container.replaceChildren();
  for(const section of board.sections){
    const posts=board.articles.filter(a=>a.sectionId===section.id);if(!posts.length)continue;
    const group=el('fieldset','section-choice'),label=el('label'),all=el('input');all.type='checkbox';label.append(all,el('span','',`${section.title} (${posts.length})`));group.append(label);
    const postInputs=[];
    const sync=()=>{const n=posts.filter(a=>state.selected.has(a.id)).length;all.checked=n===posts.length;all.indeterminate=n>0&&n<posts.length;updateSelectionCount();};
    for(const article of posts){const row=el('label','post-choice'),input=el('input');input.type='checkbox';input.checked=state.selected.has(article.id);input.addEventListener('change',()=>{if(input.checked)state.selected.add(article.id);else state.selected.delete(article.id);sync();});postInputs.push(input);row.append(input,el('span','',article.title));group.append(row);}
    all.addEventListener('change',()=>{posts.forEach((a,i)=>{if(all.checked)state.selected.add(a.id);else state.selected.delete(a.id);postInputs[i].checked=all.checked;});sync();});sync();container.append(group);
  }
  if(!board.articles.length)container.append(el('p','empty-state','선택할 기사가 없습니다. 패들렛 주소와 접근 권한을 확인해 주세요.'));
  updateSelectionCount();
}
async function publish(){
  if(!state.board)return;
  if(!state.selected.size&&!confirm('게시된 모든 기사를 숨길까요?'))return;
  $('publishArticles').disabled=true;$('loadPadlet').disabled=true;status('adminStatus','선택한 기사를 게시하고 있습니다.');
  try{const result=await api('/api/admin/publish',{method:'PUT',body:JSON.stringify({boardId:state.board.id,selectedIds:[...state.selected]}),timeout:120_000});await loadArticles();await loadAdmin();status('adminStatus',`${result.count}개 기사를 게시했습니다. 모든 방문자에게 적용됩니다.`);}catch(error){status('adminStatus',error.message,true);if(error.status===401)showLogin();}
  finally{$('publishArticles').disabled=false;$('loadPadlet').disabled=false;}
}
for(const tab of ['form','dashboard']){$(`tab-${tab}`).addEventListener('click',()=>switchTab(tab));$(`tab-${tab}`).addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();const next=tab==='form'?'dashboard':'form';switchTab(next);$(`tab-${next}`).focus();}});}
$('feedbackForm').addEventListener('submit',submitFeedback);document.querySelectorAll('input[name=rating]').forEach(node=>node.addEventListener('change',updateStars));
$('refreshDashboard').addEventListener('click',loadDashboard);document.addEventListener('visibilitychange',()=>{clearTimeout(state.dashboardTimer);if(!document.hidden&&state.tab==='dashboard')loadDashboard();});
$('adminOpen').addEventListener('click',()=>{$('adminDialog').showModal();status('adminStatus');loadAdmin();});$('loginForm').addEventListener('submit',login);$('padletForm').addEventListener('submit',loadPadlet);$('publishArticles').addEventListener('click',publish);
$('adminLogout').addEventListener('click',async()=>{try{await api('/api/admin/logout',{method:'POST',body:'{}'});showLogin();state.saved=null;state.board=null;status('adminStatus','로그아웃되었습니다.');}catch(error){status('adminStatus',error.message,true);}});
$('evaluateArticle').addEventListener('click',()=>{if(state.selectedArticle)$('selectedArticle').value=state.selectedArticle.id;$('articleDialog').close();switchTab('form');$('feedbackForm').scrollIntoView({behavior:'smooth'});});
for(const dialog of document.querySelectorAll('dialog')){dialog.querySelectorAll('.close-dialog').forEach(button=>button.addEventListener('click',()=>dialog.close()));dialog.addEventListener('click',event=>{const rect=dialog.getBoundingClientRect();if(event.target===dialog&&(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom))dialog.close();});}
loadArticles();
