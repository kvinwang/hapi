/**
 * The entire client-side JS budget for the lite UI, inlined into the page.
 *
 * It does exactly three things:
 *   1. incremental message tail (append-only `insertAdjacentHTML`, no diffing)
 *   2. intercept form posts so actions do not reload the page
 *   3. drop the SSE connection whenever the tab is hidden
 *
 * (3) is the single biggest standby win: the full SPA keeps its EventSource open and
 * its 10s heartbeat timer armed while backgrounded, and still parses every event and
 * writes it into the query cache with no visibility gate.
 *
 * Every feature degrades to plain HTML: with JS disabled or broken, the forms are
 * ordinary POSTs and the server redirects back to a freshly rendered page.
 */

const SOURCE = `(function(){
var root=document.getElementById('msgs');
if(!root)return;
var sid=root.getAttribute('data-session');
var live=root.getAttribute('data-live')==='1';
var lastSeq=parseInt(root.getAttribute('data-last-seq')||'0',10);
var base='/lite/s/'+encodeURIComponent(sid);
// True when this page shows the end of the conversation, so appending to it is correct.
// A ?before= page is a window into history and must never be tailed.
var atEnd=root.getAttribute('data-scroll')==='bottom';
// Bound the DOM. This UI has no virtualization, and Safari 17 predates
// content-visibility, so a session tailed for hours would otherwise grow without limit
// and undo the per-page cap the server applies.
var MAX_NODES=400;
var es=null,timer=null,busy=false,again=false;

function nearBottom(){
  return (window.innerHeight+window.pageYOffset)>=(document.body.offsetHeight-120);
}
function toBottom(){window.scrollTo(0,document.body.scrollHeight)}

function apply(d){
  if(d.html){
    var stick=nearBottom();
    root.insertAdjacentHTML('beforeend',d.html);
    // Trim only while pinned to the bottom: dropping nodes above the viewport while the
    // user is reading further up would yank the page out from under them.
    if(stick){
      while(root.children.length>MAX_NODES)root.removeChild(root.firstElementChild);
      toBottom();
    }
  }
  if(typeof d.lastSeq==='number'&&d.lastSeq>lastSeq){
    lastSeq=d.lastSeq;
    root.setAttribute('data-last-seq',String(lastSeq));
  }
  if(typeof d.statusHtml==='string'){
    // Status is shown top and bottom; the bottom copy is the reachable one on a tablet.
    var st=document.querySelectorAll('[data-status]');
    for(var i=0;i<st.length;i++){if(st[i].innerHTML!==d.statusHtml)st[i].innerHTML=d.statusHtml}
  }
  // Keyed on which requests are pending, not on the markup: an answer form the user is
  // halfway through filling in re-renders to the same HTML, and swapping it every poll
  // would silently clear their radio buttons and typed text.
  var rq=document.getElementById('requests');
  if(rq&&typeof d.requestsKey==='string'&&rq.getAttribute('data-key')!==d.requestsKey){
    rq.setAttribute('data-key',d.requestsKey);
    rq.innerHTML=typeof d.requestsHtml==='string'?d.requestsHtml:'';
  }
}

function refresh(){
  // A request already in flight would otherwise swallow this round entirely, losing
  // the last update of a turn; remember it and run once the current one lands.
  if(busy){again=true;return}
  busy=true;
  fetch(base+'/tail?afterSeq='+lastSeq,{credentials:'same-origin'})
    .then(function(r){return r.ok?r.json():null})
    .then(function(d){
      busy=false;
      if(d)apply(d);
      // Catching up across more than one batch, or a request arrived while busy.
      if((d&&d.hasMore)||again){again=false;refresh()}
    })
    .catch(function(){busy=false;again=false});
}

// Coalesce bursts: a streaming turn emits many events, but one fetch per second is
// plenty and keeps the radio and CPU mostly idle between wakeups.
function schedule(){
  if(timer)return;
  timer=setTimeout(function(){timer=null;refresh()},1000);
}

function openStream(){
  if(!live||es||typeof EventSource==='undefined')return;
  es=new EventSource('/api/events?sessionId='+encodeURIComponent(sid),{withCredentials:true});
  es.onmessage=function(){schedule()};
  es.onerror=function(){
    // Let the browser retry on its own; if the tab is hidden we close instead.
    if(document.hidden)closeStream();
  };
}
function closeStream(){
  if(es){es.close();es=null}
  if(timer){clearTimeout(timer);timer=null}
}

document.addEventListener('visibilitychange',function(){
  if(document.hidden){closeStream();return}
  // Only when live. On a historical (?before=) page the tail would splice the newest
  // messages onto the end of the window being read.
  if(live){openStream();refresh()}
});

function showError(msg){
  var box=document.getElementById('lite-error');
  if(!box){
    box=document.createElement('div');
    box.id='lite-error';
    box.className='err-box';
    root.parentNode.insertBefore(box,root);
  }
  box.textContent=msg;
}
function clearError(){
  var box=document.getElementById('lite-error');
  if(box&&box.parentNode)box.parentNode.removeChild(box);
}

function post(url,pairs){
  var body=new URLSearchParams();
  for(var i=0;i<pairs.length;i++)body.append(pairs[i][0],pairs[i][1]);
  return fetch(url,{
    method:'POST',
    credentials:'same-origin',
    headers:{'Content-Type':'application/x-www-form-urlencoded','X-Lite-Fetch':'1'},
    body:body.toString()
  });
}

document.addEventListener('submit',function(ev){
  var form=ev.target;
  if(!form||form.tagName!=='FORM')return;
  var action=form.getAttribute('action')||'';
  if(action.indexOf('/lite/')!==0)return;
  ev.preventDefault();
  // Name/value pairs, not an object: a multi-select question submits the same field
  // name several times, and an object would keep only the last one. Unchecked boxes
  // must be skipped entirely, or every group would submit its last option regardless
  // of what was picked — the agent would act on an answer nobody gave.
  var data=[];
  var els=form.elements;
  for(var i=0;i<els.length;i++){
    var el=els[i];
    if(!el.name)continue;
    if((el.type==='radio'||el.type==='checkbox')&&!el.checked)continue;
    data.push([el.name,el.value]);
  }
  var ta=form.querySelector('textarea[name=text]');
  var sent='';
  if(ta){
    if(!ta.value.trim())return;
    sent=ta.value;
    ta.value='';
  }
  clearError();
  post(action,data).then(function(r){
    // Gated on the page being at the end of the conversation, NOT on live updates:
    // on the ?live=0 power-saving page a sent message would otherwise clear the box
    // and never appear, making the JS path worse than the plain-form fallback.
    // A historical (?before=) page still must not tail.
    if(r.ok){if(atEnd)setTimeout(refresh,250);return}
    // Never silently swallow the message: put it back so it can be retried.
    if(ta&&!ta.value)ta.value=sent;
    return r.json().catch(function(){return null}).then(function(d){
      showError((d&&d.error)||('操作失败 ('+r.status+')'));
    });
  }).catch(function(){
    if(ta&&!ta.value)ta.value=sent;
    showError('网络错误,请重试。');
  });
},false);

// Open a live session at the newest message, the way a chat is expected to behave.
// Not done on a historical (?before=) page, where the top of the window is the point.
if(root.getAttribute('data-scroll')==='bottom')toBottom();

if(live)openStream();
})();`

/**
 * Shipped without its comments. They exist for whoever maintains this next, but this
 * script is inlined into every page render, and the point of this UI is bytes not spent.
 * Only whole-line comments are dropped, so nothing inside a string can be touched.
 */
export const LITE_CLIENT_JS = SOURCE
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
    .replace(/\n{2,}/g, '\n')
