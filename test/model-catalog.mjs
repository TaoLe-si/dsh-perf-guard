import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DISCOVERY_TOOL, modelCatalogMiddleware } from '../model-catalog.js'

const success = (value) => ({ isError: false, value, content: [{ type: 'text', text: value }] })
const failure = (message, info) => ({ isError: true, error: { message, ...(info ? { info } : {}) }, content: [] })

function fixture({ providers = { first: ['alpha', 'shared'], second: ['shared', 'org/beta'] }, policy = null } = {}) {
  const queried = []
  const definition = {
    description: 'Inspect the routes available for explicit subagent model selection. No arguments: authorized providers.',
    output: { schema: { type: 'string' } },
  }
  const agent = {
    session: { requestHeader: () => ({ config: { provider: 'first', model: 'alpha' } }) },
    options: { provider: 'second', model: 'shared' },
    ctx: { get: key => services[key] },
  }
  const services = {
    llm: {
      listProviders: () => Object.keys(providers).map(id => ({ id, baseURL: 'private endpoint' })),
      async listModels(provider) {
        queried.push(provider)
        const ids = providers[provider]
        if (ids instanceof Error) throw ids
        return ids.map(id => ({ id, description: 'not copied from provider metadata' }))
      },
    },
    sessionProjections: { stateOf: (session, key) => {
      assert.equal(session, agent.session)
      assert.equal(key, 'subagentModelSelectionPolicy')
      return policy
    } },
  }
  const ctx = { tools: { executable: (name, scope) => name === DISCOVERY_TOOL && scope === agent ? definition : undefined } }
  return { run: modelCatalogMiddleware(ctx), queried, services, ctx, agent, exec: { name: DISCOVERY_TOOL, agent, arguments: {} } }
}

test('one unfiltered query expands both providers and identifies the effective parent route separately', async () => {
  const f = fixture()
  let nextCalls = 0
  const result = await f.run(f.exec, async () => { nextCalls++; return success('first - First Provider') })
  assert.equal(nextCalls, 1)
  assert.deepEqual(f.queried, ['first', 'second'])
  const [catalog, policy] = result.value.split('\n\n')
  assert.match(catalog, /4 advertised models across 2 registered providers/)
  assert.match(catalog, /"first": "alpha", "shared"/)
  assert.match(catalog, /"second": "shared", "org\/beta"/)
  assert.doesNotMatch(catalog, /private endpoint|not copied/)
  assert.match(policy, /parent route only/)
  assert.match(policy, /provider="first" model="alpha"/)
  assert.doesNotMatch(policy, /provider="second"/)
})

test('empty discovery fields produce a real catalog without mutating the arguments', async () => {
  const f = fixture({ policy: [{ provider: 'second', model: 'org/beta' }, { provider: 'first', model: 'unadvertised' }] })
  const args = Object.freeze({ model: '', provider: '' })
  const result = await f.run({ ...f.exec, arguments: args }, async () => failure('`provider` must be non-empty'))
  assert.deepEqual(args, { model: '', provider: '' })
  assert.equal(result.isError, false)
  const policy = result.value.split('\n\n')[1]
  assert.match(policy, /recorded session policy/)
  assert.match(policy, /provider="second" model="org\/beta"/)
  assert.match(policy, /provider="first" model="unadvertised" \(not confirmed in the host catalog\)/)
  assert.doesNotMatch(policy, /model="alpha"/)
})

test('missing parent route does not hide the catalog or manufacture permission', async () => {
  const f = fixture()
  f.agent.session.requestHeader = () => undefined
  f.agent.options = {}
  const result = await f.run(f.exec, async () => failure('cannot discover child LLM routes without a parent provider and model'))
  assert.equal(result.isError, false)
  assert.match(result.value, /4 advertised models/)
  assert.match(result.value, /no recorded policy or effective parent route\):\n\(none\)/)
})

test('a failed provider leaves other groups intact and an unread policy remains unknown', async () => {
  const f = fixture({ providers: { broken: new Error('should not leak'), empty: [], good: ['real'] } })
  f.services.sessionProjections.stateOf = () => { throw new Error('unavailable') }
  const original = { ...success('(no LLM providers)'), additionalContexts: [{ id: 'existing' }] }
  const result = await f.run(f.exec, async () => original)
  assert.match(result.value, /1 provider reads failed; partial result/)
  assert.match(result.value, /"broken": catalog unavailable/)
  assert.match(result.value, /"empty": \(no advertised models\)/)
  assert.match(result.value, /"good": "real"/)
  assert.match(result.value, /unknown \(session policy could not be read\)/)
  assert.doesNotMatch(result.value, /should not leak|model="alpha"/)
  assert.equal(result.additionalContexts, original.additionalContexts)
})

test('an empty catalog discourages unchanged queries without erasing the recorded policy', async () => {
  const f = fixture({ providers: {}, policy: [{ provider: 'detached', model: 'old' }] })
  const result = await f.run(f.exec, async () => success('(no LLM providers)'))
  assert.match(result.value, /0 advertised models across 0 registered providers/)
  assert.match(result.value, /Do not repeat this unchanged query/)
  assert.match(result.value, /provider="detached" model="old" \(not confirmed in the host catalog\)/)
})

test('filters, native denials, cancellation and registration changes leave the original result intact', async () => {
  const f = fixture()
  const denied = failure('LLM provider "second" is not allowed for this Session')
  const invalid = failure('`provider` must be non-empty')
  for (const [exec, result] of [
    [{ ...f.exec, arguments: { provider: 'second' } }, denied],
    [{ ...f.exec, arguments: { model: 'shared', provider: '' } }, invalid],
    [{ ...f.exec, name: 'subagent' }, denied],
    [{ ...f.exec, signal: AbortSignal.abort() }, success('first')],
    [f.exec, failure('`provider` must be non-empty', { code: 'DENIED' })],
    [{ ...f.exec, arguments: { provider: '', extra: '' } }, invalid],
    [{ ...f.exec, agent: undefined }, denied],
    [f.exec, denied],
  ]) assert.equal(await f.run(exec, async () => result), result)

  const original = success('first')
  assert.equal(await f.run(f.exec, async () => { f.ctx.tools.executable = () => undefined; return original }), original)
  assert.deepEqual(f.queried, [])

  const reloaded = fixture()
  const result = await reloaded.run(reloaded.exec, async () => { delete reloaded.ctx.tools; return original })
  assert.equal(result, original)
  assert.deepEqual(reloaded.queried, [])
})
