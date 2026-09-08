-- ============================================
-- 学习激励系统 · Supabase 建表脚本
-- 在 Supabase 控制台 SQL Editor 中整段粘贴执行
-- ============================================

-- 开启扩展（用于自动生成 uuid、实时同步）
create extension if not exists "pgcrypto";
create extension if not exists "supabase_vault" schema extensions;

-- 1) 用户档案（角色：admin 管理端 / user 弟弟用户端）
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  role text not null default 'user' check (role in ('admin','user')),
  nickname text,
  created_at timestamptz default now()
);

-- 2) 学习目标（弟弟提交"我想学"）
create table if not exists public.goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,   -- 目标属于哪个弟弟
  title text not null,
  detail text,
  status text not null default 'pending',                     -- pending已提交 planned已拆计划 active进行中 done完成
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);

-- 3) 阶段计划（一次目标 → 一套计划，可多套）
create table if not exists public.plans (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid references public.goals(id) on delete cascade,
  title text,                                                 -- 如：读《三体》第1-2周
  start_date date,
  end_date date,
  status text not null default 'active',                      -- active进行中 archived已归档
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);

-- 4) 计划任务（基本项+5 / 加分项+1）
create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid references public.plans(id) on delete cascade,
  content text not null,
  ttype text not null check (ttype in ('basic','bonus')),     -- basic基本项 bonus加分项
  points int not null default 0,
  day_index int,                                              -- 周几(1-7)
  done boolean not null default false,
  done_at timestamptz,
  created_at timestamptz default now()
);

-- 5) 分数流水（+5 / +1 / 兑换扣分）
create table if not exists public.score_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  amount int not null,                                        -- 正=得分 负=扣分
  reason text,
  ref_type text,                                              -- 'task'计划 'reward'奖励
  ref_id uuid,
  created_at timestamptz default now()
);

-- 6) 记账·类别
create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,   -- 属于哪个弟弟
  name text not null,
  is_default boolean default false,
  created_at timestamptz default now()
);

-- 7) 记账·生活费充值（手动加钱）
create table if not exists public.budget_topups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  amount numeric not null,
  note text,
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);

-- 8) 记账·支出
create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  category_id uuid references public.categories(id) on delete set null,
  category_name text,
  amount numeric not null,
  note text,
  spent_on date default current_date,
  created_at timestamptz default now()
);

-- 9) 商城奖励（管理员设置）
create table if not exists public.rewards (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  cost int not null default 0,                                -- 需要多少分
  status text not null default 'active',
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);

-- 10) 兑换申请（弟弟提交 → 管理员批准/拒绝）
create table if not exists public.redemptions (
  id uuid primary key default gen_random_uuid(),
  reward_id uuid references public.rewards(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  want_desc text,                                             -- 若弟弟自提想要的奖励
  status text not null default 'pending',                     -- pending已提交 approved批准 rejected拒绝
  decided_by uuid references auth.users(id),
  decided_at timestamptz,
  created_at timestamptz default now()
);

-- 11) 宠物（当前养成状态）
create table if not exists public.pets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  stage text not null default 'egg',                          -- egg蛋 baby幼崽 teen成长期 final最终
  total_points int not null default 0,                        -- 累计喂宠物分数
  species text default 'default',
  updated_at timestamptz default now()
);

-- ------------------------------------------------------------
-- 安全策略 (RLS)：本人可读写自己，管理员可读写所有
-- 注意：此段为简化开放策略，适合家庭自用；如需更严可在管理台调
-- ------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.goals enable row level security;
alter table public.plans enable row level security;
alter table public.tasks enable row level security;
alter table public.score_logs enable row level security;
alter table public.categories enable row level security;
alter table public.budget_topups enable row level security;
alter table public.expenses enable row level security;
alter table public.rewards enable row level security;
alter table public.redemptions enable row level security;
alter table public.pets enable row level security;

-- 简易策略：登录用户均可读写(家庭自用简化)。更严可后续改。
do $$
declare t text;
begin
  foreach t in array array['profiles','goals','plans','tasks','score_logs','categories','budget_topups','expenses','rewards','redemptions','pets'] loop
    execute format('create policy "p_all_%s" on public.%I for all to authenticated using (true) with check (true);', t, t);
  end loop;
end $$;

-- 插入默认花费类别（吃饭/生活/社交）—— 初始给所有已存在用户；若尚未有用户可忽略
-- 实际默认类别将在代码里对每个新用户自动创建