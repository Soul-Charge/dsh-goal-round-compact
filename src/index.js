// dsh-goal-round-compact — 在 goal 模式的每个轮次边界压缩会话历史。
//
// 存在的原因：DSH 自动压缩的阈值是 floor(模型 contextWindow × 0.8)。
// workbuddy-subscription/deepseek-v4.1-flash 的 contextWindow 是 1,000,000，
// 阈值便是 800k —— 长任务在触线之前，上下文早已涨到几十万 token，
// 模型注意力被稀释，表现为「越跑越不靠谱」。本插件把压缩提前到轮次边界。
//
// ── 为什么挂在 agent/pre-step ───────────────────────────────────────────
// 备选都被源码否掉了：
//   * agent/status→idle：goal-round-driver 在同一同步 tick 内就完成
//     followup()→wakeDriver()→setPhase(running)，事件按注册顺序派发，
//     本插件永远看到 'running'，条件不成立。
//   * goal/changed：只在 create/edit/pause/resume/complete/block 时发射；
//     轮次推进由 session event fold 更新 roundsStarted，不发 goal/changed。
// agent/pre-step 是 waterfall，且 dsh-compaction-basic 自己也挂在这里做自动
// 压缩 —— 这是官方认可的压缩时机。它在每个 step 前触发，是唯一能安全压缩的点。
//
// ── 为什么用 compactRegion 而不是 compactNow ────────────────────────────
// compactNow 内部以 retainTokens=0 调 selectCompactableRange，按该函数的循环
// 语义只保留最后 1 个 surface 节点，等于把整个历史压成一条摘要 —— 对长任务
// 过于激进，会丢掉刚做过的步骤细节。compactRegion 允许自己按 token 预算挑保留
// 尾部，并复用官方 toolPairingBalancedBefore 保证不切断 tool-call/result 配对
// （切断会让 compactRegion 直接抛错，并破坏回放校验）。
//
// ── 压缩节奏 ────────────────────────────────────────────────────────────
// 门控用 token 水位而不是轮次计数：达到 minTokensBeforeCompact 才压，压完
// 记录「已压水位」，之后要再增长 minGrowthTokens 才压第二次。这样上下文在
// retainTokens ~ minTokensBeforeCompact 之间震荡，不会随轮次无限累积，也不会
// 在同一个边界反复压缩浪费模型调用。
//
// ── 设置与按模型覆盖 ─────────────────────────────────────────────────────
// 五个预算既可以写在 cordis.patch.yml（组合层），也可以在「设置 → 插件 →
// 插件配置」里改（用户层，写入 $DSH_HOME/settings.yaml 的同名块）。两层由
// dsh-settings 折叠，applies 默认 'live'，因此每一步都重新读：在设置页改完
// 立刻生效，不需要重启宿主。
//
// modelPolicies 是 host 侧的配置能力（首版 UI 不渲染它）。匹配语义照抄
// dsh-compaction-basic：精确 (provider, model) 二元组、=== 严格相等、find()
// 取首个命中、未命中逐字段回落全局值。**不支持通配** —— 一个写成 'deepseek*'
// 的 model 永远不会命中，只会静默失效。
//
// 零 token 红线：本文件不注册任何模型可见的工具、提示词段或工具目录项。
// 预算只影响何时把历史压短，不改变请求的可见内容。

import z from '@deepseek-ai/schemastery'
import { toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import { DEFAULT_SETTINGS, installSettings, settingsEntry } from './settings.js'

export const name = 'goal-round-compact'

// 只注入宿主平面确实提供的服务。compaction 与 tokenMeter 故意不注入：
//   * compaction：web profile 下 dsh-web-app 把宿主 compaction-basic 置为
//     disabled，各 preset 在隔离 realm 里各挂一份 —— 宿主注入会永远挂起。
//     改为按 agent 从 agent.ctx 解析，取不到就安静跳过。
//   * tokenMeter：不注入可让本插件在缺失该服务的组合下仍然加载（只是不作为），
//     避免一个可选依赖把整个插件挂死在 pending。
//
// 'settings' 同样**不在**这里，而且是刻意的：cordis 的静态 inject 是硬依赖
// （cordis/src/registry.ts:105-106「Services the plugin requires; it only loads
// while all are available」；cordis/src/fiber.ts:611-637 缺任一服务即停在
// PENDING，apply() 根本不执行）。把它写进静态 inject 会让本插件在没有
// dsh-settings 的 profile 上彻底不加载。设置服务因此走 installSettings() 内部
// 的 ctx.inject(['settings'], …) —— 那才是可选注入；缺失时静默回落到组合层。
export const inject = ['goals']

// 组合层 schema。默认值一律取自 src/settings.js 的 DEFAULT_SETTINGS，不在此处
// 重复字面量（cordis.patch.yml 里的数字是它的镜像，由验证脚本对齐）。
// schemastery 3.18.2 没有 .optional()：属性默认就是可选的，只有 .required()
// 会把 meta.required 置真（schemastery/src/index.ts:157,376,475）。所以下面
// 四个预算字段"不写后缀"就是可选，写 .optional() 会直接抛
// TypeError: z.number(...).optional is not a function。
const modelPolicyConfig = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  minTokensBeforeCompact: z.number(),
  retainTokens: z.number(),
  minGrowthTokens: z.number(),
  maxCompactionsPerGoal: z.number(),
})

export const Config = z.object({
  /** false = 完全不加载，不注册任何监听。 */
  enabled: z.boolean().default(DEFAULT_SETTINGS.enabled),
  /** 绝对下限：低于此总量不压缩，起步阶段压缩只会白烧一次模型调用。 */
  minTokensBeforeCompact: z.number().default(DEFAULT_SETTINGS.minTokensBeforeCompact),
  /**
   * 期望逐字保留的近期尾部预算（token）。
   *
   * **这是绝对 token 数，不随模型 contextWindow 缩放。** 小窗模型上照搬这组
   * 数字会让保留预算超过触发阈值（dsh-compaction-basic 在这种情况下直接抛
   * TargetPressureConfigError）。换模型请配 modelPolicies 覆盖。
   */
  retainTokens: z.number().default(DEFAULT_SETTINGS.retainTokens),
  /** 上次压缩后至少再增长这么多 token，才允许压第二次。 */
  minGrowthTokens: z.number().default(DEFAULT_SETTINGS.minGrowthTokens),
  /** 同一 goal 内最多压缩几次，防止异常情况下反复触发。 */
  maxCompactionsPerGoal: z.number().default(DEFAULT_SETTINGS.maxCompactionsPerGoal),
  /** 精确 (provider, model) 覆盖表；每项除二元组外均可选，缺省回落全局。 */
  modelPolicies: z.array(modelPolicyConfig),
})

const states = new WeakMap()

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

function stateFor(agent) {
  let state = states.get(agent)
  if (state !== undefined) return state
  state = { compacting: false, compactions: 0, goalId: undefined, nextCompactAt: 0 }
  states.set(agent, state)
  return state
}

/**
 * 从该 agent 自己的 scope 解析压缩服务。
 *
 * agent 既是事件主体也是 scope key（dsh-scope: scopeTarget(agent, agent)），
 * agent.ctx.get('compaction') 命中的正是本会话 preset 挂载的那一份，
 * 而不是已被 web-app 禁用的宿主那份。
 */
function compactionFor(agent) {
  try {
    const scoped = agent.ctx
    return scoped !== null && typeof scoped === 'object' && typeof scoped.get === 'function'
      ? scoped.get('compaction')
      : undefined
  } catch {
    return undefined
  }
}

/**
 * 解析最近一次请求**实际路由到的** provider/model。
 *
 * 照抄 dsh-compaction-basic/lib/index.js:713-721。agent.options 是创建时的
 * 「原始意图」，会话中途换过模型之后它是过期值，所以优先读请求头。
 *
 * 唯一的偏离：官方直接取 config.provider.length，本实现多一层 typeof 判空。
 * 理由是我们从 pre-step 的 waterfall 里调用它，异常会被 catch 成「本步跳过」，
 * 一个非预期形状的 header 不该让整个插件静默失效。
 */
function routedTarget(session) {
  if (session === null || typeof session !== 'object' || typeof session.requestHeader !== 'function') return undefined
  const config = session.requestHeader()?.config
  if (config === null || typeof config !== 'object') return undefined
  const { provider, model } = config
  if (typeof provider !== 'string' || provider.length === 0) return undefined
  if (typeof model !== 'string' || model.length === 0) return undefined
  return { provider, model }
}

/** 选覆盖表用的会话目标：先看实际路由，再回退到创建时的意图。 */
function conversationTarget(agent) {
  if (agent === null || typeof agent !== 'object') return undefined
  const routed = routedTarget(agent.session)
  if (routed !== undefined) return routed
  const options = agent.options
  if (options === null || typeof options !== 'object') return undefined
  const { provider, model } = options
  if (typeof provider !== 'string' || provider.length === 0) return undefined
  if (typeof model !== 'string' || model.length === 0) return undefined
  return { provider, model }
}

/**
 * 把精确 (provider, model) 覆盖合并到全局设置上。
 *
 * 照抄 dsh-compaction-basic/lib/index.js:85-101 的 resolveTargetPolicy：
 *   * 严格相等匹配（===），不做通配、不做前缀匹配；
 *   * find() 取首个命中；
 *   * 逐字段回落 —— override?.X ?? 全局 X，一个字段缺失只回落该字段。
 *
 * 取不到路由目标（首次请求前、header 形状异常）时**直接用全局值**，绝不因为
 * 拿不到目标就跳过压缩：那会让刚起步的长任务丢掉唯一一道上下文保险。
 */
function resolveTargetPolicy(settings, target) {
  const policies = Array.isArray(settings.modelPolicies) ? settings.modelPolicies : []
  const override = target === undefined
    ? undefined
    : policies.find((policy) => policy.provider === target.provider && policy.model === target.model)
  return {
    enabled: settings.enabled,
    minTokensBeforeCompact: override?.minTokensBeforeCompact ?? settings.minTokensBeforeCompact,
    retainTokens: override?.retainTokens ?? settings.retainTokens,
    minGrowthTokens: override?.minGrowthTokens ?? settings.minGrowthTokens,
    maxCompactionsPerGoal: override?.maxCompactionsPerGoal ?? settings.maxCompactionsPerGoal,
  }
}

/** 从尾部累加，返回「应当保留的起点索引」——即需要被压掉的前缀是 [0, 该索引)。 */
function retainFrom(nodes, reserveTokens) {
  let accumulated = 0
  let keepFromIdx = nodes.length
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    accumulated += nodes[index].tokens
    keepFromIdx = index
    if (accumulated >= reserveTokens) break
  }
  return keepFromIdx
}

/**
 * 试做一次压缩。返回是否真的压了。
 *
 * 独立成普通 async 函数（不是 waterfall 监听器）的好处：这里可以随意 return，
 * 不必在每个分支上记得调用 next()，少一类容易写错的错误。
 *
 * settings 是**全局**设置；本会话生效的预算由其中的 modelPolicies 按当前
 * 路由目标逐字段覆盖后得到（policy），下面所有判断都用 policy。
 */
async function compactIfDue(ctx, agent, goal, settings) {
  const state = stateFor(agent)
  const policy = resolveTargetPolicy(settings, conversationTarget(agent))
  if (state.compacting) return false
  if (state.compactions >= policy.maxCompactionsPerGoal) return false

  // 换 goal 就重置预算：新目标应重新拥有完整压缩额度。
  if (state.goalId !== goal.id) {
    state.goalId = goal.id
    state.compactions = 0
    state.nextCompactAt = 0
  }

  const compaction = compactionFor(agent)
  if (compaction === undefined || typeof compaction.compactRegion !== 'function') return false

  const meter = ctx.get('tokenMeter')
  if (meter === undefined || typeof meter.measure !== 'function') return false

  state.compacting = true
  try {
    const measurement = meter.measure(agent.session)
    if (measurement.totalTokens < policy.minTokensBeforeCompact) return false
    if (measurement.totalTokens < state.nextCompactAt) return false

    const surface = agent.session.surface.nodes
    const priced = measurement.nodes
    // 定价节点必须与当前 surface 逐一对应，否则 range 会指错事件。
    if (priced.length !== surface.length) return false

    let keepFromIdx = retainFrom(priced, policy.retainTokens)
    // 系统提示词位于 surface 第一个节点时永不纳入压缩范围。
    const startIdx = surface.length > 0 && agent.session.eventAt(surface[0])?.type === 'system/message' ? 1 : 0
    // 逐格回退到最近的 tool-pairing 平衡点，绝不切断一个 step 的调用/结果配对。
    while (keepFromIdx > startIdx) {
      if (toolPairingBalancedBefore(agent.session, surface[keepFromIdx])) break
      keepFromIdx -= 1
    }
    if (keepFromIdx <= startIdx) return false

    const result = await compaction.compactRegion(surface[startIdx], surface[keepFromIdx - 1], agent)
    state.compactions += 1
    // 压缩后重新测量，以此为基准设定下一次的门槛。
    const after = meter.measure(agent.session).totalTokens
    state.nextCompactAt = Math.max(policy.minTokensBeforeCompact, after) + policy.minGrowthTokens
    ctx.logger.info(
      `goal-round-compact: compacted ${result.shadowedSeqs.length} surface nodes for agent "${agent.id}" ` +
      `(seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, ~${result.shadowedTokenCount} tokens; ` +
      `${measurement.totalTokens} → ${after} tokens) on goal ${goal.id} round ${goal.roundsStarted}`
    )
    return true
  } catch (error) {
    // busy / cancelled / surface-changed 都是可预期分支：goal 续行永远优先。
    ctx.logger.warn(`goal-round-compact: skipped for agent "${agent.id}" on goal ${goal.id}: ${describe(error)}`)
    return false
  } finally {
    state.compacting = false
  }
}

export function apply(ctx, config) {
  const entry = settingsEntry(config)

  // 先装设置命名空间，再看 enabled。顺序反了的话，组合层 enabled:false 的
  // 插件在设置页里根本没有卡片，用户将永远无法把它重新打开。
  const readSettings = installSettings(ctx, entry, (operation, namespace, error) => {
    ctx.logger.warn(`goal-round-compact: ${operation} failed for "${namespace}": ${describe(error)}`)
  })

  if (entry.enabled !== true) {
    ctx.logger.info('goal-round-compact: disabled by config; no listener registered')
    return
  }

  ctx.effect(function* () {
    yield ctx.on('agent/session-start', ({ agent }) => {
      const state = stateFor(agent)
      state.compacting = false
      state.compactions = 0
      state.goalId = undefined
      state.nextCompactAt = 0
    })

    // waterfall：无论走哪条分支都必须 next() 放行，否则会截断后续监听者
    // （包括 dsh-compaction-basic 自己的自动压缩）。压缩放在 next() 之前，
    // 让本步在压缩后的历史上执行 —— 与官方实现的顺序一致。
    yield ctx.on('agent/pre-step', async ({ agent }, next) => {
      try {
        // 每步重读：设置页的改动 applies:'live'，不重启即时生效。
        const settings = readSettings()
        // 只对活跃 goal 生效：普通会话完全不受本插件影响。
        // enabled 是用户层可改的，所以这一层判断必须留在运行时。
        if (settings.enabled === true) {
          const goal = ctx.goals.get(agent)
          if (goal !== undefined && goal.phase === 'active') {
            await compactIfDue(ctx, agent, goal, settings)
          }
        }
      } catch (error) {
        // 任何意外都不得阻断当前 step。
        ctx.logger.warn(`goal-round-compact: pre-step hook failed for agent "${agent.id}": ${describe(error)}`)
      }
      return next()
    })
  })
}

export default { name, inject, Config, apply }
