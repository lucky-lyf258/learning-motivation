// ============================================
// 学习激励系统 · 管理员端逻辑
// 职责：待拆计划→AI拆计划→推给弟弟；管奖励/批兑换；看记账看板
// ============================================
(function(){
const C = window.APP, S = window.Shared, sb = S.sb;
const $ = s=>document.querySelector(s);

const ADMIN_ID = "admin-local";   // 内置管理员的审计标识（本地登录，无 Supabase 用户）
let targetKidId = null;           // 当前孩子的 user_id

async function guard(){
  // 管理员为内置账号，通过本地会话校验（login.html 写入 sessionStorage.lm_admin）
  if(sessionStorage.getItem("lm_admin")!=="1"){
    location.href="../login.html"; return;
  }
  bindEvents();
  await refresh();
  switchSec("pendingGoals");
}
function switchSec(name){
  document.querySelectorAll(".tabs .t").forEach(t=>t.classList.toggle("on",t.dataset.sec===name));
  document.querySelectorAll(".sec").forEach(s=>s.classList.toggle("on",s.id==="sec-"+name));
}

async function refresh(){
  await Promise.all([loadKids(), loadPendingGoals(), loadPlans(), loadRewards(), loadRedemptions(), loadFinance()]);
  loadKidOverview();
}
// 找到孩子的账号（user 角色）
async function loadKids(){
  const { data } = await sb.from("profiles").select("*").eq("role", C.ROLE_USER);
  const kids = data||[];
  if(kids.length===1) targetKidId = kids[0].id;
  else if(targetKidId && !kids.find(k=>k.id===targetKidId)) targetKidId = kids[0]?.id||null;
}

// ---- 待拆计划 ----
async function loadPendingGoals(){
  await loadKids();
  const { data } = await sb.from("goals").select("*").eq("status","pending").order("created_at",{ascending:false});
  const goals = data||[];
  const box = $("#pendingGoalList");
  if(goals.length===0){
    box.innerHTML = `<div class="card center">暂无待拆的学习目标。弟弟在「目标」页提交后，会显示在这里。</div>`;
    return;
  }
  box.innerHTML = goals.map(g=>`
    <div class="card">
      <div class="row">
        <div class="info">
          <div class="name">🎯 ${esc(g.title)}</div>
          ${g.detail?`<div class="meta">${esc(g.detail)}</div>`:""}
          <div class="meta">提交于 ${fmtDT(g.created_at)}</div>
        </div>
        <div class="act">
          <button class="btn" data-gid="${g.id}" onclick="AI.generatePlan('${g.id}')">🤖 AI 拆计划</button>
          <button class="btn grey small" data-gid="${g.id}" onclick="AI.manualPlan('${g.id}')">手动安排</button>
        </div>
      </div>
    </div>`).join("");
}
function fmtDT(ts){ const d=new Date(ts); return `${d.getMonth()+1}月${d.getDate()}日 ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; }
function fmtD(ts){ if(!ts)return "—"; const d=new Date(ts); return `${d.getMonth()+1}/${d.getDate()}`; }

// ---- AI 拆计划（DeepSeek） ----
window.AI = {
  async generatePlan(goalId){
    const goal = (await sb.from("goals").select("*").eq("id",goalId).single()).data;
    if(!goal) return;
    const title = prompt("这一阶段计划的名字（可默认）：", "阶段目标："+goal.title) || ("阶段目标："+goal.title);
    const days = parseInt(prompt("这周安排到哪几天？比如：读书 1234567（表示周一到周日都要做）。可留空默认「每天」", "") || "1234567");
    showAI(`
      <h3>🤖 AI 正在拆计划…</h3>
      <div class="loading"><span class="ai-dots"><span></span><span></span><span></span></span> 正在为「${esc(goal.title)}」安排本周计划</div>
      <div style="max-height:240px;overflow:auto" id="aiDraft"></div>
      <div class="act" style="margin-top:12px;display:none" id="aiDone">
        <button class="btn" id="aiConfirm">确认并推给弟弟</button>
        <button class="btn ghost" id="aiEdit">手动调整</button>
        <button class="btn grey" id="aiCancel">取消</button>
      </div>
    `);
    try{
      const result = await callDeepSeek(goal, days);
      const tasks = parseTasks(result);
      // 显示草稿
      const draft = $("#aiDraft"); if(draft) draft.innerHTML = renderDraft(goal.title, title, tasks);
      $("#aiDone").style.display="block";
      // 缓存
      window._aiDraft = { goal, title, tasks };
      $("#aiLoad") && ($("#aiLoad").style.display="none");
      $("#aiConfirm").onclick = ()=>{ closeModal(); savePlan(window._aiDraft); };
      $("#aiEdit").onclick = ()=>{ closeModal(); AI.manualPlan(goalId); };
      $("#aiCancel").onclick = closeModal;
    }catch(e){
      showAI(`<h3>AI 出错了</h3><p class="center" style="color:var(--red)">${esc(e.message)}</p>
        <button class="btn grey" onclick="window.__closeAI()">关闭</button>`);
      window.__closeAI=closeModal;
    }
  },

  // 手动安排计划
  async manualPlan(goalId){
    const goal = (await sb.from("goals").select("*").eq("id",goalId).single()).data;
    if(!goal) return;
    const title = prompt("阶段计划名称：", "阶段目标："+goal.title)||"阶段目标："+goal.title;
    // 收集基本项和加分项
    const basics=[], bonus=[];
    while(true){
      const v=prompt("添加一个基本项（完成+5分）。留空结束：","").trim();
      if(!v)break; basics.push({content:v,points:5});
    }
    while(true){
      const v=prompt("添加一个加分项（完成+1分）。留空结束：","").trim();
      if(!v)break; bonus.push({content:v,points:1});
    }
    if(basics.length+bonus.length===0){ alert("没有任务，未创建"); return; }
    await savePlan({ goal, title, tasks:[...basics.map(t=>({...t,ttype:"basic"})), ...bonus.map(t=>({...t,ttype:"bonus"}))] });
  }
};

async function callDeepSeek(goal, days){
  const promptText = `你是一名帮家长给孩子拆解学习计划的老师。请把孩子的一个学习目标拆成一个"阶段计划"，包含若干个基本项和加分项，用于每天打卡。
目标：${goal.title}
每行格式：类型|内容
- 基本项(完成+5分)，最能促进目标达成日常必做的事，例如"读《三体》30页"
- 加分项(完成+1分)，附加的拓展、主动行为，例如"写一段读后感"
要求：
- 基本项 4~6 个，加分项 3~4 个
- 内容具体、可当天完成、适合${"小学生到高中生"}年龄段
- 只输出列表，每行严格 "基本项:内容" 或 "加分项:内容"，不要多余文字`;
  const res = await fetch(C.DEEPSEEK_URL, {
    method:"POST",
    headers:{ "Content-Type":"application/json", "Authorization":"Bearer "+C.DEEPSEEK_KEY },
    body: JSON.stringify({ model:"deepseek-chat", messages:[{role:"user",content:promptText}], temperature:0.7 })
  });
  if(!res.ok){
    const t=await res.text().catch(()=>"");
    throw new Error("AI 调用失败 ("+res.status+") "+(t.includes("quota")?"余额不足，请去 DeepSeek 充值":t.slice(0,80)));
  }
  const j=await res.json();
  const text = j.choices?.[0]?.message?.content || "";
  return text;
}
function parseTasks(text){
  const tasks=[];
  text.split(/\n/).forEach(line=>{
    const m = line.match(/^(\s*)(基本项|加分项)\s*[:：]\s*(.+)$/) || line.match(/(基本项|加分项)[:：]\s*(.+)/);
    if(m){ tasks.push({ content:m[3]||m[2], ttype:m[2]==="基本项"?"basic":"bonus", points:m[2]==="基本项"?5:1 }); }
  });
  if(tasks.length===0){ // 兜底
    throw new Error("AI 返回内容无法解析，请手动安排");
  }
  return tasks;
}
function renderDraft(gt,title,tasks){
  const basic=tasks.filter(t=>t.ttype==="basic"), bonus=tasks.filter(t=>t.ttype==="bonus");
  return `
    <div style="font-size:12px;color:var(--text2)">目标：${esc(gt)}</div>
    <div style="font-size:13px;font-weight:600;margin:8px 0">📋 ${esc(title)}</div>
    <div style="font-size:12px;font-weight:600;color:#1f9d4b">基本项 +5分</div>
    ${basic.map((t,i)=>`<div class="task-mini basic">${i+1}. ${esc(t.content)}<span class="pt">+5</span></div>`).join("")}
    <div style="font-size:12px;font-weight:600;color:#e07f00;margin-top:8px">加分项 +1分</div>
    ${bonus.map((t,i)=>`<div class="task-mini bonus">${i+1}. ${esc(t.content)}<span class="pt">+1</span></div>`).join("")}`;
}
async function savePlan({goal,title,tasks}){
  try{
    const { data: plan } = await sb.from("plans").insert({ goal_id:goal.id, title, status:"active", created_by:ADMIN_ID }).select().single();
    await sb.from("tasks").insert(tasks.map(t=>({ plan_id:plan.id, content:t.content, ttype:t.ttype, points:t.points })));
    // 停用其它旧计划
    await sb.from("plans").update({ status:"archived" }).neq("id",plan.id).eq("status","active");
    // 更新目标为 active
    await sb.from("goals").update({ status:"active" }).eq("id",goal.id);
    alert("✅ 计划已生成并推给弟弟！");
    await refresh();
  }catch(e){ alert("保存失败："+e.message); }
}

// ---- 计划管理 ----
async function loadPlans(){
  const { data } = await sb.from("plans").select("*").order("created_at",{ascending:false});
  const plans=data||[];
  const box=$("#planList");
  if(plans.length===0){ box.innerHTML=`<div class="card center">还没有计划</div>`; return; }
  const cards = await Promise.all(plans.slice(0,6).map(async p=>{
    const { data: tasks } = await sb.from("tasks").select("*").eq("plan_id",p.id);
    return `<div class="card">
      <div class="row">
        <div class="info">
          <div class="name">${esc(p.title)} <span class="badge ${p.status==='active'?'':'grey'}">${p.status==='active'?'进行中':'已归档'}</span></div>
          <div class="meta">${(tasks||[]).length} 个任务 · 创建于 ${fmtD(p.created_at)}</div>
          <div style="margin-top:6px">${(tasks||[]).map(t=>`<span class="tag ${t.ttype==='basic'?'planned':'warn'}" style="margin:2px">${esc(t.content)}${t.done?'✓':''}</span>`).join("") || '<span class="tag grey">空</span>'}</div>
        </div>
        <div class="act">
          ${p.status==='active'?`<button class="btn ghost" onclick="AI.endPlan('${p.id}')">结束</button>`:""}
        </div>
      </div>
    </div>`;
  }));
  box.innerHTML = cards.join("");
}
window.AI.endPlan=async function(id){
  if(!confirm("确认结束这个计划？"))return;
  await sb.from("plans").update({status:"archived"}).eq("id",id);
  await refresh();
};

// ---- 奖励商城管 ----
async function loadRewards(){
  const { data } = await sb.from("rewards").select("*").order("created_at",{ascending:false});
  const box=$("#rewardList");
  box.innerHTML=(data||[]).map(r=>`
    <div class="row">
      <div class="info"><div class="name">${esc(r.title)}</div>
        <div class="meta">需要 <b>${r.cost}</b> ⭐ · ${r.status==='active'?'上架中':'已下架'}</div></div>
      <div class="act">
        <button class="btn ghost" onclick="AI.toggleReward('${r.id}','${r.status}')">${r.status==='active'?'下架':'上架'}</button>
      </div>
    </div>`).join("")||`<div class="center">还没有奖励，点「新增奖励」设置一个。</div>`;
}
window.AI.toggleReward=async(id,st)=>{ await sb.from("rewards").update({status:st==='active'?'inactive':'active'}).eq("id",id); await loadRewards(); };
$("#addReward").onclick=()=>{
  showModal(`<h3>🎁 新增奖励</h3>
    <div class="field"><label>奖励内容</label><input id="mTitle" placeholder="如：周末去一次游乐场"></div>
    <div class="field"><label>需要分数（多少 ⭐ 可兑换）</label><input id="mCost" type="number" placeholder="如 50"></div>
    <div class="grid2"><div><button class="btn ghost" id="mCancel" style="width:100%">取消</button></div>
    <div><button class="btn" id="mOk" style="width:100%">添加</button></div></div>`);
  $("#mOk").onclick=async()=>{
    const t=$("#mTitle").value.trim(), c=+$("#mCost").value||0;
    if(!t){alert("填写奖励内容");return;}
    await sb.from("rewards").insert({title:t,cost:c,status:"active",created_by:ADMIN_ID});
    closeModal(); loadRewards();
  };
  $("#mCancel").onclick=closeModal;
};

async function loadRedemptions(){
  const { data } = await sb.from("redemptions").select("*").eq("status","pending").order("created_at",{ascending:false});
  const reds=data||[];
  const box=$("#redemptionList");
  if(reds.length===0){ box.innerHTML=`<div class="center">没有待处理的兑换申请</div>`; return; }
  box.innerHTML = reds.map(r=>`
    <div class="row">
      <div class="info">
        <div class="name">🎁 ${esc(r.want_desc||"兑换奖励")}${r.cost?` <span class="badge">${r.cost} ⭐</span>`:""}</div>
        <div class="meta">孩子提交于 ${fmtDT(r.created_at)}</div>
      </div>
      <div class="act" style="flex-direction:row;gap:6px">
        ${r.cost?`<button class="btn" onclick="AI.approve('${r.id}',${r.cost})">批准扣分</button>`:`<button class="btn" onclick="AI.approve('${r.id}')">批准</button>`}
        <button class="btn red" onclick="AI.reject('${r.id}')">拒绝</button>
      </div>
    </div>`).join("");
}
window.AI.approve=async(id,cost)=>{
  if(cost && !confirm(`批准并扣除孩子 ${cost} 分？`))return;
  const red=(await sb.from("redemptions").select("*").eq("id",id).single()).data;
  if(!red)return;
  // 扣分
  await sb.from("redemptions").update({status:"approved",decided_by:ADMIN_ID,decided_at:new Date().toISOString()}).eq("id",id);
  if(cost) await sb.from("score_logs").insert({ user_id:red.user_id, amount:-cost, reason:"兑换："+(red.want_desc||""), ref_type:"reward", ref_id:id });
  alert("已批准");
  await refresh();
};
window.AI.reject=async(id)=>{
  await sb.from("redemptions").update({status:"rejected",decided_by:ADMIN_ID,decided_at:new Date().toISOString()}).eq("id",id);
  alert("已拒绝");
  await loadRedemptions();
};

// ---- 记账看板 ----
async function loadFinance(){
  await loadKids();
  if(!targetKidId){ $("#finBoard").innerHTML=`<div class="card center">还没有孩子账号。请先用手机/登录页注册一个「用户」账号。</div>`; return; }
  const uid=targetKidId;
  const [ topR, expR, catR ] = await Promise.all([
    sb.from("budget_topups").select("*").eq("user_id",uid),
    sb.from("expenses").select("*").eq("user_id",uid),
    sb.from("categories").select("*").eq("user_id",uid),
  ]);
  const topups=topR.data||[], exps=(expR.data||[]).filter(e=>sameMonth(e.created_at));
  const cats=catR.data||[];
  const total=topups.reduce((a,b)=>a+(+b.amount||0),0);
  const spent=exps.reduce((a,b)=>a+(+b.amount||0),0);
  const perCat=cats.length?total/cats.length:0;
  const spentBy={};
  exps.forEach(e=>spentBy[e.category_name]=(spentBy[e.category_name]||0)+(+e.amount||0));
  $("#finBoard").innerHTML=`
    <div class="card">
      <div class="stat">
        <div class="s"><b>¥${total}</b><small>本月收入</small></div>
        <div class="s"><b>¥${spent}</b><small>已花</small></div>
        <div class="s"><b>¥${Math.max(0,total-spent)}</b><small>结余</small></div>
      </div>
      <div style="margin-top:10px">
        <b style="font-size:14px">分类额度</b>
        <div style="margin-top:8px">${cats.map(c=>{
          const spt=spentBy[c.name]||0, over=spt>perCat;
          return `<div class="task-mini"><span>${esc(c.name)}</span><span class="pt" style="color:${over?'var(--red)':'var(--text2)'}">${spt}/${Math.round(perCat)}${over?' ⚠️超':''}</span></div>`;
        }).join("")||'<div class="center">无分类</div>'}</div>
      </div>
    </div>
    <div class="card"><b>最近支出</b><div style="margin-top:8px">${exps.slice().sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).slice(0,10).map(e=>`
      <div class="task-mini"><span>${esc(e.category_name||'其他')} ${e.note?esc(e.note):""}</span><span class="pt" style="color:var(--red)">-¥${e.amount}</span></div>`).join("")}</div></div>`;
}
function sameMonth(ts){ if(!ts)return true; const d=new Date(ts),n=new Date(); return d.getFullYear()===n.getFullYear()&&d.getMonth()===n.getMonth(); }

// ---- 孩子概况 ----
async function loadKidOverview(){
  await loadKids();
  if(!targetKidId){ $("#kidOverview").innerHTML=`<div class="card center">暂无孩子账号</div>`; return; }
  const uid=targetKidId;
  const { data: pet }= await sb.from("pets").select("*").eq("user_id",uid).maybeSingle();
  const { data: logs}= await sb.from("score_logs").select("amount").eq("user_id",uid);
  const score=(logs||[]).reduce((a,b)=>a+b.amount,0);
  const { data: goals}= await sb.from("goals").select("*").eq("user_id",uid);
  const { data: pets2}= await sb.from("pets").select("stage,total_points").eq("user_id",uid);
  const meta={egg:["🥚","神秘蛋"],baby:["🐣","小可爱"],teen:["🦜","成长中"],final:["🦅","终极伙伴"]};
  const m=meta[(pets2&&pets2[0]&&pets2[0].stage)||'egg']||meta.egg;
  $("#kidOverview").innerHTML=`
    <div class="card">
      <div style="display:flex;gap:16px;align-items:center">
        <div style="font-size:56px">${m[0]}</div>
        <div><b style="font-size:17px">孩子的宠物：${m[1]}</b>
          <div class="meta">累计喂宠物 ${(pets2&&pets2[0]&&pets2[0].total_points)||0} 分</div></div>
      </div>
      <div style="display:flex;gap:20px;margin-top:14px;font-size:14px">
        <span>⭐ 当前分数 <b>${score}</b></span>
        <span>🎯 目标 <b>${(goals||[]).length}</b> 个</span>
      </div>
    </div>`;
}

// ---- UI工具 ----
function showModal(html){
  const ov=document.createElement("div"); ov.className="modal-bg on"; ov.innerHTML=`<div class="modal">${html}</div>`;
  document.body.appendChild(ov); window._ov=ov;
  ov.onclick=e=>{if(e.target===ov)closeModal()};
}
function closeModal(){ const ov=window._ov; if(ov){ov.classList.remove("on");setTimeout(()=>ov.remove(),200);} window._ov=null; }
function showAI(html){ showModal(html); }
function bindEvents(){
  document.querySelectorAll(".tabs .t").forEach(t=>t.onclick=()=>switchSec(t.dataset.sec));
  $("#logoutBtn").onclick=async()=>{ sessionStorage.removeItem("lm_admin"); location.href="../login.html"; };
}
function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

guard();
})();