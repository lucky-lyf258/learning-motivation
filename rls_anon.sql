-- ============================================
-- 学习激励系统 · 权限补充脚本 v3（仅新增 anon 策略，不动旧策略，避免死锁）
-- 用途：让管理员端（内置 admin，用 anon key）能读写全部数据
-- 说明：原 schema 已存在 to authenticated 的策略；此处只为 anon 补策略
-- 执行：Supabase -> SQL Editor -> 整段粘贴 -> Run
-- ============================================

do $$
declare t text;
begin
  foreach t in array array['profiles','goals','plans','tasks','score_logs','categories','budget_topups','expenses','rewards','redemptions','pets'] loop
    execute format('drop policy if exists "anon_%s" on public.%I', t, t);
    execute format('create policy "anon_%s" on public.%I for all to anon using (true) with check (true);', t, t);
  end loop;
end $$;