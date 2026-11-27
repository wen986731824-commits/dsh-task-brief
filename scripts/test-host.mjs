/**
 * Local wiring test for the dsh-task-brief Host half, without a live Harness:
 * a stub context records what apply() registers and then invokes it.
 * Run: node scripts/test-host.mjs
 */
import { apply } from '../index.js'

const listeners = new Map()
const effects = []
const sections = []
const calls = { listProviders: 0, listModels: 0, resolveModelInfo: 0 }

const fakeLlm = {
  async listProviders() {
    calls.listProviders += 1
    return [{ id: 'xdpool', name: 'Xdpool' }, { id: 'tokenbank', name: 'TokenBank' }]
  },
  async listModels(provider) {
    calls.listModels += 1
    return provider === 'xdpool'
      ? [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }]
      : [{ id: 'glm-5.4', name: 'GLM 5.4' }]
  },
  async resolveModelInfo(provider, model) {
    calls.resolveModelInfo += 1
    return {
      provider,
      id: model,
      name: model,
      context: { contextWindow: 1000000 },
      reasoning: { efforts: [{ id: 'low' }, { id: 'high' }, { id: 'max' }] },
    }
  },
}

const services = {
  llm: fakeLlm,
  agentDefaultModel: {
    currentSelection: () => ({ provider: 'xdpool', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' }),
  },
}

const ctx = {
  logger: { warn: (...args) => console.log('WARN', ...args) },
  get: (name) => services[name],
  on(name, handler) {
    const list = listeners.get(name) ?? []
    list.push(handler)
    listeners.set(name, list)
    return () => {}
  },
  effect(factory, label) {
    const dispose = factory()
    effects.push({ label, dispose })
    return () => {}
  },
}

apply(ctx, {})

const createdHandlers = listeners.get('agent/created') ?? []
if (createdHandlers.length !== 1) throw new Error(`expected 1 agent/created listener, got ${createdHandlers.length}`)

const eventHandlers = listeners.get('session/event') ?? []
if (eventHandlers.length !== 1) throw new Error(`expected 1 session/event listener, got ${eventHandlers.length}`)

function makeAgent({ complete }) {
  const events = complete ? [{ type: 'turn/start' }, { type: 'turn/end' }] : []
  const session = {
    surface: { nodes: events.map((_, index) => index) },
    eventAt: (seq) => events[seq],
  }
  const agent = {
    id: 'agent',
    session,
    ctx: {
      systemPrompt: {
        section(section) {
          sections.push(section)
          return () => {}
        },
      },
    },
  }
  return { agent, session }
}

const fresh = makeAgent({ complete: false })
await createdHandlers[0]({ agent: fresh.agent, source: 'startup' })

if (sections.length !== 1) throw new Error(`expected 1 registered section, got ${sections.length}`)
const section = sections[0]
if (section.name !== 'task-brief:protocol') throw new Error(`unexpected section name ${section.name}`)

// Wait past the debounce so the catalog refresh settles into the text.
await new Promise((resolve) => setTimeout(resolve, 900))

const text = section.text()
const mustContain = [
  '任务简报',
  '类型',
  '难度',
  '关键要求',
  '工作量',
  'Token 估算',
  '时间估算',
  '推荐配置',
  '推荐理由',
  'xdpool/deepseek-v4.1-flash',
  '思考 low/high/max',
  '当前会话配置',
]
for (const needle of mustContain) {
  if (!text.includes(needle)) throw new Error(`protocol text is missing: ${needle}`)
}
if (calls.listProviders < 1 || calls.listModels < 2) {
  throw new Error(`catalog was not built: ${JSON.stringify(calls)}`)
}

// A Session that already completed a turn never registers the section.
const used = makeAgent({ complete: true })
await createdHandlers[0]({ agent: used.agent, source: 'resume' })
if (sections.length !== 1) throw new Error('a completed Session must not register the section')

// Completing a turn turns the already-registered text off.
eventHandlers[0](fresh.session, { type: 'turn/end' })
if (section.text() !== '') throw new Error('the section text must go empty after the first turn ends')

// Plugin unload disposes the effect and the owned sections.
for (const { dispose } of effects) if (typeof dispose === 'function') dispose()

console.log('OK — protocol length', text.length, 'catalog calls', JSON.stringify(calls))
