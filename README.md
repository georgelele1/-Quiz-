# HealthPath 健康评估与订阅系统

HealthPath 是一个基于 Next.js 14、TypeScript、Prisma 和 PostgreSQL 的健康问卷产品。用户完成问卷后可以看到 BMI 和基础健康状态，完整训练计划、饮食宏量营养建议、体重趋势和视频内容通过试用或付费订阅解锁。

项目包含：

- 12 步健康问卷
- BMI、BMR、TDEE、目标体重周期计算
- 7 天个性化训练计划
- 免费试用与付费订阅权限控制
- mock 支付页面
- 视频内容权限控制
- Prisma 数据模型
- Render PostgreSQL + Vercel 部署支持

---

## 技术栈

| 类型 | 技术 |
|---|---|
| 前端 | Next.js App Router、React、TypeScript |
| 样式 | Tailwind CSS |
| 后端 | Next.js Route Handlers |
| 数据库 | PostgreSQL |
| ORM | Prisma |
| 部署 | Vercel |
| 数据库托管 | Render PostgreSQL |
| 测试 | Jest |

---

## 本地运行

进入项目目录：

```powershell
cd "C:\Users\Georgelele\Claude\Projects\interview product\health-quiz-app"
```

安装依赖：

```powershell
npm install
```

创建 `.env` 文件，并配置数据库连接：

```env
DATABASE_URL="你的 Render External Database URL"
```

生成 Prisma Client：

```powershell
npx prisma generate
```

同步数据库结构：

```powershell
npx prisma db push
```

启动开发环境：

```powershell
npm run dev
```

打开：

```text
http://localhost:3000
```

---

## 常用命令

```powershell
npm run dev          # 启动本地开发服务器
npm run build        # 构建生产版本
npm run start        # 启动生产构建
npm run test         # 运行测试
npm run db:generate  # 生成 Prisma Client
npm run db:push      # 同步 Prisma schema 到数据库
npm run db:seed      # 写入 demo 数据
```

如果本地提示找不到 `node`、`npm` 或 `npx`，需要先安装 Node.js，或者确认 Node.js 已加入系统 PATH。

---

## 环境变量

项目至少需要：

```env
DATABASE_URL="postgresql://..."
```

如果部署到 Vercel，需要在 Vercel 后台添加同名环境变量：

```text
Settings -> Environment Variables -> DATABASE_URL
```

使用 Render PostgreSQL 时，请使用 Render 提供的 `External Database URL`，不要使用 `Internal Database URL`。

---

## Vercel 部署

### 1. 推送代码

```powershell
git push
```

如果 Vercel 已经连接 GitHub 仓库，push 后会自动触发部署。

### 2. 配置环境变量

在 Vercel 项目后台添加：

```env
DATABASE_URL="你的 Render PostgreSQL External Database URL"
```

环境选择：

```text
Production and Preview
```

### 3. 配置构建命令

建议 Vercel 的 Build Command 使用：

```text
npx prisma generate && npm run build
```

因为项目使用 Prisma，部署时必须先生成 Prisma Client。

### 4. 同步数据库

如果 Prisma schema 有变化，本地执行：

```powershell
npx prisma db push
```

然后再重新部署 Vercel。

---

## 问卷流程

当前问卷共有 12 步：

| 步骤 | 内容 | 主要字段 |
|---|---|---|
| 1 | 性别 | `gender` |
| 2 | 年龄 | `age` |
| 3 | 主要目标 | `goal` |
| 4 | 重点改善区域 | `focusAreas` |
| 5 | 喜欢的运动类型 | `activityTypes` |
| 6 | 身高体重 | `heightCm`, `weightKg` |
| 7 | 目标体重 | `targetWeightKg` |
| 8 | 活动水平 | `activityLevel` |
| 9 | 饮食偏好 | `dietPreference` |
| 10 | 目标达成时间 | `targetDate`, `targetTimelineWeeks` |
| 11 | 目标动力 | `motivation`, `motivationDetail` |
| 12 | 邮箱 | `email` |

用户完成测试后，系统会先展示 BMI 和基础状态，不直接展示完整训练计划。用户需要进入订阅/支付页面选择方案后，才能继续查看后续内容。

---

## 订阅与权限规则

当前权限逻辑：

| 用户状态 | 可访问内容 |
|---|---|
| 未订阅用户 | 只能查看 BMI、基础健康状态和付费提示 |
| 免费试用用户 | 可查看 2 天训练计划预览 |
| 付费订阅用户 | 可查看完整结果、7 天训练计划、完整视频内容 |
| 取消订阅用户 | 到期前仍可访问，到期后恢复限制 |
| 过期用户 | 只能看到限制内容和续费提示 |

订阅方案包括：

- Free trial
- Weekly
- Monthly
- Yearly

免费试用不需要真实付款确认；付费方案会通过 mock checkout 页面模拟支付成功。

---

## Mock 支付

项目内置 mock 支付流程，用于演示订阅解锁逻辑。

接口：

```http
POST /api/pay
```

示例请求：

```json
{
  "sessionId": "session_id",
  "plan": "monthly"
}
```

支持的 plan：

```text
trial
weekly
monthly
yearly
```

注意：当前支付不是 Stripe 或真实支付，只用于项目演示。如果上线真实产品，需要接入 Stripe Checkout 和 webhook 校验。

---

## 视频权限

项目包含视频数据结构。视频内容分为：

- 免费预览视频
- 订阅用户专属视频

免费用户只能访问部分公开视频；订阅用户可以访问完整视频库。

接口：

```http
GET /api/videos/:sessionId
```

---

## API 简介

### 创建问卷会话

```http
POST /api/sessions
```

创建 session，并写入 HttpOnly cookie。

### 获取会话

```http
GET /api/sessions/:id
```

用于刷新页面后恢复问卷进度。

### 保存单步问卷

```http
PUT /api/sessions/:id/steps
```

示例：

```json
{
  "step": 6,
  "data": {
    "heightCm": 175,
    "weightKg": 80
  }
}
```

### 计算结果

```http
POST /api/sessions/:id/calculate
```

完成问卷后生成健康评估结果。

### 获取结果

```http
GET /api/results/:sessionId
```

根据用户订阅状态返回限制版或完整版结果。

### 获取训练计划

```http
GET /api/plan/:sessionId
```

免费试用返回 2 天预览，付费用户返回完整 7 天计划。

### 主动取消订阅

```http
POST /api/subscription/cancel
```

用户可以主动取消订阅。

---

## 数据库结构

核心数据表：

| 表 | 作用 |
|---|---|
| `Session` | 保存问卷会话、当前步骤、问卷答案、访问 token |
| `User` | 保存用户邮箱 |
| `Subscription` | 保存订阅状态、方案、试用时间、过期时间 |
| `HealthResult` | 保存 BMI、热量、宏量营养、目标日期、体重趋势 |
| `Video` | 保存视频内容和访问权限 |

权限判断主要依赖：

- `Subscription.status`
- `Subscription.plan`
- `Subscription.trialEndsAt`
- `Subscription.expiresAt`

常见状态：

```text
TRIAL
TRIAL_EXPIRED
ACTIVE
EXPIRED
CANCELLED
```

---

## 健康计算逻辑

### BMI

```text
BMI = weightKg / (heightM * heightM)
```

### BMR

使用 Mifflin-St Jeor 公式：

```text
男性：BMR = 10 * 体重kg + 6.25 * 身高cm - 5 * 年龄 + 5
女性：BMR = 10 * 体重kg + 6.25 * 身高cm - 5 * 年龄 - 161
```

### TDEE

```text
TDEE = BMR * 活动系数
```

### 目标热量

| 目标 | 处理方式 |
|---|---|
| 减重 | 每日热量赤字 |
| 塑形 | 小幅赤字或维持 |
| 增肌 | 小幅热量盈余 |
| 改善健康 | 维持热量 |

系统会根据当前体重、目标体重和目标周期生成体重趋势预测。

---

## 测试

运行单元测试：

```powershell
npm run test
```

只运行核心单元测试：

```powershell
node .\node_modules\jest\bin\jest.js validation.test.ts health-calculator.test.ts --runInBand
```

当前核心测试覆盖：

- 问卷字段校验
- BMI/BMR/TDEE 计算
- 目标体重周期计算
- 宏量营养计算
- 免费/付费权限逻辑

集成测试需要可连接的 PostgreSQL 数据库。如果本地连接 Render PostgreSQL 失败，需要先确认 Render 数据库状态、防火墙和连接 URL。

---

## 当前限制

| 限制 | 说明 |
|---|---|
| 支付是 mock | 目前没有接入真实 Stripe |
| 邮箱未验证 | 当前只是保存邮箱，没有邮件验证码 |
| 视频是数据权限演示 | 视频资源可以继续扩展成真实 CDN 链接 |
| 数据库依赖外部服务 | 本地集成测试需要 PostgreSQL 可访问 |
| 医疗建议有限 | 当前仅用于健康计划演示，不替代医生建议 |

---

## 提交与部署流程

日常开发建议：

```powershell
git status
git add -A
git commit -m "你的提交说明"
git push
```

push 后 Vercel 会自动部署。如果没有自动部署，可以在 Vercel 后台：

```text
Deployments -> Redeploy
```

---

## 免责声明

HealthPath 当前是笔试/演示项目。健康评估、训练建议和饮食建议仅供参考，不构成医疗诊断或治疗建议。如果用户存在疾病、受伤、怀孕、严重肥胖或其他健康风险，应咨询专业医生或营养师。
