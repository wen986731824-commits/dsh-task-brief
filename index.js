/**
 * dsh-task-brief — Host half.
 *
 * Injects the first-turn "task brief" protocol into each Agent's own scoped
 * system prompt, together with a live catalog of the models and reasoning
 * efforts this Harness can actually route to.
 *
 * The protocol removes itself as soon as the Session has completed a turn, so
 * resumed Sessions, forks with history, and every later task stay quiet.
 *
 * @module dsh-task-brief
 */

/** Tunables; the row's `config` in cordis.patch.yml overrides any of them. */
const DEFAULT_OPTIONS = {
  enabled: true,
  includeModelCatalog: true,
  maxCatalogModels: 24,
  catalogTimeoutMs: 12000,
}

/** Scoped section identity. Unique per Agent scope. */
const SECTION_NAME = 'task-brief:protocol'
/** Between the deployment persona (0) and the plan policy (500). */
const SECTION_ORDER = 100

const CATALOG_REFRESH_DEBOUNCE_MS = 500

/** The protocol prose, independent of the live model catalog. */
const PROTOCOL = [
  '## 任务简报（本会话首轮）',
  '',
  '本会话还没有完成任何一轮对话。在开始实质工作之前，先用一条消息给出《任务简报》，让用户一眼看清你打算做什么、要花多少资源。简报之后直接继续执行，不必等待确认——除非任务涉及删除、覆盖或改动系统配置等高危操作，那时先问。',
  '',
  '### 什么时候跳过',
  '',
  '任务的实质只是一句寒暄、一句能直接答完的问答、或纯粹的澄清反问时，**跳过简报**，直接回答。判断标准是「用户会不会因为多这一屏而觉得啰嗦」。',
  '',
  '### 格式',
  '',
  '以 `## 任务简报` 开头，紧接一张两列表格（列名为「项目」「内容」），按顺序填满以下字段：',
  '',
  '1. **任务** — 一句话复述用户真正要交付的东西，不要照抄原句。',
  '2. **类型** — 从「代码实现 / 重构 / 排错 / 调研 / 文档 / 数据处理 / 界面美化 / 系统配置 / 混合任务」中选 1–2 个。',
  '3. **难度** — ★ 到 ★★★★★，后附一句话说明难点具体在哪一环。',
  '4. **关键要求** — 用户明确或隐含的硬约束：格式、路径、语言、验收标准、禁止事项。没有就写「无额外硬约束」。',
  '5. **工作量** — 预计产出或改动的文件数、工具调用轮次、是否需要联网或长任务。',
  '6. **Token 估算** — 输入 ≈ N、输出 ≈ N、合计 ≈ N。给区间并标注为估算。',
  '7. **时间估算** — 预计执行时长区间。',
  '8. **推荐配置** — `provider/model · 思考等级: X`；若当前配置已经合适，写「保持当前配置」并给出当前值。',
  '9. **推荐理由** — 一两句，说明「够用」或「必要」的判据；如果升级收益不大就明说。',
  '',
  '表格之后用一句话收尾，三选一：`按推荐继续` / `当前配置即可，直接开始` / `建议先切到 X 再继续（我不会自动切换）`。',
  '',
  '### 估算基准',
  '',
  '以下只是量级参考，不要当成精确值，也不要把参考区间当成实测结论：',
  '',
  '- 中文正文 ≈ 0.6–0.8 token/汉字；代码与英文 ≈ 0.25–0.3 token/字符。',
  '- 读一个文件 ≈ 文件字节数 ÷ 3.5 的输入 token。',
  '- 一次工具调用往返（含结果）≈ 300–3000 token。',
  '- 经验区间：单文件小修 ≈ 8k–25k 总 token；跨 5–10 个文件的改造 ≈ 60k–200k；含联网调研再加 20k–60k。',
  '- 时间：单次工具调用 ≈ 3–20 秒；一次模型回合（含思考）≈ 15–90 秒。小修 2–5 分钟、中等改造 8–20 分钟、多阶段任务 30 分钟以上。',
  '',
  '### 选模型的判据',
  '',
  '- 只需改写、格式转换、单文件小改 → 快模型 + 低思考（off / low）。',
  '- 常规实现、多文件编辑、按明确规格执行 → 中档模型 + 中思考（high）。',
  '- 跨模块推理、疑难排错、架构设计、长链路自主执行、错了返工代价高 → 目录里最强的模型 + max。',
  '- 判据优先级：是否需要长上下文保持 > 是否需要多步自主决策 > 返工代价。',
  '- **只推荐，不自动切换。** 用户没换模型时，就用当前配置尽力执行；如果因此明显受限，在收尾时说明。',
].join('\n')

/**
 * Register the scoped protocol section on every Agent, plus the live catalog it
 * quotes.
 * @param ctx - the plugin's Host context.
 * @param config - the row's config; every key is optional.
 */
export function apply(ctx, config) {
  const options = { ...DEFAULT_OPTIONS, ...(config ?? {}) }
  if (!options.enabled) return

  /** Formatted catalog lines; empty until the first successful refresh. */
  let catalogText = ''
  let refreshing = null
  let refreshTimer = null

  const formatWindow = (tokens) => {
    if (!Number.isFinite(tokens) || tokens <= 0) return ''
    if (tokens >= 1000000) return `${Math.round(tokens / 100000) / 10}M`
    if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`
    return String(tokens)
  }

  const buildCatalog = async () => {
    const llm = ctx.get('llm')
    if (!llm || typeof llm.listProviders !== 'function') return ''
    let providers = []
    try {
      providers = await llm.listProviders()
    } catch (error) {
      ctx.logger?.warn?.('task-brief: listProviders failed: %o', error)
      return ''
    }
    if (!Array.isArray(providers)) return ''
    const lines = []
    let count = 0
    for (const provider of providers) {
      if (count >= options.maxCatalogModels) break
      const providerId = provider?.id
      if (typeof providerId !== 'string' || providerId.length === 0) continue
      let models = []
      try {
        models = await llm.listModels(providerId)
      } catch {
        continue
      }
      if (!Array.isArray(models)) continue
      for (const model of models) {
        if (count >= options.maxCatalogModels) break
        const modelId = model?.id
        if (typeof modelId !== 'string' || modelId.length === 0) continue
        let info
        try {
          info = typeof llm.resolveModelInfo === 'function'
            ? await llm.resolveModelInfo(providerId, modelId)
            : undefined
        } catch {
          info = undefined
        }
        const traits = []
        const window = formatWindow(info?.context?.contextWindow)
        if (window) traits.push(`上下文 ${window}`)
        const efforts = Array.isArray(info?.reasoning?.efforts)
          ? info.reasoning.efforts.map((effort) => effort?.id).filter((id) => typeof id === 'string' && id.length > 0)
          : []
        traits.push(efforts.length > 0 ? `思考 ${efforts.join('/')}` : '无思考等级')
        const label = info?.name && info.name !== modelId ? `${modelId}（${info.name}）` : modelId
        lines.push(`- \`${providerId}/${label}\` · ${traits.join(' · ')}`)
        count += 1
      }
    }
    return lines.join('\n')
  }

  const withDeadline = (promise, ms) => new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve('')
    }, ms)
    timer.unref?.()
    promise.then((value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(typeof value === 'string' ? value : '')
    }, () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve('')
    })
  })

  const refresh = () => {
    if (refreshing !== null) return refreshing
    refreshing = withDeadline(buildCatalog(), options.catalogTimeoutMs)
      .then((text) => {
        if (typeof text === 'string' && text.length > 0) catalogText = text
      })
      .catch((error) => {
        ctx.logger?.warn?.('task-brief: model catalog refresh failed: %o', error)
      })
      .then(() => {
        refreshing = null
      })
    return refreshing
  }

  const queueRefresh = () => {
    if (refreshTimer !== null) return
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      void refresh()
    }, CATALOG_REFRESH_DEBOUNCE_MS)
    refreshTimer.unref?.()
  }

  const currentSelection = () => {
    try {
      const service = ctx.get('agentDefaultModel')
      const selection = service?.currentSelection?.()
      return selection && typeof selection === 'object' ? selection : undefined
    } catch {
      return undefined
    }
  }

  let memoKey = ''
  let memoText = ''

  const buildProtocol = () => {
    const sections = [PROTOCOL, '']

    if (options.includeModelCatalog) {
      sections.push('### 可用模型（本次运行的实际目录）', '')
      sections.push(catalogText.length > 0
        ? catalogText
        : '（目录尚未就绪：先按通用能力推荐，并在简报里注明「模型目录暂不可用」。）')
      sections.push('')
    }

    const selection = currentSelection()
    if (selection && typeof selection.provider === 'string' && typeof selection.model === 'string') {
      sections.push('### 当前会话配置', '')
      sections.push(`- 默认：\`${selection.provider}/${selection.model}\``)
      if (typeof selection.reasoningEffort === 'string' && selection.reasoningEffort.length > 0) {
        sections.push(`- 思考等级：${selection.reasoningEffort}`)
      } else {
        sections.push('- 思考等级：未显式设置（使用适配器默认）')
      }
      sections.push('')
      sections.push('推荐时优先与当前配置比较：只有在确实需要更强能力时才建议切换，并说明理由。')
    } else {
      sections.push('### 当前会话配置', '', '- 无法读取当前默认模型；请只推荐上面目录中存在的组合。')
    }

    return sections.join('\n')
  }

  const protocolFor = () => {
    const key = `${options.includeModelCatalog ? 1 : 0}\u0000${catalogText}\u0000${JSON.stringify(currentSelection() ?? null)}`
    if (memoKey !== key) {
      memoKey = key
      memoText = buildProtocol()
    }
    return memoText
  }

  const hasCompletedTurn = (session) => {
    const nodes = session?.surface?.nodes
    if (!Array.isArray(nodes) || typeof session.eventAt !== 'function') return false
    for (let index = 0; index < nodes.length; index += 1) {
      const event = session.eventAt(nodes[index])
      if (event?.type === 'turn/end') return true
    }
    return false
  }

  /** Sessions known to be past their first turn; they never see the protocol again. */
  const completed = new WeakSet()

  ctx.on('session/event', (session, event) => {
    if (event?.type === 'turn/end' && session !== undefined) completed.add(session)
  })

  /** agent → its own section disposer, so plugin unload can also unwind them. */
  const owned = new Map()

  ctx.on('agent/created', ({ agent }) => {
    const prompt = agent?.ctx?.systemPrompt
    if (prompt === undefined || typeof prompt.section !== 'function') return undefined
    const session = agent.session
    if (session === undefined) return undefined
    if (completed.has(session) || hasCompletedTurn(session)) {
      completed.add(session)
      return undefined
    }
    const dispose = prompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      text: () => {
        if (completed.has(session)) return ''
        if (hasCompletedTurn(session)) {
          completed.add(session)
          return ''
        }
        return protocolFor()
      },
      interpolate: false,
    })
    owned.set(agent, dispose)
    return undefined
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const dispose = owned.get(agent)
    if (dispose === undefined) return
    owned.delete(agent)
    try {
      dispose()
    } catch {
      // The Agent scope may already have unwound its registrations.
    }
  })

  ctx.effect(() => {
    void refresh()
    return () => {
      if (refreshTimer !== null) {
        clearTimeout(refreshTimer)
        refreshTimer = null
      }
      for (const dispose of owned.values()) {
        try {
          dispose()
        } catch {
          // Already disposed with its Agent scope.
        }
      }
      owned.clear()
    }
  }, 'task-brief.lifecycle')

  ctx.on('llm/adapters-updated', queueRefresh)
  ctx.on('llm/models-updated', queueRefresh)
}
