// ============================================
// 学习激励系统 · 共享登录与数据层
// 两端的页面都要引：config.js + supabase CDN + 本文件
// ============================================
(function(){
  const C = window.APP;
  window.supabaseClient = supabase.createClient(C.SUPABASE_URL, C.SUPABASE_KEY);

  const sb = window.supabaseClient;
  const S = {
    _user: null,
    _profile: null,

    async init(){
      const { data:{ user }, error } = await sb.auth.getUser();
      if(!error && user){ S._user = user; await S.loadProfile(); }
      return S._user;
    },

    // 当前登录用户
    get user(){ return S._user; },
    get profile(){ return S._profile; },
    get isAdmin(){ return S._profile && S._profile.role === C.ROLE_ADMIN; },
    get isUser(){ return S._profile && S._profile.role === C.ROLE_USER; },

    async loadProfile(){
      if(!S._user) return null;
      const { data } = await sb.from("profiles").select("*").eq("id", S._user.id).maybeSingle();
      if(!data){
        // 没有档案则建一个（默认 user 角色）
        const r = await sb.from("profiles").insert({
          id: S._user.id, email: S._user.email, role: C.ROLE_USER, nickname: S._user.email||"用户"
        }).select().single();
        S._profile = r.data;
        // 给新用户创建默认花费类别
        await sb.from("categories").insert([
          { user_id: S._user.id, name: "吃饭", is_default: true },
          { user_id: S._user.id, name: "生活", is_default: true },
          { user_id: S._user.id, name: "购物", is_default: true },
          { user_id: S._user.id, name: "其他", is_default: true },
        ]);
        // 创建初始宠物蛋
        await sb.from("pets").insert({ user_id: S._user.id, stage: "egg", total_points: 0 });
      } else S._profile = data;
      return S._profile;
    },

    // ---- 认证 ----
    async signUp(email, password, nickname){
      const { data, error } = await sb.auth.signUp({ email, password, options:{ data:{ nickname } } });
      if(error) return { error: error.message };
      // 档案默认 role=user（所有注册用户都是普通用户；管理员为内置）
      const { error: perr } = await sb.from("profiles").upsert({
        id: data.user.id, email, role: C.ROLE_USER, nickname
      });
      if(perr) console.warn("档案写入:", perr.message);
      await S.signIn(email, password);
      return { ok: true };
    },

    async signIn(email, password){
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if(error) return { error: error.message };
      S._user = data.user;
      await S.loadProfile();
      return { ok: true, role: S._profile && S._profile.role };
    },

    async signOut(){ await sb.auth.signOut(); S._user=null; S._profile=null; },

    // ---- 实时订阅（两端共享数据） ----
    onChanged(table, cb){
      return sb.channel("rt-"+table).on("postgres_changes", { event:"*", schema:"public", table }, payload=>cb(payload)).subscribe();
    },

    // ---- 通用查询 ----
    from(t){ return sb.from(t); },
    sb
  };

  window.Shared = S;
})();