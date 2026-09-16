// ============================================
// 学习激励系统 · 用户端逻辑
// ============================================
(function(){
const C = window.APP, S = window.Shared, sb = S.sb;
const $ = s=>document.querySelector(s);

// ---- 状态 ----
let state = {
  score: 0,          // 当前可用分数
  pet: null,         // 宠物
  tasks: [],         // 今日/当前计划任务
  categories: [],    // 花费类别
  expenses: [],      // 支出
  topups: [],        // 加钱记录
  rewards: [],       // 奖励列表
  redemptions: [],   // 我的兑换
  goals: [],         // 我的目标
  plans: [],         // 计划
};

// ---- 登录守卫：未登录跳登录页 ----
async function guard(){
  const u = await S.init();
  if(!u){ location.href = "../login.html"; return false; }
  const prof = S.profile;
  // 用户端只允许 user 角色；管理员也可查看（调试/代管）
  await refresh().catch(e=>console.warn("refresh:",e));
  bindEvents();
  switchPage("home");
  return true;
}

// ---- 刷新所有数据 ----
async function refresh(){
  const uid = S.user.id;
  // 并行拉取全部数据，避免串行等待造成卡顿
  const safe = p => p.then(r=>({data:r.data||null, error:r.error})).catch(()=>({data:null,error:true}));
  const [catR, expR, topR, goalR, planR, petR, slogsR, rewR, redR] = await Promise.all([
    safe(sb.from("categories").select("*").eq("user_id",uid)),
    safe(sb.from("expenses").select("*").eq("user_id",uid)),
    safe(sb.from("budget_topups").select("*").eq("user_id",uid)),
    safe(sb.from("goals").select("*").eq("user_id",uid)),
    safe(sb.from("plans").select("*").eq("user_id",uid)),
    safe(sb.from("pets").select("*").eq("user_id",uid)),
    safe(sb.from("score_logs").select("amount").eq("user_id",uid)),
    safe(sb.from("rewards").select("*").eq("status","active")),
    safe(sb.from("redemptions").select("*").eq("user_id",uid).order("created_at",{ascending:false})),
  ]);
  state.categories = catR.data||[];
  state.expenses   = expR.data||[];
  state.topups     = topR.data||[];
  state.goals      = goalR.data||[];
  state.plans      = planR.data||[];
  state.pet = (petR.data && petR.data[0]) ? petR.data[0] : { stage:"egg", total_points:0 };
  if(!state.pet.id) state.pet = null;
  state.score = (slogsR.data||[]).reduce((a,b)=>a+b.amount,0);
  state.rewards = rewR.data||[];
  state.redemptions = redR.data||[];

  // 当前活跃计划的任务
  const activePlan = state.plans.find(p=>p.status==="active");
  if(activePlan){
    const { data: t } = await sb.from("tasks").select("*").eq("plan_id", activePlan.id);
    state.activePlan = activePlan;
    state.tasks = t||[];
  } else { state.activePlan = null; state.tasks = []; }

  render();
}

// ---- 渲染 ----
function render(){
  renderPet();
  renderTasks();
  renderBudget();
  renderExpenses();
  renderRewards();
  renderGoals();
  $("#scoreChip").textContent = "⭐ " + state.score;
}

function petMeta(stage){
  const m = {
    egg:      { e:"🥚",  name:"神秘蛋",        next:"破壳",   need:10 },
    baby:     { e:"🐣",  name:"幼宠",        next:"幼年期", need:30 },
    teen:     { e:"🦜",  name:"成长中的伙伴",   next:"成长期", need:70 },
    final:    { e:"🦅",  name:"终极伙伴",       next:"已满级", need:0 },
  };
  return m[stage]||m.egg;
}
function renderPet(){
  const m = petMeta(state.pet ? state.pet.stage : "egg");
  const total = state.pet ? state.pet.total_points : 0;
  $("#petEmoji").textContent = m.e;
  $("#petName").textContent = `${m.name} · 已积攒 ${total} 分`;
  const pct = m.need ? Math.min(100, total/m.need*100) : 100;
  $("#petBar").style.width = pct + "%";
}
function renderTasks(){
  const box = $("#tasksList");
  const plan = state.activePlan;
  if(!plan || state.tasks.length===0){
    box.innerHTML = `<p style="color:var(--text3);font-size:14px;text-align:center;padding:18px 0">还没有计划，提交一个学习目标，管理员会为你拆成可执行的周计划。</p>`;
    const tag=$("#planTag"); if(tag){tag.textContent="暂无计划";tag.className="tag pend";}
    return;
  }
  const tag=$("#planTag");
  if(tag){tag.textContent=plan.title;tag.className="tag basic";}
  const done = state.tasks.filter(t=>t.done).length;
  box.innerHTML = `<div style="font-size:12px;color:var(--text2);margin-bottom:6px">完成 ${done}/${state.tasks.length}</div>` +
    state.tasks.map(t=>`
      <div class="task ${t.done?'done':''}" data-id="${t.id}">
        <div class="box">${t.done?'✓':''}</div>
        <div class="body">
          <div class="t">${esc(t.content)}</div>
          <div class="s">${t.ttype==='basic'?'基本项':'加分项'}</div>
        </div>
        <div class="pts">+${t.points}</div>
      </div>`).join("");
  box.querySelectorAll(".task").forEach(el=>el.onclick=()=>toggleTask(el.dataset.id));
}
async function toggleTask(id){
  const t = state.tasks.find(x=>x.id===id); if(!t) return;
  const done = !t.done;
  // 先更新任务状态
  await sb.from("tasks").update({ done, done_at: done?new Date().toISOString():null }).eq("id", id);
  // 记分：只有从未完成→完成才算分（防止重复加分）
  if(done && !t.done){
    await sb.from("score_logs").insert({ user_id: S.user.id, amount: t.points, reason: t.content, ref_type:"task", ref_id: id });
    // 喂宠物
    const pet = state.pet;
    if(pet) await sb.from("pets").update({ total_points: (pet.total_points||0)+t.points }).eq("id", pet.id);
  }
  await refresh();
}

// ---- 记账 ----
function currentMonthTopups(){ return state.topups.filter(t=>isSameMonth(t.created_at)); }
function currentMonthExpenses(){ return state.expenses.filter(e=>isSameMonth(e.created_at)); }
function isSameMonth(ts){ if(!ts) return true; const d=new Date(ts), n=new Date(); return d.getFullYear()===n.getFullYear()&&d.getMonth()===n.getMonth(); }

function renderBudget(){
  const total = currentMonthTopups().reduce((a,b)=>a+(+b.amount||0),0);
  const spent = currentMonthExpenses().reduce((a,b)=>a+(+b.amount||0),0);
  $("#bTotal").textContent = "¥"+total;
  $("#bSpent").textContent = "¥"+spent;
  $("#bLeft").textContent = "¥"+Math.max(0,total-spent);
  renderCats(total);
}
function renderCats(totalBudget){
  const cats = state.categories;
  const spentByCat = {};
  currentMonthExpenses().forEach(e=>{ const n=e.category_name||"其他"; spentByCat[n]=(spentByCat[n]||0)+(+e.amount||0); });
  const perCat = cats.length ? totalBudget/cats.length : 0;
  const EMOJI = { "吃饭":"🍚","生活":"🏠","购物":"🛍️","其他":"📦" };
  $("#catList").innerHTML = cats.map(c=>{
    const emoji = EMOJI[c.name] || "🛒";
    const spent = spentByCat[c.name]||0;
    const over = spent > perCat && perCat>0;
    const pct = perCat? Math.min(100, spent/perCat*100):0;
    return `<div class="cat-tag over ${over?'limit':''}" onclick="window.showCat('${esc(c.name)}')">
      <span style="font-size:18px;line-height:1">${emoji}</span>${esc(c.name)}
      <div style="font-size:12px;font-weight:${over?'700':'500'};color:${over?'#ff3b30':'var(--text)'}">${spent}/${Math.round(perCat)}元</div>
      <div class="pet-bar" style="width:100%;margin:0" ><i style="width:${pct}%"></i></div>
    </div>`;
  }).join("");
}
// 添加自定义分类
async function addCategory(){
  showModal(`<h3>＋ 添加分类</h3>
    <div class="field"><label>分类名称</label><input id="mCatName" maxlength="8" placeholder="比如：交通、娱乐"></div>
    <div class="mbtns"><button class="btn ghost" id="mCancel">取消</button><button class="btn" id="mOk">添加</button></div>`);
  $("#mOk").onclick=async()=>{
    const name=$("#mCatName").value.trim();
    if(!name){alert("请输入分类名称");return;}
    if(state.categories.some(c=>c.name===name)){alert("该分类已存在");return;}
    await sb.from("categories").insert({ user_id:S.user.id, name, is_default:false });
    closeModal(); await refresh();
  };
  $("#mCancel").onclick=closeModal;
}
window.addCat = addCategory;
function renderExpenses(){
  const list =[...state.expenses].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).slice(0,20);
  $("#expList").innerHTML = list.length===0?
    `<p style="color:var(--text3);font-size:13px;text-align:center;padding:14px 0">今天还没花钱，省下来啦 🎉</p>` :
    list.map(e=>`
      <div class="task" style="cursor:default">
        <div class="body"><div class="t">${esc(e.category_name||'其他')} ${e.note?esc(e.note):""}</div>
        <div class="s">${fmtTime(e.created_at)}</div></div>
        <div class="pts" style="color:#ff3b30">-¥${e.amount}</div>
      </div>`).join("");
}
function fmtTime(ts){ const d=new Date(ts); return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; }

// ---- 商城 ----
function renderRewards(){
  $("#rewardList").innerHTML = state.rewards.map(r=>{
    const soldOut = (r.stock!=null && +r.stock<=0);
    const stockStr = (r.stock!=null && +r.stock<999) ? `剩 ${r.stock} 件` : "库存充足";
    const btn = soldOut
      ? `<span class="tag pend">已售罄</span>`
      : `<button class="btn small" onclick="window.exchange('${r.id}')">兑换 ${r.cost}⭐</button>`;
    return `<div class="card" style="margin:8px 0">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <div style="flex:1;min-width:0"><b>${esc(r.title)}</b>
          <div style="font-size:12px;color:var(--text3);margin-top:2px">${r.cost} ⭐ · ${stockStr}</div></div>
        <div>${btn}</div>
      </div>
    </div>`;
  }).join("") || `<p style="color:var(--text3);font-size:13px;text-align:center;padding:14px 0">商城还没上架商品，去「想要啥」申请你想要的吧～</p>`;
  renderMyRedempt();
}
function renderMyRedempt(){
  const s = {pending:"审批中",approved:"已上架·可兑换",redeemed:"已兑换",rejected:"已拒绝"};
  $("#myRedempt").innerHTML = state.redemptions.length===0?
    `<p style="color:var(--text3);font-size:13px;text-align:center;padding:14px 0">还没有记录</p>` :
    state.redemptions.map(r=>`
      <div class="task" style="cursor:default">
        <div class="body"><div class="t">${esc(r.want_desc||"奖励")}</div>
        <div class="s">${s[r.status]||r.status}</div></div>
        <div class="pts" style="color:var(--text3)">${r.status==="redeemed"?'✓':''}</div>
      </div>`).join("");
}

// ---- 目标 ----
function renderGoals(){
  const st = {pending:"待拆计划",planned:"计划中",active:"进行中",done:"已完成"};
  $("#goalList").innerHTML = state.goals.length===0?
    `<p style="color:var(--text3);font-size:13px;text-align:center;padding:14px 0">还没提交过目标</p>` :
    state.goals.map(g=>`
      <div class="task" style="cursor:default">
        <div class="body"><div class="t">${esc(g.title)}${g.status==='active'?' <span class="tag basic">进行中</span>':''}</div>
        <div class="s">${st[g.status]||g.status}</div></div>
      </div>`).join("");
}

// ---- 提交目标 ----
async function submitGoal(){
  const v = $("#goalInput").value.trim();
  if(!v) { alert("先写点你想学什么～"); return; }
  const { error } = await sb.from("goals").insert({ user_id: S.user.id, title: v, status:"pending", created_by: S.user.id });
  if(error) alert("提交失败："+error.message);
  $("#goalInput").value="";
  await refresh();
}
// ---- 兑换：直接购买，扣星 + 减库存 ----
async function exchange(id){
  const r = state.rewards.find(x=>x.id===id); if(!r) return;
  if(r.stock!=null && +r.stock<=0){ alert("该商品已售罄了。"); return; }
  if(state.score < r.cost){ alert("星星不够哦，再攒一攒～"); return; }
  showModal(`<h3>💫 兑换「${esc(r.title)}」</h3>
    <p style="color:var(--text2);font-size:14px;margin:4px 0">将扣除 <b>${r.cost} ⭐</b>，确认兑换吗？</p>
    <div class="mbtns"><button class="btn ghost" id="mCancel">取消</button><button class="btn" id="mOk">确认兑换</button></div>`);
  $("#mOk").onclick=async()=>{
    const { error: er } = await sb.from("score_logs").insert({ user_id:S.user.id, amount:-r.cost, reason:"兑换："+r.title, ref_type:"reward", ref_id:r.id });
    if(er){ alert("兑换失败："+er.message); return; }
    const { error: er2 } = await sb.from("redemptions").insert({ reward_id:r.id, user_id:S.user.id, want_desc:r.title, status:"redeemed", decided_at:new Date().toISOString() });
    if(r.stock!=null) await sb.from("rewards").update({ stock:(+r.stock||0)-1 }).eq("id",r.id);
    closeModal(); alert("兑换成功！"); await refresh();
  };
  $("#mCancel").onclick=closeModal;
}
// ---- 我想要：申请商城没有的新东西，管理员批准后上架 ----
function wantReward(){
  showModal(`<h3>🎁 我想要</h3>
    <p style="color:var(--text2);font-size:13px;margin:2px 0 8px">商城没有你想要的东西？写下来，管理员看到后会帮你上架。</p>
    <div class="field"><label>想要什么？</label><input id="mWant" placeholder="比如：去一次游乐场、买个盲盒…"></div>
    <div class="mbtns"><button class="btn ghost" id="mCancel">取消</button><button class="btn" id="mOk">提交</button></div>`);
  $("#mOk").onclick = async ()=>{
    const v=$("#mWant").value.trim(); if(!v){alert("写点内容");return;}
    const { error } = await sb.from("redemptions").insert({ user_id:S.user.id, want_desc:v, status:"pending" });
    if(error) alert("提交失败："+error.message);
    else alert("已提交，管理员看到后会帮你上架。");
    closeModal(); await refresh();
  };
  $("#mCancel").onclick = closeModal;
}
// ---- 加钱 ----
function addMoney(){
  showModal(`<h3>💰 加生活费</h3>
    <div class="field"><label>金额</label><input id="mAmt" type="number" placeholder="输入金额"></div>
    <div class="field"><label>备注</label><input id="mNote" placeholder="微信 / 现金"></div>
    <div class="mbtns"><button class="btn ghost" id="mCancel">取消</button><button class="btn" id="mOk">确认加钱</button></div>`);
  $("#mOk").onclick = async ()=>{
    const amt=+$("#mAmt").value; if(!amt||amt<=0){alert("金额有误");return;}
    await sb.from("budget_topups").insert({ user_id:S.user.id, amount:amt, note:$("#mNote").value, created_by:S.user.id });
    closeModal(); await refresh();
  };
  $("#mCancel").onclick=closeModal;
}
// ---- 记账 ----
function addExpense(){
  const EMOJI = { "吃饭":"🍚","生活":"🏠","购物":"🛍️","其他":"📦" };
  // 分类为空时兜底显示默认4个
  const shown = state.categories.length? state.categories : [{name:"吃饭"},{name:"生活"},{name:"购物"},{name:"其他"}];
  const opts = shown.map(c=>`<div class="seg-opt cat-tag" data-n="${esc(c.name)}">${EMOJI[c.name]||'🛒'}${esc(c.name)}</div>`).join("");
  showModal(`<h3>💸 记一笔</h3>
    <div class="field"><label>分类</label><div class="seg" id="mCat" style="flex-wrap:wrap">${opts}</div></div>
    <div class="field"><label>金额</label><input id="mAmt" type="number" placeholder="0"></div>
    <div class="field"><label>说明</label><input id="mNote" placeholder="买了什么"></div>
    <div class="mbtns"><button class="btn ghost" id="mCancel">取消</button><button class="btn" id="mOk">记下</button></div>`);
  let cat = shown[0].name;
  // 分类选择
  const catOpts = $("#mCat").querySelectorAll(".seg-opt");
  catOpts.forEach(o=>{
    o.onclick=()=>{ catOpts.forEach(x=>x.classList.remove("on")); o.classList.add("on"); cat = o.dataset.n; };
  });
  if(catOpts[0]) catOpts[0].classList.add("on");
  $("#mOk").onclick=async()=>{
    const amt=+$("#mAmt").value; if(!amt||amt<=0){alert("金额有误");return;}
    await sb.from("expenses").insert({ user_id:S.user.id, category_name:cat, amount:amt, note:$("#mNote").value });
    closeModal(); await refresh();
  };
  $("#mCancel").onclick=closeModal;
}

// ---- 弹窗工具 ----
function showModal(html){
  const ov=document.createElement("div"); ov.className="overlay on";
  ov.innerHTML=`<div class="modal"><button class="m-x" id="mX" aria-label="关闭">✕</button>${html}</div>`;
  document.body.appendChild(ov);
  window._ov=ov;
  ov.onclick=e=>{ if(e.target===ov) closeModal(); };
  const x=ov.querySelector("#mX"); if(x) x.onclick=e=>{e.stopPropagation();closeModal();};
}
function closeModal(){ const ov=window._ov; if(ov){ov.classList.remove("on");setTimeout(()=>ov.remove(),200);} window._ov=null; }

// ---- 页面切换 ----
function switchPage(name){
  document.querySelectorAll(".page").forEach(p=>p.classList.remove("on"));
  document.querySelectorAll(".nav .n").forEach(n=>n.classList.toggle("on",n.dataset.pg===name));
  const pg=document.getElementById("pg-"+name); if(pg) pg.classList.add("on");
}
function bindEvents(){
  document.querySelectorAll(".nav .n").forEach(n=>n.onclick=()=>switchPage(n.dataset.pg));
  $("#submitGoal").onclick=submitGoal;
  $("#addMoneyBtn").onclick=addMoney;
  $("#addExpBtn").onclick=addExpense;
  $("#wantBtn").onclick=wantReward;
}

// ---- 退出登录：用事件委托，不依赖初始化流程，保证任何时候都能点 ----
function doLogout(){
  showModal(`<h3>🔓 退出登录</h3>
    <p style="color:var(--text2);font-size:14px;margin:4px 0">确定要退出当前账号吗？</p>
    <div class="mbtns"><button class="btn ghost" id="mCancel">取消</button><button class="btn" id="mOk">退出</button></div>`);
  $("#mOk").onclick=async()=>{ closeModal(); await S.signOut(); location.href="../login.html"; };
  $("#mCancel").onclick=closeModal;
}
document.addEventListener("click",function(e){
  var t=e.target; while(t){ if(t.id==="logoutBtn"){ e.preventDefault(); doLogout(); return; } t=t.parentNode; }
}, true);

// 暴露给内联 onclick
window.showCat = n=>alert("「"+n+"」已花 "+(currentMonthExpenses().filter(e=>e.category_name===n).reduce((a,b)=>a+(+b.amount||0),0))+" 元");
window.exchange = exchange;

function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

guard();
})();