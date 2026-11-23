export const DISCOVERY_TOOL = 'list_subagent_models'
const NATIVE_DESCRIPTION = 'Inspect the routes available for explicit subagent model selection.'
const POLICY_KEY = 'subagentModelSelectionPolicy'
const EMPTY_FILTER_ERRORS = new Set(['`provider` must be non-empty', '`model` must be non-empty', '`model` requires `provider`'])

function unfiltered(args) {
  return args !== null && typeof args === 'object' && !Array.isArray(args)
    && Object.entries(args).every(([key, value]) => (key === 'provider' || key === 'model') && value === '')
}

function childPolicy(agent) {
  let routes
  try {
    // rc.5 exposes this registered host-only projection through its keyed reader.
    routes = agent.ctx.get('sessionProjections')?.stateOf?.(agent.session, POLICY_KEY)
  } catch {
    // A directory can still be displayed, but must not imply any authorization.
  }
  if (routes === null) {
    const parent = agent.session.requestHeader?.()?.config ?? agent.options
    if (typeof parent?.provider === 'string' && parent.provider && typeof parent.model === 'string' && parent.model) {
      return { source: 'parent route only (no recorded policy)', routes: [parent] }
    }
    return { source: 'no recorded policy or effective parent route', routes: [] }
  }
  if (Array.isArray(routes) && routes.every(route => typeof route?.provider === 'string' && route.provider
    && typeof route.model === 'string' && route.model)) {
    return { source: 'recorded session policy', routes }
  }
  return { source: 'unknown (session policy could not be read)', routes: null }
}

async function readCatalog(llm, signal) {
  const providers = [...new Set(llm.listProviders().map(({ id }) => id))]
  const groups = new Map(providers.map(id => [id, null]))
  let index = 0
  await Promise.all(Array.from({ length: Math.min(4, providers.length) }, async () => {
    while (!signal?.aborted && index < providers.length) {
      const provider = providers[index++]
      try {
        const entries = await llm.listModels(provider)
        groups.set(provider, [...new Set(entries.map(({ id }) => id))])
      } catch {
        // Do not expose raw adapter errors, which can include connection details.
      }
    }
  }))
  return groups
}

function renderCatalog(groups, { source, routes }) {
  let models = 0
  let failures = 0
  const lines = []
  for (const [provider, ids] of groups) {
    const key = JSON.stringify(provider)
    if (ids === null) {
      failures++
      lines.push(`- ${key}: catalog unavailable`)
    } else {
      models += ids.length
      lines.push(`- ${key}: ${ids.length > 0 ? ids.map(id => JSON.stringify(id)).join(', ') : '(no advertised models)'}`)
    }
  }
  const heading = `Host model catalog: ${models} advertised models across ${groups.size} registered providers${failures ? ` (${failures} provider reads failed; partial result)` : ''}.`
  const permitted = routes === null ? ['Do not infer delegation permissions from the host catalog.']
    : routes.map(({ provider, model }) => {
        const advertised = groups.get(provider)?.includes(model)
        return `- provider=${JSON.stringify(provider)} model=${JSON.stringify(model)}${advertised ? '' : ' (not confirmed in the host catalog)'}`
      })
  return [heading, ...(lines.length ? lines : ['(no registered providers)']), '',
    `Session explicit child routes (${source}):`, ...(permitted.length ? permitted : ['(none)']),
    'Catalog membership does not authorize delegation. Native delegation still validates the exact route.',
    ...(models === 0 ? ['No models were returned. Do not repeat this unchanged query.'] : []),
  ].join('\n')
}

/** Expand only an admitted native directory lookup that does not select a concrete route. */
export function modelCatalogMiddleware(ctx) {
  function toolFor(exec) {
    try {
      return ctx.tools?.executable?.(DISCOVERY_TOOL, exec.agent, exec.toolSet)
    } catch {
      return undefined
    }
  }
  return async (exec, next) => {
    if (exec.name !== DISCOVERY_TOOL || !exec.agent?.ctx || !unfiltered(exec.arguments)) return next()
    const tool = toolFor(exec)
    const original = await next()
    if (!tool?.description?.startsWith(NATIVE_DESCRIPTION) || tool.output?.schema?.type !== 'string'
      || exec.signal?.aborted || toolFor(exec) !== tool) return original
    // Empty strings carry no model selection. Only the native argument error
    // (or the missing parent route for this unfiltered lookup) is recoverable.
    if (original.isError) {
      const message = original.error?.message
      const emptyFields = Object.keys(exec.arguments).length > 0 && EMPTY_FILTER_ERRORS.has(message)
      if (original.error?.info !== undefined || (!emptyFields && message !== 'cannot discover child LLM routes without a parent provider and model')) return original
    } else if (typeof original.value !== 'string') return original

    try {
      const llm = exec.agent.ctx.get('llm')
      if (typeof llm?.listProviders !== 'function' || typeof llm.listModels !== 'function') return original
      const catalog = await readCatalog(llm, exec.signal)
      if (exec.signal?.aborted || toolFor(exec) !== tool) return original
      const value = renderCatalog(catalog, childPolicy(exec.agent))
      return { isError: false, value, content: [{ type: 'text', text: value }],
        ...(original.additionalContexts === undefined ? {} : { additionalContexts: original.additionalContexts }) }
    } catch {
      // Keep the native result if the directory integration is unavailable.
      return original
    }
  }
}
