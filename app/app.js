// ============================================
// 学习激励系统 · 用户端（弟弟/手机）逻辑
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
  await refresh();
  bindEvents();
  switchPage("home");
  return true;
}

// ---- 刷新所有数据 ----
async function refresh(){
  const uid = S.user.id;
  const pr = m=>Promise.all(m.map(async t=>{ try{ const {data}=await sb.from(t).select("*").eq("user_id",uid); return {t,d:data||[]}; }catch(e){ return {t,d:[]}; } }));

  const [catR, expR, topR, goalR, planR, petR] = await pr(["categories","expenses","budget_topups","goals","plans","pets"]);
  state.categories = catR.d;
  state.expenses = expR.d;
  state.topups = topR.d;
  state.goals = goalR.d;
  state.plans = planR.d;
  state.pet = petR.d && petR.d[0] ? petR.d[0] : { stage:"egg", total_points:0 };
  if(!state.pet.id) state.pet = null;

  // 分数汇总：所有 + 记录求和
  const { data: slogs } = await sb.from("score_logs").select("amount").eq("user_id",uid);
  state.score = (slogs||[]).reduce((a,b)=>a+b.amount,0);

  // 当前活跃计划的任务
  const activePlan = state.plans.find(p=>p.status==="active");
  if(activePlan){
    const { data: t } = await sb.from("tasks").select("*").eq("plan_id", activePlan.id);
    state.activePlan = activePlan;
    state.tasks = t||[];
  } else { state.activePlan = null; state.tasks = []; }

  // 商城奖励 + 我的兑换
  const { data: rew } = await sb.from("rewards").select("*").eq("status","active");
  state.rewards = rew||[];
  const { data: red } = await sb.from("redemptions").select("*").eq("user_id",uid).order("created_at",{ascending:false});
  state.redemptions = red||[];

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
  $("#rewardList").innerHTML = state.rewards.map(r=>`
    <div class="card" style="margin:8px 0">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div><b>${esc(r.title)}</b><div style="font-size:12px;color:var(--text3)">${r.desc||""}</div></div>
        <button class="btn small" data-id="${r.id}" onclick="window.exchange('${r.id}')">${r.cost} ⭐</button>
      </div>
    </div>`).join("") || `<p style="color:var(--text3);font-size:13px;text-align:center;padding:14px 0">商城还在准备中～</p>`;
  renderMyRedempt();
}
function renderMyRedempt(){
  const s = {pending:"审批中",approved:"已通过",rejected:"已拒绝"};
  $("#myRedempt").innerHTML = state.redemptions.length===0?
    `<p style="color:var(--text3);font-size:13px;text-align:center;padding:14px 0">还没有兑换记录</p>` :
    state.redemptions.map(r=>`
      <div class="task" style="cursor:default">
        <div class="body"><div class="t">${esc(r.want_desc||("兑换："+(state.rewards.find(x=>x.id===r.reward_id)?.title||"")))}</div>
        <div class="s">${s[r.status]||r.status}</div></div>
        <div class="pts" style="color:var(--text3)">-${r.cost||'?'}⭐</div>
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
// ---- 兑换 ----
async function exchange(id){
  const r = state.rewards.find(x=>x.id===id);
  if(!r) return;
  if(!confirm(`要用 ${r.cost} 分兑换「${r.title}」吗？`)) return;
  const { error } = await sb.from("redemptions").insert({ reward_id:id, user_id:S.user.id, want_desc:r.title, status:"pending", cost:r.cost });
  if(error) alert("失败："+error.message); else alert("已提交兑换申请，等待管理员批准。");
  await refresh();
}
// ---- 我想要 ----
function wantReward(){
  showModal(`<h3>🎁 我想要这个奖励</h3>
    <div class="field"><label>想要什么？</label><input id="mWant" placeholder="比如：去一次游乐场、买个盲盒…"></div>
    <div class="mbtns"><button class="btn ghost" id="mCancel">取消</button><button class="btn" id="mOk">提交</button></div>`);
  $("#mOk").onclick = async ()=>{
    const v=$("#mWant").value.trim(); if(!v){alert("写点内容");return;}
    await sb.from("redemptions").insert({ user_id:S.user.id, want_desc:v, status:"pending", cost:0 });
    alert("已提交，管理员会为你评估并设置所需积分。");
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

// 暴露给内联 onclick
window.showCat = n=>alert("「"+n+"」已花 "+(currentMonthExpenses().filter(e=>e.category_name===n).reduce((a,b)=>a+(+b.amount||0),0))+" 元");
window.exchange = exchange;

function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

guard();
})();